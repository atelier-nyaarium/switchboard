import { describe, expect, it } from "vitest";
import { foldHarness, launchRefusal, mintedIdOf, pushesBaseline, readHarness } from "../shared/session-harness.js";

describe("a session CLI named on the wire", () => {
	it("reads an absent word as unnamed Claude, a known one as named, and any other as unknown", () => {
		expect([readHarness(undefined), readHarness(null)]).toEqual([
			{ read: "unnamed", assumed: "claude" },
			{ read: "unnamed", assumed: "claude" },
		]);
		expect(readHarness("copilot")).toEqual({ read: "named", harness: "copilot" });
		expect(readHarness("no-such-cli")).toEqual({ read: "unknown", word: "no-such-cli" });
	});

	it("hands each reading to its own case", () => {
		const told = (value: unknown) =>
			foldHarness(readHarness(value), {
				named: (harness) => `named ${harness}`,
				unnamed: (assumed) => `unnamed ${assumed}`,
				unknown: (word) => `unknown ${word}`,
			});

		expect([told("copilot"), told(undefined), told("no-such-cli")]).toEqual([
			"named copilot",
			"unnamed claude",
			"unknown no-such-cli",
		]);
	});
});

describe("a session id the Gateway mints", () => {
	const id = "0f8b2a4c-1d3e-4f5a-9b6c-7d8e9f0a1b2c";

	it("is read only for a CLI that takes one, and only in its shape", () => {
		expect(mintedIdOf("copilot", id)).toBe(id);
		expect([mintedIdOf("copilot", "nope"), mintedIdOf("copilot", undefined)]).toEqual([undefined, undefined]);
		expect(mintedIdOf("claude", id)).toBeUndefined();
	});
});

describe("where a session CLI may launch", () => {
	it("refuses Copilot off a host spawn point and as the assistant, and Claude nowhere", () => {
		const offHost = launchRefusal("copilot", { host: false, assistant: false });
		const asAssistant = launchRefusal("copilot", { host: true, assistant: true });

		expect([typeof offHost, typeof asAssistant]).toEqual(["string", "string"]);
		expect(offHost).not.toBe(asAssistant);
		expect(launchRefusal("copilot", { host: true, assistant: false })).toBeNull();
		for (const host of [true, false]) {
			for (const assistant of [true, false]) expect(launchRefusal("claude", { host, assistant })).toBeNull();
		}
	});
});

describe("a compacted session's baseline", () => {
	it("is pushed by the Gateway for Copilot, and left to the hook for Claude", () => {
		expect([pushesBaseline("claude"), pushesBaseline("copilot")]).toEqual([false, true]);
	});
});
