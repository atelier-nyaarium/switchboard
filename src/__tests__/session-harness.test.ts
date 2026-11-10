import { describe, expect, it } from "vitest";
import { knownHarness, pushesBaseline, wireHarness } from "../shared/session-harness.js";

describe("a session CLI named on the wire", () => {
	it("reads an absent one as Claude, returns a known one, and refuses an unknown one", () => {
		expect([wireHarness(undefined), wireHarness(null)]).toEqual(["claude", "claude"]);
		expect(wireHarness("copilot")).toBe("copilot");
		expect(() => wireHarness("no-such-cli")).toThrow();
	});

	it("answers null for an unknown one where the caller decides", () => {
		expect([knownHarness(undefined), knownHarness(null)]).toEqual(["claude", "claude"]);
		expect(knownHarness("copilot")).toBe("copilot");
		expect(knownHarness("no-such-cli")).toBeNull();
	});
});

describe("a compacted session's baseline", () => {
	it("is pushed by the Gateway for Copilot, and left to the hook for Claude", () => {
		expect([pushesBaseline("claude"), pushesBaseline("copilot")]).toEqual([false, true]);
	});
});
