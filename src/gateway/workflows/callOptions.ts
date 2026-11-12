// Call options, replay hashes.

import { z } from "zod";
import { AGENT_BACKENDS, type AgentBackendDescriptor, type AgentBackendId } from "../../shared/agent-backend.js";
import { AgentMessageInputSchema, AgentStartInputSchema } from "../../shared/agent-state.js";
import { canonicalJson, sha256Hex } from "../../shared/canonical-json.js";
import { type JsonValue, type WorkflowCallOptions, WorkflowCallOptionsSchema } from "./workflowSchemas.js";

////////////////////////////////
//  Interfaces & Types

export type WorkflowBackend = NonNullable<WorkflowCallOptions["backend"]>;

export interface ThreadOptions {
	backend: WorkflowBackend;
	model?: string;
	effort?: WorkflowCallOptions["effort"];
	tier?: WorkflowCallOptions["tier"];
	skills: string[];
}

////////////////////////////////
//  Schemas

const commonOptionShape = {
	backend: WorkflowCallOptionsSchema.shape.backend,
	skills: WorkflowCallOptionsSchema.shape.skills,
	thread: WorkflowCallOptionsSchema.shape.thread,
	label: WorkflowCallOptionsSchema.shape.label,
	phase: WorkflowCallOptionsSchema.shape.phase,
};

function agentCallOptions(backend: AgentBackendDescriptor) {
	return z
		.object({
			...commonOptionShape,
			model: AgentStartInputSchema.shape.model,
			...(backend.options.serviceTier ? { tier: AgentStartInputSchema.shape.serviceTier } : {}),
			...(backend.options.reasoningEffort ? { effort: AgentStartInputSchema.shape.reasoningEffort } : {}),
			schema: AgentStartInputSchema.shape.outputSchema,
		})
		.strict();
}

const ClaudeCallOptionsSchema = z
	.object({
		...commonOptionShape,
		model: z.string().optional(),
		effort: WorkflowCallOptionsSchema.shape.effort,
		schema: AgentStartInputSchema.shape.outputSchema,
	})
	.strict();

const AGENT_SCHEMAS = new Map<AgentBackendId, z.ZodType>(
	AGENT_BACKENDS.map((backend) => [backend.id, agentCallOptions(backend)]),
);

function optionsSchema(backend: WorkflowBackend): z.ZodType {
	const schema = backend === "claude" ? ClaudeCallOptionsSchema : AGENT_SCHEMAS.get(backend);
	if (!schema) throw new Error(`unknown backend ${backend}`);
	return schema;
}

const AgentMessageOptionsSchema = AgentMessageInputSchema.pick({
	prompt: true,
	serviceTier: true,
	outputSchema: true,
}).strict();

////////////////////////////////
//  Functions & Helpers

export const stableSkills = (value: string[] | undefined): string[] => [...(value ?? [])];

/** Applies backend input rules. */
export function parseCallOptions(
	raw: unknown,
	defaultBackend: WorkflowBackend,
): { backend: WorkflowBackend; options: WorkflowCallOptions } {
	const parsed = WorkflowCallOptionsSchema.parse(raw ?? {});
	const backend = parsed.backend ?? defaultBackend;
	const checked = optionsSchema(backend).safeParse(parsed);
	if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? "invalid backend options");
	return { backend, options: checked.data as WorkflowCallOptions };
}

export const threadOptionsOf = (backend: WorkflowBackend, options: WorkflowCallOptions): ThreadOptions => ({
	backend,
	...(options.model !== undefined ? { model: options.model } : {}),
	...(options.effort !== undefined ? { effort: options.effort } : {}),
	...(options.tier !== undefined ? { tier: options.tier } : {}),
	skills: stableSkills(options.skills),
});

/** Inherits omitted thread settings. */
export function joinThread(
	threadKey: string,
	held: ThreadOptions,
	backend: WorkflowBackend,
	prompt: string,
	options: WorkflowCallOptions,
): void {
	if (held.backend !== backend) throw new Error(`thread ${threadKey} backend changed`);
	if (options.model !== undefined && options.model !== held.model)
		throw new Error(`thread ${threadKey} model changed`);
	if (options.effort !== undefined && options.effort !== held.effort) {
		throw new Error(`thread ${threadKey} effort changed`);
	}
	if (options.skills !== undefined && stableSkills(options.skills).join("\n") !== held.skills.join("\n")) {
		throw new Error(`thread ${threadKey} skills changed`);
	}
	options.skills ??= [...held.skills];
	options.model ??= held.model;
	options.effort ??= held.effort;
	if (backend !== "claude")
		AgentMessageOptionsSchema.parse({ prompt, serviceTier: options.tier, outputSchema: options.schema });
}

/** Replay omits `label`, `phase`. */
export function callFingerprint(prompt: string, backend: WorkflowBackend, options: WorkflowCallOptions): string {
	const fields: Record<string, JsonValue> = {
		prompt,
		backend,
		model: options.model ?? null,
		effort: options.effort ?? null,
		tier: options.tier ?? null,
		schema: options.schema ?? null,
		skills: stableSkills(options.skills),
		thread: options.thread ?? null,
	};
	return sha256Hex(canonicalJson(fields));
}
