import { describe, expect, it, vi } from "vitest";
import { AgentDaemonCore } from "../mcp/devcontainer/agentDaemonCore.js";
import type { TargetSupervisor } from "../mcp/devcontainer/codexTargets.js";

const core = () =>
	new AgentDaemonCore({
		backendId: "codex",
		daemonInstanceId: "daemon-1",
		targets: {} as TargetSupervisor,
		send: () => {},
		isReliable: () => false,
	});

describe("agent daemon commands", () => {
	it("rejects a failed command, then dispatches the agent's next one even when the rejection threw", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const daemon = core();
		const log: string[] = [];
		const command = (id: string) => ({ ownerKey: "owner", agentId: "agent", id });

		daemon.enqueue(
			command("first"),
			async () => {
				throw new Error("refused");
			},
			({ id }, error) => {
				log.push(`reject ${id}: ${error}`);
				throw new Error("the rejection could not be sent");
			},
			(error) => (error as Error).message,
		);
		daemon.enqueue(
			command("second"),
			async ({ id }) => {
				log.push(`dispatch ${id}`);
			},
			() => {},
			String,
		);

		await vi.waitFor(() => expect(log).toEqual(["reject first: refused", "dispatch second"]));
	});
});
