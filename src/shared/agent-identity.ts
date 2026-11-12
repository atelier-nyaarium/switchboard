import { z } from "zod";
import { AGENT_BACKENDS, type AgentBackendId, agentBackend, agentBackendOf, agentIdPattern } from "./agent-backend.js";
import {
	AGENT_ERROR_MAX_BYTES,
	AGENT_PROMPT_MAX_BYTES,
	type AgentOperationIdentity,
	boundedUtf8,
	sanitizeAgentErrorText,
} from "./agent-record.js";

////////////////////////////////
//  Schemas

const ANY_AGENT_ID_RE = new RegExp(`^(?:${AGENT_BACKENDS.map((backend) => backend.id).join("|")})_[0-9a-f]{32}$`);

export const AgentIdSchema = z.string().regex(ANY_AGENT_ID_RE);
export const AgentOperationIdSchema = z.string().uuid();
/** Backend-owned opaque handles. */
export const AgentOpaqueIdSchema = z.string().min(1).max(512);

export const AgentPromptSchema = z
	.string()
	.refine((value) => value.trim().length > 0, "prompt must not be blank")
	.refine((value) => new TextEncoder().encode(value).byteLength <= AGENT_PROMPT_MAX_BYTES, {
		message: `prompt must be at most ${AGENT_PROMPT_MAX_BYTES} UTF-8 bytes`,
	});

export const AgentErrorTextSchema = boundedUtf8(AGENT_ERROR_MAX_BYTES, "error")
	.refine((value) => value.length > 0, "error must not be blank")
	.refine((value) => value === agentErrorText(value), "error must be normalized");

////////////////////////////////
//  Functions & Helpers

export function agentIdSchemaFor(backend: AgentBackendId) {
	return z.string().regex(agentIdPattern(backend));
}

/** Normalize untrusted errors. */
export function agentErrorText(raw: string): string {
	return sanitizeAgentErrorText(raw, AGENT_ERROR_MAX_BYTES);
}

/** Preserve legacy fingerprint format. */
export function agentOperationIdentity(
	fields: Omit<AgentOperationIdentity, "legacyModellessStart">,
): AgentOperationIdentity {
	const backend = agentBackendOf(fields.agentId);
	const legacy = backend ? agentBackend(backend).legacyModellessStart : undefined;
	return legacy ? { ...fields, legacyModellessStart: legacy } : fields;
}

export type AgentId = z.infer<typeof AgentIdSchema>;
