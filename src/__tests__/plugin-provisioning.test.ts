import { describe, expect, it } from "vitest";
import { provisionPlugins } from "../mcp/devcontainer/pluginProvisioning.js";
import { HARNESS, type SessionHarness } from "../shared/session-harness.js";

const CLAUDE = HARNESS.claude.plugins;
const COPILOT = HARNESS.copilot.plugins;

/** A container whose CLIs report set up or not; an install sets its CLI up when `takes`. */
function container(setUp: Partial<Record<SessionHarness, boolean>>, takes = true) {
	const ran: string[] = [];
	const owner = (script: string) =>
		(["claude", "copilot"] as const).find(
			(harness) => HARNESS[harness].plugins?.installed === script || HARNESS[harness].plugins?.install === script,
		);
	const run = async (script: string) => {
		ran.push(script);
		const harness = owner(script);
		if (!harness) return false;
		if (HARNESS[harness].plugins?.install === script) {
			if (takes) setUp[harness] = true;
			return takes;
		}
		return setUp[harness] === true;
	};
	return { run, ran };
}

describe("per-CLI plugin provisioning", () => {
	it("installs only the CLIs the look found, each its own way, and never asks a missing claude", async () => {
		const c = container({});

		const landed = await provisionPlugins(["copilot", "opencode"], c.run, () => undefined);

		expect(landed).toBe(true);
		expect(c.ran).toEqual([COPILOT?.installed, COPILOT?.install, COPILOT?.installed]);
	});

	it("leaves a CLI already set up, and answers nothing landed", async () => {
		const c = container({ claude: true, copilot: true });

		expect(await provisionPlugins(["claude", "copilot"], c.run, () => undefined)).toBe(false);
		expect(c.ran).toEqual([CLAUDE?.installed, COPILOT?.installed]);
	});

	it("logs an install its own check still refuses, and carries on to the next CLI", async () => {
		const c = container({ copilot: true }, false);
		const logs: string[] = [];

		const landed = await provisionPlugins(["claude", "copilot"], c.run, (line) => logs.push(line));

		expect(landed).toBe(false);
		expect(c.ran).toEqual([CLAUDE?.installed, CLAUDE?.install, CLAUDE?.installed, COPILOT?.installed]);
		expect(logs).toHaveLength(1);
	});
});
