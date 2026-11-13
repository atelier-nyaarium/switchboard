import os from "node:os";
import path from "node:path";
import { type AgentBackendDescriptor, agentEnvPrefix } from "../../shared/agent-backend.js";
import { agentListAnswer, agentListRow } from "../../shared/agent-collect.js";
import {
	AGENT_HOST_TARGET_ID,
	type AgentResolvedTarget,
	AgentResolvedTargetSchema,
} from "../../shared/agent-execution-target.js";
import { offeredModels } from "../../shared/agent-models.js";
import { AGENT_NOTICE_SOURCE, agentNoticeAct, agentNoticeLine } from "../../shared/agent-notice.js";
import { AGENT_ACTIVITY_MAX_ITEMS } from "../../shared/agent-record.js";
import {
	AgentDeleteAnswerSchema,
	AgentGatewayRequestSchema,
	AgentModelsAnswerSchema,
	AgentRequestErrorSchema,
	AgentResultSchema,
	agentRequestIssue,
} from "../../shared/agent-state.js";
import { uncollectedTurns } from "../../shared/agent-turn-marks.js";
import { resolveWorkdir, workdirOrFallback } from "../../shared/agent-workdir.js";
import type { AgentBackendSession } from "../agents/backendSession.js";
import { AGENT_DRIVERS } from "../agents/drivers.js";
import { emitLocalAwareness } from "../bridge/helpers.js";
import { ExecutionTargetManager, targetLogger } from "../devcontainer/agentTargets.js";
import { LocalAgentRuntime, type LocalBackendSpec } from "./localAgentRuntime.js";

////////////////////////////////
//  Interfaces & Types

export interface LocalAgentBackend {
	/** Gateway-equivalent request body. */
	handle(body: Record<string, unknown>): Promise<unknown>;
	/** Deletes threads before child shutdown. */
	shutdown(): Promise<void>;
}

////////////////////////////////
//  Functions & Helpers

/** Host roots keep resolution independent of daemon availability. */
export function resolveLocalCwd(requested: string | undefined, home: string = os.homedir()): string {
	return workdirOrFallback(resolveWorkdir(requested, "agentCwd", { roots: [path.join(home, "projects")], home }));
}

function unavailable(errorClass: string, backend: AgentBackendDescriptor): Error {
	return new Error(`${backend.displayName} is unavailable (${errorClass})`);
}

/** Local children require host targets. */
export function createLocalAgentBackend(backend: AgentBackendDescriptor): LocalAgentBackend {
	const driver = AGENT_DRIVERS[backend.id];
	const targets = new ExecutionTargetManager({
		launcher: driver.launcher,
		log: targetLogger(`${backend.id}-local`),
		envPrefix: agentEnvPrefix(backend.id),
	});

	const spec: LocalBackendSpec = {
		backendId: backend.id,
		displayName: backend.displayName,
		failureCode: driver.failureCode,
		defaultCwd: () => process.cwd(),
		maxActivities: AGENT_ACTIVITY_MAX_ITEMS,
		// Preserve nonresumable agent threads.
		threadsResumable: driver.threadsResumable,
		// Local operations have no durable replay.
		replaysOperations: false,
		notify: (notice) => {
			const awareness = { from: AGENT_NOTICE_SOURCE, body: agentNoticeLine(notice), act: agentNoticeAct(notice) };
			// Collected turns need no wake.
			const stillWanted = () =>
				notice.kind !== "done" ||
				runtime.list().some((agent) => agent.agentId === notice.agentId && uncollectedTurns(agent) > 0);
			void emitLocalAwareness(awareness, stillWanted).catch((error) =>
				console.error(`[${backend.id}-local] notice failed:`, error),
			);
		},
		openSession: async (): Promise<AgentBackendSession> => {
			const target: AgentResolvedTarget = AgentResolvedTargetSchema.parse({
				kind: "host",
				targetId: AGENT_HOST_TARGET_ID,
				cwd: process.cwd(),
			});
			const availability = targets.acquire(target);
			if (availability.state !== "running") throw unavailable(availability.errorClass, backend);
			return driver.open(availability.lease.child);
		},
	};

	const runtime = new LocalAgentRuntime(spec);
	const listAgents = (request: { agentId?: string; limit?: number }): unknown =>
		agentListAnswer(runtime.list(), request, (agent) =>
			agentListRow(agent, backend.id, { model: agent.model, latestPrompt: agent.exchanges.at(-1)?.prompt }),
		);

	/** Refusals require the request error envelope. */
	const refuse = (message: string): unknown =>
		AgentRequestErrorSchema.parse({ error: { code: "invalid_input", retryable: false, message } });

	return {
		async handle(body) {
			const parsed = AgentGatewayRequestSchema.safeParse(body);
			if (!parsed.success) return refuse(parsed.error.issues[0]?.message ?? `invalid request`);
			const issue = agentRequestIssue(backend, parsed.data);
			if (issue) return refuse(issue);

			const request = parsed.data;
			if (request.kind === "list") return listAgents(request);
			if (request.kind === "models") {
				const listed = await runtime.listModels();
				if (!listed) throw new Error(`${backend.displayName} lists no models`);
				return AgentModelsAnswerSchema.parse({ models: offeredModels(listed, backend.defaultModel) });
			}
			const answer = await runtime.handle({
				kind: request.kind,
				// Preserve caller-supplied operation IDs.
				...("operationId" in request ? { operationId: request.operationId } : {}),
				...("agentId" in request ? { agentId: request.agentId } : {}),
				...("prompt" in request ? { prompt: request.prompt } : {}),
				...("model" in request && request.model !== undefined ? { model: request.model } : {}),
				...("cwd" in request && request.cwd !== undefined ? { cwd: resolveLocalCwd(request.cwd) } : {}),
				...("serviceTier" in request && request.serviceTier !== undefined
					? { serviceTier: request.serviceTier }
					: {}),
				...("reasoningEffort" in request && request.reasoningEffort !== undefined
					? { reasoningEffort: request.reasoningEffort }
					: {}),
				...("outputSchema" in request && request.outputSchema !== undefined
					? { outputSchema: request.outputSchema }
					: {}),
			});
			if ("refused" in answer) return refuse(answer.refused);
			if ("deleted" in answer) return AgentDeleteAnswerSchema.parse(answer);
			return "running" in answer ? answer : AgentResultSchema.parse(answer);
		},
		async shutdown() {
			try {
				await runtime.shutdown();
			} finally {
				targets.shutdown();
			}
		},
	};
}
