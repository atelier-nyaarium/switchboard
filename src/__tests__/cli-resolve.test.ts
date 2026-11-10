import { describe, expect, it } from "vitest";
import { cliRefusalText, pickAt, resolveCli } from "../shared/cli-resolve.js";
import { sendRefusalText } from "../shared/launch-notice.js";
import { readHarness, UNPICKED_WORD } from "../shared/session-harness.js";

describe("which CLI a launch runs", () => {
	const resolve = (word: unknown, available: Parameters<typeof resolveCli>[1]) =>
		resolveCli(readHarness(word), available);

	it("runs a named CLI only where it is installed, and says when nothing is", () => {
		expect(resolve("copilot", ["claude", "copilot"])).toEqual({ harness: "copilot" });
		expect(resolve("copilot", ["claude"])).toEqual({ refused: { cause: "not_installed", available: ["claude"] } });
		expect(resolve("copilot", [])).toEqual({ refused: { cause: "none_installed" } });
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

describe("a create's CLI where its place's are known", () => {
	const host = { place: "host" as const, assistant: false };
	const container = { place: "container" as const, assistant: false };

	it("takes the named or the only CLI, and leaves it to the place when the place has not said", () => {
		expect(pickAt(host, "opencode", ["claude", "opencode"])).toEqual({ harness: "opencode" });
		expect(pickAt(host, undefined, ["claude"])).toEqual({ harness: "claude" });
		expect(pickAt(container, undefined, undefined)).toEqual({});
		expect(pickAt(container, "claude", undefined)).toEqual({ harness: "claude" });
	});

	it("refuses several with none named, one not installed, none installed, and one the place never runs", () => {
		expect(pickAt(host, undefined, ["claude", "opencode"])).toEqual({
			refused: { cause: "needs_pick", available: ["claude", "opencode"] },
		});
		expect(pickAt(host, "copilot", ["claude"])).toEqual({
			refused: { cause: "not_installed", available: ["claude"] },
		});
		expect(pickAt(container, undefined, [])).toEqual({ refused: { cause: "none_installed" } });
		expect(pickAt(container, "copilot", undefined)).toMatchObject({ refused: { cause: "refused" } });
		expect(pickAt(container, undefined, ["claude", "opencode"])).toEqual({ harness: "claude" });
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
		expect(cliRefusalText({ cause: "refused", reason: "older\n  build" }, "host.oc")).toBe("older build");
	});

	it("words a send to a missing session with no label", () => {
		expect(sendRefusalText({ kind: "no_label" }, "d.g.app.ghost")).toBe(
			"`d.g.app.ghost` does not exist. Set `displayLabel` to create it.",
		);
	});
});
