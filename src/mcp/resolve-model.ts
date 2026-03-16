import type { EffortEnv } from "../shared/types.js";

////////////////////////////////
//  Interfaces & Types

export interface ResolveModelOptions {
	effortEnv: EffortEnv;
	agentType: string;
}

////////////////////////////////
//  Functions & Helpers

export const DEFAULT_MODELS: Record<string, Record<string, string>> = {
	claude: {
		simple: "haiku",
		standard: "sonnet",
		complex: "opus",
	},
	cursor: {
		simple: "auto",
		standard: "sonnet-4.6-thinking",
		complex: "opus-4.6-thinking",
	},
	copilot: {
		simple: "claude-haiku-4.5",
		standard: "claude-sonnet-4.6",
		complex: "claude-opus-4.6",
	},
	codex: {
		simple: "gpt-5.3-codex",
		standard: "gpt-5.3-codex",
		complex: "gpt-5.4",
	},
};

export function resolveModel(effort: string | null | undefined, { effortEnv, agentType }: ResolveModelOptions): string {
	const agentModels = DEFAULT_MODELS[agentType];
	if (!agentModels) {
		throw new Error(`Unknown AGENT_TYPE "${agentType}". Valid types: ${Object.keys(DEFAULT_MODELS).join(", ")}`);
	}

	const level = effort ?? "simple";

	// Env var override takes priority. "auto" or unset means use the default.
	const override = effortEnv[level as keyof EffortEnv];
	if (override && override !== "auto") {
		return override;
	}

	const model = agentModels[level];
	if (!model) {
		throw new Error(
			`Effort level "${level}" is not recognized. Valid levels: ${Object.keys(agentModels).join(", ")}`,
		);
	}

	return model;
}
