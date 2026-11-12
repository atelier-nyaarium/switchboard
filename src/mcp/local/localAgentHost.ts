// The session's own agent backend, used when no daemon announced one.
//
// Parsed through the very schema the gateway path answers with, so a shaping mistake fails loudly
// rather than reaching Claude as a plausible wrong answer.

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
	/** The very body the tool would have posted, so the dispatches differ only in transport. */
	handle(body: Record<string, unknown>): Promise<unknown>;
	shutdown(): void;
}

////////////////////////////////
//  Functions & Helpers

/**
 * The daemonless binding of the shared working-directory rule.
 *
 * It used to read a bare hint as a RELATIVE PATH from the session's own directory and fall back
 * there too, while the daemon read the same string as a project LABEL and fell back to home. Which
 * of those a caller got was decided by whether a daemon happened to be serving this backend, which
 * is not something the caller can see or chose. Same roots, same grammar, same fallback now; see
 * `shared/agent-workdir.ts` for why the roots are the only part that may differ per machine.
 *
 * Roots default to this machine's own, NOT to `process.cwd()`: a daemon on this same box would look
 * a label up there, and the answer must not turn on which one is running.
 */
export function resolveLocalCwd(requested: string | undefined, home: string = os.homedir()): string {
	return workdirOrFallback(resolveWorkdir(requested, "agentCwd", { roots: [path.join(home, "projects")], home }));
}

function unavailable(errorClass: string, backend: AgentBackendDescriptor): Error {
	return new Error(`${backend.displayName} is unavailable (${errorClass})`);
}

/**
 * The target manager is reused, so a local child gets the same env scrub, backoff and cooldown.
 *
 * Only the host target exists: a devcontainer target crosses a boundary this process lacks.
 */
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
		// Reaping loses nonresumable agents.
		threadsResumable: driver.threadsResumable,
		// Never, on any backend: no transport retries unseen and no record survives the process.
		replaysOperations: false,
		notify: (notice) => {
			const awareness = { from: AGENT_NOTICE_SOURCE, body: agentNoticeLine(notice), act: agentNoticeAct(notice) };
			// A collected turn needs no wake.
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

	/** The result envelope cannot carry this: it only permits an error when the AGENT is unwell. */
	const refuse = (message: string): unknown =>
		AgentRequestErrorSchema.parse({ error: { code: "invalid_input", retryable: false, message } });

	return {
		async handle(body) {
			// The gateway route's own schema, so a malformed call is refused identically on both paths.
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
				// Forwarded rather than dropped. It was validated by the schema above and then discarded
				// while the runtime minted its own, which made the field read as honoured on both paths
				// when only one honoured it.
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
			return "running" in answer ? answer : AgentResultSchema.parse(answer);
		},
		shutdown() {
			runtime.shutdown();
			targets.shutdown();
		},
	};
}
