import { describe, expect, it } from "vitest";
import { opencodeStatusLine, versionIn } from "../../scripts/lib/opencodeVersion.js";
import { OPENCODE_PIN } from "../shared/session-harness.js";

describe("setup's OpenCode step", () => {
	it("reads the version out of whatever the binary prints around it", () => {
		expect(
			["opencode v2.2.5", "2.2.5\n", "OpenCode 2.3.0-beta.1 (linux)", "command not found"].map(versionIn),
		).toEqual(["2.2.5", "2.2.5", "2.3.0-beta.1", undefined]);
	});

	it("says what this machine has against the pin", () => {
		expect([OPENCODE_PIN, "1.0.0", undefined].map(opencodeStatusLine)).toEqual([
			"Installed",
			"This machine has 1.0.0",
			"Not installed",
		]);
	});
});
