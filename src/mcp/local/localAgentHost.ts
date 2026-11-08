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
import { AGENT_NOTICE_SOURCE, agentNoticeAct, agentNoticeLine } from "../../shared/agent-notice.js";
import { uncollectedTurns } from "../../shared/agent-turn-marks.js";
import { resolveWorkdir, workdirOrFallback } from "../../shared/agent-workdir.js";
import {
	CODEX_ACTIVITY_MAX_ITEMS,
	CodexAgentResultSchema,
	CodexGatewayRequestSchema,
	CodexRequestErrorSchema,
	type CodexServiceTier,
	CodexServiceTierSchema,
} from "../../shared/codex-agent.js";
import {
	COPILOT_ACTIVITY_MAX_ITEMS,
	CopilotAgentResultSchema,
	CopilotGatewayRequestSchema,
	CopilotRequestErrorSchema,
} from "../../shared/copilot-agent.js";
import { emitLocalAwareness } from "../bridge/helpers.js";
import { ExecutionTargetManager, realLauncher, targetLogger } from "../devcontainer/codexTargets.js";
import { copilotLauncher } from "../devcontainer/copilotTargets.js";
import { CodexLocalSession } from "./codexLocalSession.js";
import { CopilotLocalSession } from "./copilotLocalSession.js";
import { LocalAgentRuntime, type LocalBackendSpec } from "./localAgentRuntime.js";
import type { LocalBackendSession } from "./localAgentSession.js";

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

/** Only the Codex half of the request union declares a tier, so the schema does the narrowing. */
function serviceTierOf(request: object): { serviceTier?: CodexServiceTier } {
	const parsed = CodexServiceTierSchema.safeParse((request as { serviceTier?: unknown }).serviceTier);
	return parsed.success ? { serviceTier: parsed.data } : {};
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
	const isCodex = backend.id === "codex";
	const targets = new ExecutionTargetManager(
		isCodex ? realLauncher : copilotLauncher,
		undefined,
		targetLogger(`${backend.id}-local`),
		undefined,
		agentEnvPrefix(backend.id),
	);

	const spec: LocalBackendSpec = {
		backendId: backend.id,
		defaultCwd: () => process.cwd(),
		followupDelivery: isCodex ? "started" : "followup",
		maxActivities: isCodex ? CODEX_ACTIVITY_MAX_ITEMS : COPILOT_ACTIVITY_MAX_ITEMS,
		// A codex thread is durable and gets resumed, so a reaped child's work is adopted by its
		// replacement. An ACP session lives inside the Copilot child and dies with it, so reaping one
		// would destroy agents the caller may still message - see the spec field's own doc.
		threadsResumable: isCodex,
		// Never, on either backend, and stated rather than absent. See the spec field: there is no
		// transport that can retry unseen and no record that survives the process to replay from.
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
		openSession: async (): Promise<LocalBackendSession> => {
			const target: AgentResolvedTarget = AgentResolvedTargetSchema.parse({
				kind: "host",
				targetId: AGENT_HOST_TARGET_ID,
				cwd: process.cwd(),
			});
			const availability = targets.acquire(target);
			if (availability.state !== "running") throw unavailable(availability.errorClass, backend);
			return isCodex
				? CodexLocalSession.open(availability.lease.child)
				: CopilotLocalSession.open(availability.lease.child);
		},
	};

	const runtime = new LocalAgentRuntime(spec);
	const requestSchema = isCodex ? CodexGatewayRequestSchema : CopilotGatewayRequestSchema;
	const requestErrorSchema = isCodex ? CodexRequestErrorSchema : CopilotRequestErrorSchema;
	const resultSchema = isCodex ? CodexAgentResultSchema : CopilotAgentResultSchema;

	const listAgents = (request: { agentId?: string; limit?: number }): unknown =>
		agentListAnswer(runtime.list(), request, (agent) =>
			agentListRow(agent, backend.id, { model: agent.model, latestPrompt: agent.exchanges.at(-1)?.prompt }),
		);

	/** The result envelope cannot carry this: it only permits an error when the AGENT is unwell. */
	const refuse = (message: string): unknown =>
		requestErrorSchema.parse({ error: { code: "invalid_input", retryable: false, message } });

	return {
		async handle(body) {
			// The gateway route's own schema, so a malformed call is refused identically on both paths.
			const parsed = requestSchema.safeParse(body);
			if (!parsed.success) return refuse(parsed.error.issues[0]?.message ?? `invalid request`);

			const request = parsed.data;
			if (request.kind === "list") return listAgents(request);
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
				// Narrowed by the schema itself: only the Codex half of this union declares the field.
				...serviceTierOf(request),
				...("reasoningEffort" in request && request.reasoningEffort !== undefined
					? { reasoningEffort: request.reasoningEffort }
					: {}),
				...("outputSchema" in request && request.outputSchema !== undefined
					? { outputSchema: request.outputSchema }
					: {}),
			});
			if ("refused" in answer) return refuse(answer.refused);
			return "running" in answer ? answer : resultSchema.parse(answer);
		},
		shutdown() {
			runtime.shutdown();
			targets.shutdown();
		},
	};
}
