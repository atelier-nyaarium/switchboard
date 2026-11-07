// Call options, replay hashes.

import { z } from "zod";
import { canonicalJson, sha256Hex } from "../../shared/canonical-json.js";
import { CodexMessageAgentInputSchema, CodexStartAgentInputSchema } from "../../shared/codexAgentState.js";
import { CopilotMessageAgentInputSchema, CopilotStartAgentInputSchema } from "../../shared/copilotAgentState.js";
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

const CodexCallOptionsSchema = z
	.object({
		...commonOptionShape,
		model: CodexStartAgentInputSchema.shape.model,
		tier: CodexStartAgentInputSchema.shape.serviceTier,
		schema: CodexStartAgentInputSchema.shape.outputSchema,
	})
	.strict();

const CopilotCallOptionsSchema = z
	.object({
		...commonOptionShape,
		model: CopilotStartAgentInputSchema.shape.model,
		effort: CopilotStartAgentInputSchema.shape.reasoningEffort,
		schema: CopilotStartAgentInputSchema.shape.outputSchema,
	})
	.strict();

const ClaudeCallOptionsSchema = z
	.object({
		...commonOptionShape,
		model: z.string().optional(),
		effort: WorkflowCallOptionsSchema.shape.effort,
		schema: CodexStartAgentInputSchema.shape.outputSchema,
	})
	.strict();

const FAMILY_SCHEMAS: Record<WorkflowBackend, z.ZodType> = {
	codex: CodexCallOptionsSchema,
	copilot: CopilotCallOptionsSchema,
	claude: ClaudeCallOptionsSchema,
};

const CodexMessageOptionsSchema = z
	.object({
		prompt: CodexMessageAgentInputSchema.shape.prompt,
		serviceTier: CodexMessageAgentInputSchema.shape.serviceTier,
		outputSchema: CodexMessageAgentInputSchema.shape.outputSchema,
	})
	.strict();

const CopilotMessageOptionsSchema = z
	.object({
		prompt: CopilotMessageAgentInputSchema.shape.prompt,
		outputSchema: CopilotMessageAgentInputSchema.shape.outputSchema,
	})
	.strict();

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
	const family = FAMILY_SCHEMAS[backend].safeParse(parsed);
	if (!family.success) throw new Error(family.error.issues[0]?.message ?? "invalid backend options");
	return { backend, options: family.data as WorkflowCallOptions };
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
	if (backend === "codex") {
		CodexMessageOptionsSchema.parse({ prompt, serviceTier: options.tier, outputSchema: options.schema });
	} else if (backend === "copilot") {
		CopilotMessageOptionsSchema.parse({ prompt, outputSchema: options.schema });
	}
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
