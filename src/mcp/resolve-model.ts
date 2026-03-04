// ---------------------------------------------------------------------------
// Effort -> model resolution
// ---------------------------------------------------------------------------
export const MODEL_STRINGS: Record<string, Record<string, string>> = {
	claude: {
		auto: "haiku",
		haiku: "haiku",
		sonnet: "sonnet",
		opus: "opus",
	},
	cursor: {
		auto: "auto",
		haiku: "ERROR",
		sonnet: "sonnet-4.6-thinking",
		opus: "opus-4.6-thinking",
		codex: "gpt-5.3-codex",
	},
	copilot: {
		auto: "claude-haiku-4.5",
		haiku: "claude-haiku-4.5",
		sonnet: "claude-sonnet-4.6",
		opus: "claude-opus-4.6",
	},
};

export function resolveModel(
	effort: string | null | undefined,
	{ effortEnv, agentType }: { effortEnv: Record<string, string>; agentType: string },
): string {
	const logicalName = effortEnv[effort ?? "auto"] ?? "auto";

	const agentModels = MODEL_STRINGS[agentType];
	if (!agentModels) {
		throw new Error(`Unknown AGENT_TYPE "${agentType}". Valid types: ${Object.keys(MODEL_STRINGS).join(", ")}`);
	}

	const model = agentModels[logicalName];
	if (!model || model === "ERROR") {
		throw new Error(
			`Model "${logicalName}" is not supported by agent type "${agentType}". ` +
				`Valid models for ${agentType}: ${Object.entries(agentModels)
					.filter(([, v]) => v !== "ERROR")
					.map(([k]) => k)
					.join(", ")}`,
		);
	}

	return model;
}
