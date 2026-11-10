// The awareness bank that rides changes out on the next channel push.

import { AGENT_NOTICE_SOURCE } from "../../shared/agent-notice.js";
import type { Ambient, IntervalHandle } from "../../shared/ambient.js";
import type { AwarenessObservation, AwarenessSubscriber } from "../../shared/awareness-types.js";
import type { BoardEntry } from "../../shared/console-protocol.js";
import { DurableStore } from "../../shared/durable-store.js";
import type { LaunchNotice } from "../../shared/launch-notice.js";
import { baselineLines, type SessionBaseline } from "../../shared/session-baseline.js";
import { agentTurnIdentity, createAgentAwarenessSubscriber, createAgentWatch } from "../agentAwareness.js";
import { type AwarenessBank, createAwarenessBank } from "../awarenessBank.js";
import { boardAwarenessSubscriber } from "../boardAwareness.js";
import type { ChannelDeliveryCoordinator } from "../channelDelivery.js";
import {
	createLaunchRecords,
	createLaunchSubscriber,
	type LaunchRecords,
	type LaunchRecordsDeps,
	launchOutcome,
} from "../launchRecords.js";
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
import type { StoresStage } from "./composeStores.js";
import type { WorkflowsStage } from "./composeWorkflows.js";

export interface AwarenessStageDeps {
	dataDir: string;
	sessions: Pick<SessionsStage, "registry" | "sessionStore" | "presence">;
	host: Pick<HostStage, "wakeService">;
	stores: Pick<StoresStage, "jobs">;
	/** Read late; composed after this stage. */
	deliveries: () => Pick<ChannelDeliveryCoordinator, "withdraw">;
	/** Read late, as routes are. */
	relayLaunch: LaunchRecordsDeps["relay"];
	wakeTimeoutMs: number;
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
	baselineObserve: (team: string, baseline: SessionBaseline) => void;
	launches: LaunchRecords;
	/** A relayed send's launch outcome, for the session that sent. */
	bankLaunch: (sessionKey: string, notice: LaunchNotice) => void;
	awarenessTimer: IntervalHandle;
}

const baselineAwarenessSubscriber: AwarenessSubscriber<SessionBaseline> = {
	source: "baseline",
	pushAfterMs: 0,
	act: () => "no_act",
	push: () => true,
	render: (_team, changes) => changes.flatMap((change) => (change.post ? baselineLines(change.post) : [])).join("\n"),
};

export function composeAwareness({
	dataDir,
	sessions,
	host,
	stores,
	deliveries,
	relayLaunch,
	wakeTimeoutMs,
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
	const observeBaseline = awareness.register(baselineAwarenessSubscriber);
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
	const isLive = (team: string) => Boolean(resolveLiveIncarnation(sessions.registry, sessions.sessionStore, team));
	let launches: LaunchRecords | null = null;
	const observeLaunches = awareness.register(
		createLaunchSubscriber((identity, key) => launches?.markTold(identity, key)),
	);
	launches = createLaunchRecords({
		durable: new DurableStore(dataDir, "launches"),
		now: () => ambient.now(),
		timeoutMs: wakeTimeoutMs,
		isLive,
		inFlight: (team) => host.wakeService.isWakeInFlight(team),
		withdraw: ({ deliveryId, channelJobId }) => {
			deliveries().withdraw(deliveryId);
			stores.jobs.remove(channelJobId);
		},
		forgetCreated: (team) => {
			const record = sessions.sessionStore.getByTeam(team);
			if (record && record.confirmedAt === undefined && !isLive(team)) sessions.presence.forget(team);
		},
		observe: observeLaunches,
		relay: relayLaunch,
	});
	const launchRecords = launches;
	host.wakeService.onSettled((team, result) => launchRecords.settle(team, launchOutcome(result)));
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
			launchRecords.tick();
			awareness.tick();
		} catch (err) {
			console.error("[awareness] tick failed:", err);
		}
	}, 1_000);

	return {
		awareness,
		boardObserve,
		workspaceObserve,
		workflowWatch,
		baselineObserve: (team, baseline) =>
			observeBaseline([{ sessionKey: team, identity: "compaction", pre: undefined, post: baseline }]),
		launches: launchRecords,
		bankLaunch: (sessionKey, notice) =>
			observeLaunches([
				{ sessionKey, identity: `relayed:${notice.address}:${notice.kind}`, pre: undefined, post: notice },
			]),
		awarenessTimer,
	};
}
