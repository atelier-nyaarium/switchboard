import { describe, expect, it } from "vitest";
import { type LaunchFailure, ownerLaunchLine, ownerLaunchPhrase } from "../shared/launch-notice.js";

describe("the owner's words for a failed launch", () => {
	it("reads a missing CLI in the present on its own line, and in the past after a stopped time", () => {
		const available = ["claude" as const];
		const missing: LaunchFailure = {
			kind: "cli",
			refusal: { cause: "not_installed", available, named: "copilot" },
		};
		const unnamed: LaunchFailure = { kind: "cli", refusal: { cause: "not_installed", available } };

		expect(ownerLaunchLine(missing)).toBe("Copilot is not installed.");
		expect(ownerLaunchPhrase(missing)).toBe("Copilot was not installed");
		expect(ownerLaunchLine(unnamed)).toBe("Selected CLI is not installed.");
	});

	it("reads a CLI missing in a container as a pick to change, there alone", () => {
		const missing: LaunchFailure = {
			kind: "cli",
			refusal: { cause: "not_installed", available: ["claude"], named: "opencode" },
		};
		const unnamed: LaunchFailure = { kind: "cli", refusal: { cause: "not_installed", available: ["claude"] } };

		expect(ownerLaunchLine(missing, "container")).toBe("Devcontainer does not have OpenCode. Choose another CLI.");
		expect(ownerLaunchLine(missing, "host")).toBe("OpenCode is not installed.");
		expect(ownerLaunchLine(unnamed, "container")).toBe("Selected CLI is not installed.");
		expect(ownerLaunchPhrase(missing)).toBe("OpenCode was not installed");
	});

	it("keeps every other failure's line as its phrase, capitalized", () => {
		const failed: LaunchFailure = { kind: "container", spawn: "halo" };

		expect(ownerLaunchLine(failed)).toBe("Devcontainer failed to start.");
		expect(ownerLaunchPhrase(failed)).toBe("devcontainer failed to start");
	});
});
