import { describe, expect, it } from "vitest";
import { resolveModel, DEFAULT_MODELS } from "../mcp/resolve-model.js";

const defaultEnv = { simple: "auto", standard: "auto", complex: "auto" };

describe("resolveModel", () => {
	describe("claude", () => {
		it("simple resolves to haiku", () => {
			expect(resolveModel("simple", { effortEnv: defaultEnv, agentType: "claude" })).toBe("haiku");
		});

		it("standard resolves to sonnet", () => {
			expect(resolveModel("standard", { effortEnv: defaultEnv, agentType: "claude" })).toBe("sonnet");
		});

		it("complex resolves to opus", () => {
			expect(resolveModel("complex", { effortEnv: defaultEnv, agentType: "claude" })).toBe("opus");
		});

		it("null effort falls back to simple", () => {
			expect(resolveModel(null, { effortEnv: defaultEnv, agentType: "claude" })).toBe("haiku");
		});

		it("undefined effort falls back to simple", () => {
			expect(resolveModel(undefined, { effortEnv: defaultEnv, agentType: "claude" })).toBe("haiku");
		});
	});

	describe("env var overrides", () => {
		it("override replaces the default model", () => {
			const env = { simple: "auto", standard: "opus", complex: "auto" };
			expect(resolveModel("standard", { effortEnv: env, agentType: "claude" })).toBe("opus");
		});

		it("auto falls through to default", () => {
			const env = { simple: "auto", standard: "auto", complex: "auto" };
			expect(resolveModel("complex", { effortEnv: env, agentType: "claude" })).toBe("opus");
		});

		it("literal model string is passed through for any agent type", () => {
			const env = { simple: "auto", standard: "gpt-5.4", complex: "auto" };
			expect(resolveModel("standard", { effortEnv: env, agentType: "codex" })).toBe("gpt-5.4");
		});
	});

	describe("codex", () => {
		it("defaults resolve correctly", () => {
			expect(resolveModel("simple", { effortEnv: defaultEnv, agentType: "codex" })).toBe("gpt-5.3-codex");
			expect(resolveModel("standard", { effortEnv: defaultEnv, agentType: "codex" })).toBe("gpt-5.3-codex");
			expect(resolveModel("complex", { effortEnv: defaultEnv, agentType: "codex" })).toBe("gpt-5.4");
		});
	});

	describe("copilot", () => {
		it("defaults resolve correctly", () => {
			expect(resolveModel("simple", { effortEnv: defaultEnv, agentType: "copilot" })).toBe("claude-haiku-4.5");
			expect(resolveModel("standard", { effortEnv: defaultEnv, agentType: "copilot" })).toBe("claude-sonnet-4.6");
			expect(resolveModel("complex", { effortEnv: defaultEnv, agentType: "copilot" })).toBe("claude-opus-4.6");
		});
	});

	describe("error cases", () => {
		it("unknown agentType throws with valid types list", () => {
			expect(() => resolveModel("simple", { effortEnv: defaultEnv, agentType: "unknown" })).toThrow(
				/Unknown AGENT_TYPE "unknown"/,
			);
		});
	});
});
