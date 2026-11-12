// A model's family: its id with the version numbers taken out.

import type { AgentBackendDescriptor } from "./agent-backend.js";
import type { AgentServiceTier } from "./agent-state.js";

////////////////////////////////
//  Interfaces & Types

export interface StartChoice {
	model?: string;
	serviceTier?: AgentServiceTier;
}

////////////////////////////////
//  Functions & Helpers

/** `claude-opus-5-4` and `claude-opus-5-5` share one; `deepseek-v4-pro` and `deepseek-v4.1-flash` do not. */
export function modelFamily(id: string): string {
	return id
		.toLowerCase()
		.replace(/\d+(?:[._-]\d+)*/g, "")
		.split(/[-_./]+/)
		.filter(Boolean)
		.join("-");
}

export function sameFamily(a: string, b: string): boolean {
	return modelFamily(a) === modelFamily(b);
}

/** A start in the default model's family runs at `priority` unless it names a tier. */
export function startDefaults(backend: AgentBackendDescriptor, args: StartChoice): StartChoice {
	if (!backend.options.serviceTier || args.serviceTier !== undefined) return args;
	const model = args.model ?? backend.defaultModel;
	return sameFamily(model, backend.defaultModel) ? { model, serviceTier: "priority" } : args;
}
