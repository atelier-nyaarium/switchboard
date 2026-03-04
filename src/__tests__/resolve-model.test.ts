import { describe, expect, it } from "vitest";
import { resolveModel, MODEL_STRINGS } from "../mcp/resolve-model.js";

const defaultEnv = { simple: "auto", standard: "auto", complex: "auto" };

describe("resolveModel", () => {
	describe("claude", () => {
		it("simple with default env resolves to haiku", () => {
			expect(resolveModel("simple", { effortEnv: defaultEnv, agentType: "claude" })).toBe("haiku");
		});

		it("effort=null falls back to auto -> haiku", () => {
			expect(resolveModel(null, { effortEnv: defaultEnv, agentType: "claude" })).toBe("haiku");
		});

		it("effort=undefined falls back to auto -> haiku", () => {
			expect(resolveModel(undefined, { effortEnv: defaultEnv, agentType: "claude" })).toBe("haiku");
		});

		it("custom effortEnv maps simple->opus correctly", () => {
			const env = { simple: "opus", standard: "sonnet", complex: "opus" };
			expect(resolveModel("simple", { effortEnv: env, agentType: "claude" })).toBe("opus");
			expect(resolveModel("standard", { effortEnv: env, agentType: "claude" })).toBe("sonnet");
		});
	});

	describe("cursor", () => {
		it("auto resolves to auto", () => {
			expect(resolveModel("simple", { effortEnv: defaultEnv, agentType: "cursor" })).toBe("auto");
		});

		it("haiku throws (unsupported)", () => {
			const env = { simple: "haiku", standard: "auto", complex: "auto" };
			expect(() => resolveModel("simple", { effortEnv: env, agentType: "cursor" })).toThrow(
				/not supported by agent type "cursor"/,
			);
		});

		it("sonnet resolves correctly", () => {
			const env = { simple: "sonnet", standard: "auto", complex: "auto" };
			expect(resolveModel("simple", { effortEnv: env, agentType: "cursor" })).toBe("sonnet-4.6-thinking");
		});
	});

	describe("copilot", () => {
		it("all valid effort levels resolve correctly", () => {
			const env = { simple: "haiku", standard: "sonnet", complex: "opus" };
			expect(resolveModel("simple", { effortEnv: env, agentType: "copilot" })).toBe("claude-haiku-4.5");
			expect(resolveModel("standard", { effortEnv: env, agentType: "copilot" })).toBe("claude-sonnet-4.6");
			expect(resolveModel("complex", { effortEnv: env, agentType: "copilot" })).toBe("claude-opus-4.6");
		});
	});

	describe("error cases", () => {
		it("unknown agentType throws with valid types list", () => {
			expect(() => resolveModel("simple", { effortEnv: defaultEnv, agentType: "unknown" })).toThrow(
				/Unknown AGENT_TYPE "unknown".*claude, cursor, copilot/,
			);
		});

		it("unknown logical name falls back to auto", () => {
			const env = { simple: "nonexistent", standard: "auto", complex: "auto" };
			expect(() => resolveModel("simple", { effortEnv: env, agentType: "claude" })).toThrow(/not supported/);
		});
	});
});
