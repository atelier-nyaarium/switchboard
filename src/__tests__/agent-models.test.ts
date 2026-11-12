import { describe, expect, it } from "vitest";
import { newestPerFamily } from "../shared/agent-models.js";

describe("the newest model of each family", () => {
	it("drops a version its family has superseded", () => {
		expect(newestPerFamily(["claude-opus-5-4", "claude-opus-5-5", "claude-haiku-5-5"])).toEqual([
			"claude-opus-5-5",
			"claude-haiku-5-5",
		]);
		expect(newestPerFamily(["gemini-3-pro", "gemini-2.5-pro", "gemini-2.5-flash"])).toEqual([
			"gemini-3-pro",
			"gemini-2.5-flash",
		]);
		expect(newestPerFamily(["o3-mini", "o4-mini", "qwen2.5-coder", "qwen3-coder"])).toEqual([
			"o4-mini",
			"qwen3-coder",
		]);
	});

	it("keeps tiers, sizes and providers apart", () => {
		const offered = [
			"opencode-go/deepseek-v4-pro",
			"opencode-go/deepseek-v4-flash",
			"anthropic/claude-opus-5-5",
			"opencode-go/claude-opus-5-5",
			"llama-3.3-70b",
			"llama-3.3-8b",
			"gpt-6-luna",
			"gpt-6.1-sol",
		];
		expect(newestPerFamily(offered)).toEqual(offered);
	});

	it("reads a point release and a dated build as newer than their base", () => {
		expect(newestPerFamily(["claude-opus-4", "claude-opus-4-1"])).toEqual(["claude-opus-4-1"]);
		expect(newestPerFamily(["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"])).toEqual([
			"claude-sonnet-4-5-20250929",
		]);
		expect(newestPerFamily(["deepseek-v3-pro", "deepseek-v4-pro", "deepseek-v4-pro"])).toEqual(["deepseek-v4-pro"]);
	});
});
