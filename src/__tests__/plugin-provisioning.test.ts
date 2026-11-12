import { describe, expect, it } from "vitest";
import { createProvisionLedger, provisionPlugins } from "../mcp/devcontainer/pluginProvisioning.js";
import { HARNESS, type SessionHarness } from "../shared/session-harness.js";

const CLAUDE = HARNESS.claude.plugins;
const COPILOT = HARNESS.copilot.plugins;

/** An install lands while `takes`. */
function container(setUp: Partial<Record<SessionHarness, boolean>>, installs = { takes: true }) {
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
			if (installs.takes) setUp[harness] = true;
			return installs.takes;
		}
		return setUp[harness] === true;
	};
	return { run, ran };
}

describe("per-CLI plugin provisioning", () => {
	it("installs only the CLIs the look found, each its own way, and never asks a missing claude", async () => {
		const c = container({});

		const { landed, ready } = await provisionPlugins(["copilot", "opencode"], c.run, () => undefined);

		expect([landed, ready]).toEqual([true, ["copilot", "opencode"]]);
		expect(c.ran).toEqual([COPILOT?.installed, COPILOT?.install, COPILOT?.installed]);
	});

	it("leaves a CLI already set up, and answers nothing landed", async () => {
		const c = container({ claude: true, copilot: true });

		expect(await provisionPlugins(["claude", "copilot"], c.run, () => undefined)).toEqual({
			landed: false,
			ready: ["claude", "copilot"],
		});
		expect(c.ran).toEqual([CLAUDE?.installed, COPILOT?.installed]);
	});

	it("logs an install its own check still refuses, and carries on to the next CLI", async () => {
		const c = container({ copilot: true }, { takes: false });
		const logs: string[] = [];

		const { landed, ready } = await provisionPlugins(["claude", "copilot"], c.run, (line) => logs.push(line));

		expect([landed, ready]).toEqual([false, ["copilot"]]);
		expect(c.ran).toEqual([CLAUDE?.installed, CLAUDE?.install, CLAUDE?.installed, COPILOT?.installed]);
		expect(logs).toHaveLength(1);
	});

	it("retries a failed install and a CLI found later on the next bring, and keeps each success per container", async () => {
		const ledger = createProvisionLedger();
		const installs = { takes: false };
		const c = container({}, installs);
		const bring = async (id: string, found: SessionHarness[]) => {
			const pending = ledger.pending("app", id, found);
			const { ready } = await provisionPlugins(pending, c.run, () => undefined);
			ledger.settled("app", id, ready);
			return pending;
		};

		expect(await bring("c1", ["claude"])).toEqual(["claude"]);
		installs.takes = true;
		expect(await bring("c1", ["claude", "copilot"])).toEqual(["claude", "copilot"]);
		expect(await bring("c1", ["claude", "copilot"])).toEqual([]);
		expect(await bring("c2", ["claude"])).toEqual(["claude"]);
	});
});
