// The awareness bank that rides changes out on the next channel push.

import type { Ambient, IntervalHandle } from "../../shared/ambient.js";
import type { AwarenessObservation } from "../../shared/awareness-types.js";
import type { BoardEntry } from "../../shared/console-protocol.js";
import { agentAwarenessSubscriber, createAgentWatch } from "../agentAwareness.js";
import { type AwarenessBank, createAwarenessBank } from "../awarenessBank.js";
import { boardAwarenessSubscriber } from "../boardAwareness.js";
import { type WorkspaceChange, workspaceAwarenessSubscriber } from "../workspaceAwareness.js";
import { reached, sendOn } from "../wsSend.js";
import { resolveLiveIncarnation } from "../wsTypes.js";
import type { AgentsStage } from "./composeAgents.js";
import type { HostStage } from "./composeHost.js";
import type { SessionsStage } from "./composeSessions.js";

export interface AwarenessStageDeps {
	sessions: Pick<SessionsStage, "registry" | "sessionStore">;
	host: Pick<HostStage, "wakeService">;
	agents: Pick<AgentsStage, "agentRoster">;
	ambient: Pick<Ambient, "now" | "randomBytes" | "setInterval">;
}

/** Ticks of the bank's one-second timer between agent catalog reads. */
const AGENT_WATCH_TICKS = 5;

export interface AwarenessStage {
	awareness: AwarenessBank;
	boardObserve: (observations: readonly AwarenessObservation<BoardEntry>[]) => void;
	workspaceObserve: (observations: readonly AwarenessObservation<WorkspaceChange>[]) => void;
	awarenessTimer: IntervalHandle;
}

export function composeAwareness({ sessions, host, agents, ambient }: AwarenessStageDeps): AwarenessStage {
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
	const agentWatch = createAgentWatch({
		roster: agents.agentRoster,
		observe: awareness.register(agentAwarenessSubscriber),
		now: () => ambient.now(),
		// Each notice types into a Copilot pane and costs a turn.
		takesProgress: (ownerKey) => sessions.sessionStore?.getByTeam(ownerKey)?.harness !== "copilot",
	});
	let ticks = 0;
	const awarenessTimer = ambient.setInterval(() => {
		try {
			if (ticks++ % AGENT_WATCH_TICKS === 0) agentWatch.tick();
			awareness.tick();
		} catch (err) {
			console.error("[awareness] tick failed:", err);
		}
	}, 1_000);

	return { awareness, boardObserve, workspaceObserve, awarenessTimer };
}
