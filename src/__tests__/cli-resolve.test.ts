import { describe, expect, it } from "vitest";
import { cliRefusalText, placeCandidates, resolveCli } from "../shared/cli-resolve.js";
import { readHarness, UNPICKED_WORD } from "../shared/session-harness.js";

describe("the CLIs a place may run", () => {
	it("offers every CLI on the host's own shell, and Claude alone in a container or as the assistant", () => {
		expect(placeCandidates({ place: "host", assistant: false })).toEqual(["claude", "opencode", "copilot"]);
		expect(placeCandidates({ place: "windows", assistant: false })).toEqual(["claude", "copilot"]);
		expect(placeCandidates({ place: "container", assistant: false })).toEqual(["claude"]);
		expect(placeCandidates({ place: "host", assistant: true })).toEqual(["claude"]);
	});
});

describe("which CLI a launch runs", () => {
	const resolve = (word: unknown, available: Parameters<typeof resolveCli>[1]) =>
		resolveCli(readHarness(word), available);

	it("runs a named CLI only where it is installed", () => {
		expect(resolve("copilot", ["claude", "copilot"])).toEqual({ harness: "copilot" });
		expect(resolve("copilot", ["claude"])).toEqual({ refused: { cause: "not_installed", available: ["claude"] } });
	});

	it("runs the one installed CLI when none was picked, and asks or refuses otherwise", () => {
		expect(resolve(UNPICKED_WORD, ["opencode"])).toEqual({ harness: "opencode" });
		expect(resolve(UNPICKED_WORD, ["claude", "opencode"])).toEqual({
			refused: { cause: "needs_pick", available: ["claude", "opencode"] },
		});
		expect(resolve(UNPICKED_WORD, [])).toEqual({ refused: { cause: "none_installed" } });
	});

	it("runs an older sender's unnamed CLI unchecked, and refuses a word this build cannot read", () => {
		expect(resolve(undefined, [])).toEqual({ harness: "claude" });
		expect(resolve("no-such-cli", ["claude"])).toMatchObject({ refused: { cause: "refused" } });
	});
});

describe("the owner's words for a refused CLI", () => {
	it("names the spawn point and lists what it has, in the agent-facing wording", () => {
		expect(cliRefusalText({ cause: "needs_pick", available: ["claude", "opencode"] }, "host.oc")).toBe(
			[
				"`host.oc` has multiple CLIs. You must choose which. Ask the user if not sure.",
				"This spawn point has:",
				"- claude",
				"- opencode",
			].join("\n"),
		);
		expect(cliRefusalText({ cause: "not_installed", available: ["claude"] }, "host.oc")).toBe(
			["The specified CLI is not installed.", "This spawn point has:", "- claude"].join("\n"),
		);
		expect(cliRefusalText({ cause: "none_installed" }, "host.oc")).toBe(
			"This spawn point has no CLI installed. Talk to the user.",
		);
		expect(cliRefusalText({ cause: "refused", reason: "older build" }, "host.oc")).toBe("older build");
	});
});
