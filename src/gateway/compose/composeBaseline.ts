// The baseline a session's compact hook reads.

import type { SessionBaseline } from "../../shared/session-baseline.js";
import {
	type BaselineRoutesDeps,
	createBaselineReader,
	createBaselineRoutes,
	type Handler,
} from "../sessionBaseline.js";
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
	baselineFor: (team: string) => Promise<SessionBaseline>;
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
	const reader: Omit<BaselineRoutesDeps, "resolveCaller"> = {
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
			return sessionStore
				.everyAgent(record)
				.filter(({ agent }) => agent.runId === undefined && agent.activeTurnId !== undefined)
				.map(({ backend, agent }) => ({ family: backend, agentId: agent.agentId }));
		},
	};
	return {
		routes: createBaselineRoutes({
			...reader,
			resolveCaller: (req) => {
				const record = sessionAuthority.resolveConfirmedManagedSession(req);
				return record ? sessionStore.teamOf(record) : null;
			},
		}),
		baselineFor: createBaselineReader(reader),
	};
}
