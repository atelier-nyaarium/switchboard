// The baseline a session's compact hook reads.

import { createBaselineRoutes, type Handler } from "../sessionBaseline.js";
import type { AssistantStage } from "./composeAssistant.js";
import type { RoutineStage } from "./composeRoutines.js";
import type { SessionsStage } from "./composeSessions.js";
import type { StoresStage } from "./composeStores.js";
import type { WorkflowsStage } from "./composeWorkflows.js";
import type { FederationContext } from "./federationContext.js";

export interface BaselineStageDeps {
	context: FederationContext;
	stores: Pick<StoresStage, "jobs">;
	sessions: Pick<SessionsStage, "sessionAuthority" | "sessionStore">;
	routines: Pick<RoutineStage, "openRuns">;
	workflows: Pick<WorkflowsStage, "runner" | "engine">;
	assistant: Pick<AssistantStage, "baselineFor">;
}

export interface BaselineStage {
	routes: Map<string, Handler>;
}

export function composeBaseline({
	context,
	stores,
	sessions,
	routines,
	workflows,
	assistant,
}: BaselineStageDeps): BaselineStage {
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
			runningRuns: (team) =>
				workflows.runner
					.running()
					.filter((run) => run.team === team)
					.map((run) => ({
						runId: run.runId,
						phase: workflows.engine.phase(run.runId),
						stepsRunning: (() => {
							const rows = workflows.runner.rows(run.runId);
							const settled = new Set(
								rows.filter((row) => row.kind === "settle").map((row) => row.issueOrdinal),
							);
							return rows.filter((row) => row.kind === "issue" && !settled.has(row.issueOrdinal)).length;
						})(),
					})),
			assistant: (team) => assistant.baselineFor(team),
			runningAgents: (team) => {
				const record = sessionStore.getByTeam(team);
				if (!record) return [];
				return [
					...sessionStore
						.listCodexAgents(record)
						.filter((agent) => agent.runId === undefined && agent.activeTurnId !== undefined)
						.map((agent) => ({ family: "codex" as const, agentId: agent.agentId })),
					...sessionStore
						.listCopilotAgents(record)
						.filter((agent) => agent.runId === undefined && agent.activeTurnId !== undefined)
						.map((agent) => ({ family: "copilot" as const, agentId: agent.agentId })),
				];
			},
		}),
	};
}
