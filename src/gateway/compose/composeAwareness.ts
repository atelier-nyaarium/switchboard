// The awareness bank that rides changes out on the next channel push.

import { AGENT_NOTICE_SOURCE } from "../../shared/agent-notice.js";
import type { Ambient, IntervalHandle } from "../../shared/ambient.js";
import type { AwarenessObservation } from "../../shared/awareness-types.js";
import type { BoardEntry } from "../../shared/console-protocol.js";
import { agentTurnIdentity, createAgentAwarenessSubscriber, createAgentWatch } from "../agentAwareness.js";
import { type AwarenessBank, createAwarenessBank } from "../awarenessBank.js";
import { boardAwarenessSubscriber } from "../boardAwareness.js";
import {
	createWorkflowAwarenessSubscriber,
	createWorkflowWatch,
	type WorkflowWatch,
} from "../workflows/workflowAwareness.js";
import { type WorkspaceChange, workspaceAwarenessSubscriber } from "../workspaceAwareness.js";
import { reached, sendOn } from "../wsSend.js";
import { resolveLiveIncarnation } from "../wsTypes.js";
import type { AgentsStage } from "./composeAgents.js";
import type { HostStage } from "./composeHost.js";
import type { SessionsStage } from "./composeSessions.js";
import type { WorkflowsStage } from "./composeWorkflows.js";

export interface AwarenessStageDeps {
	sessions: Pick<SessionsStage, "registry" | "sessionStore" | "presence">;
	host: Pick<HostStage, "wakeService">;
	agents: Pick<AgentsStage, "agentRoster" | "workflowProgress" | "markTurnNotified" | "onTurnsCollected">;
	workflows: Pick<WorkflowsStage, "runner" | "engine">;
	ambient: Pick<Ambient, "now" | "randomBytes" | "setInterval">;
	workflowProgressIntervalMs?: number;
}

/** Ticks of the bank's one-second timer between agent catalog reads. */
const AGENT_WATCH_TICKS = 5;

export interface AwarenessStage {
	awareness: AwarenessBank;
	boardObserve: (observations: readonly AwarenessObservation<BoardEntry>[]) => void;
	workspaceObserve: (observations: readonly AwarenessObservation<WorkspaceChange>[]) => void;
	workflowWatch: WorkflowWatch;
	awarenessTimer: IntervalHandle;
}

export function composeAwareness({
	sessions,
	host,
	agents,
	workflows,
	ambient,
	workflowProgressIntervalMs,
}: AwarenessStageDeps): AwarenessStage {
	const awareness = createAwarenessBank({
		ambient,
		liveness: (sessionKey) => {
			const live = resolveLiveIncarnation(sessions.registry, sessions.sessionStore, sessionKey);
			if (live?.data.handshakeConfirmed) return "live";
			if (live || host.wakeService.isWakeInFlight(sessionKey)) return "waking";
			return "gone";
		},
		deliver: (sessionKey, payload) => {
			const live = resolveLiveIncarnation(sessions.registry, sessions.sessionStore, sessionKey);
			if (!live?.data.handshakeConfirmed) return false;
			return reached(sendOn(live, JSON.stringify(payload), `awareness for ${sessionKey}`));
		},
	});
	const boardObserve = awareness.register(boardAwarenessSubscriber);
	const workspaceObserve = awareness.register(workspaceAwarenessSubscriber);
	const workflowObserve = awareness.register(
		createWorkflowAwarenessSubscriber((runId) => workflows.runner.markNotified(runId)),
	);
	const workflowWatch = createWorkflowWatch({
		runner: workflows.runner,
		engine: workflows.engine,
		progressCounts: agents.workflowProgress,
		observe: workflowObserve,
		now: () => ambient.now(),
		...(workflowProgressIntervalMs === undefined ? {} : { progressEveryMs: workflowProgressIntervalMs }),
	});
	const agentWatch = createAgentWatch({
		roster: agents.agentRoster,
		observe: awareness.register(
			createAgentAwarenessSubscriber((sessionKey, family, agentId, turnId) => {
				agents.markTurnNotified(sessionKey, family, agentId, turnId);
			}),
		),
		now: () => ambient.now(),
	});
	agents.onTurnsCollected((ownerKey, family, agentId, turnIds) => {
		for (const turnId of turnIds) {
			awareness.withdraw(ownerKey, AGENT_NOTICE_SOURCE, agentTurnIdentity(family, agentId, turnId));
		}
	});
	const agentTeams = (): Set<string> =>
		new Set(
			agents
				.agentRoster()
				.filter((agent) => agent.turns.some((turn) => turn.state === "inProgress"))
				.map((agent) => agent.ownerKey),
		);
	let runningTeams = agentTeams();
	sessions.presence.setAgentsRunningReader(agentTeams);
	let ticks = 0;
	workflowWatch.tick();
	const awarenessTimer = ambient.setInterval(() => {
		try {
			if (ticks++ % AGENT_WATCH_TICKS === 0) {
				agentWatch.tick();
				const next = agentTeams();
				if (next.size !== runningTeams.size || [...next].some((team) => !runningTeams.has(team))) {
					runningTeams = next;
					sessions.presence.markDirty();
				}
			}
			workflowWatch.tick();
			awareness.tick();
		} catch (err) {
			console.error("[awareness] tick failed:", err);
		}
	}, 1_000);

	return { awareness, boardObserve, workspaceObserve, workflowWatch, awarenessTimer };
}
