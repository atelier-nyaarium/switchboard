// The baseline a session's compact hook reads.

import { createBaselineRoutes, type Handler } from "../sessionBaseline.js";
import type { RoutineStage } from "./composeRoutines.js";
import type { SessionsStage } from "./composeSessions.js";
import type { StoresStage } from "./composeStores.js";
import type { FederationContext } from "./federationContext.js";

export interface BaselineStageDeps {
	context: FederationContext;
	stores: Pick<StoresStage, "jobs">;
	sessions: Pick<SessionsStage, "sessionAuthority" | "sessionStore">;
	routines: Pick<RoutineStage, "openRuns">;
}

export interface BaselineStage {
	routes: Map<string, Handler>;
}

export function composeBaseline({ context, stores, sessions, routines }: BaselineStageDeps): BaselineStage {
	const { sessionAuthority, sessionStore } = sessions;
	return {
		routes: createBaselineRoutes({
			resolveCaller: (req) => {
				const record = sessionAuthority.resolveConfirmedManagedSession(req);
				return record ? sessionStore.teamOf(record) : null;
			},
			conversations: (team, limit) => stores.jobs.conversationsTo(team, limit),
			board: async () => {
				const client = context.slice()?.boardClient;
				if (!client) return null;
				const board = await client.read();
				return board.kind === "ok" ? board.entries : null;
			},
			openRuns: (team) => routines.openRuns(team),
			runningAgents: (team) => {
				const record = sessionStore.getByTeam(team);
				if (!record) return [];
				return [
					...sessionStore
						.listCodexAgents(record)
						.filter((agent) => agent.activeTurnId !== undefined)
						.map((agent) => ({ family: "codex" as const, agentId: agent.agentId })),
					...sessionStore
						.listCopilotAgents(record)
						.filter((agent) => agent.activeTurnId !== undefined)
						.map((agent) => ({ family: "copilot" as const, agentId: agent.agentId })),
				];
			},
		}),
	};
}
