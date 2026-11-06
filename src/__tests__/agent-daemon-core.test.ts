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

	it("drops an in-flight operation replay and resends its held answer", async () => {
		const sent: Record<string, unknown>[] = [];
		const daemon = new AgentDaemonCore({
			backendId: "codex",
			daemonInstanceId: "daemon-1",
			targets: {} as TargetSupervisor,
			send: (message) => sent.push(message),
			isReliable: () => false,
		});
		const command = { ownerKey: "owner", agentId: "agent", operationId: "operation-1" };
		let resolve!: () => void;
		const held = new Promise<void>((done) => {
			resolve = done;
		});
		let dispatched = 0;
		const dispatch = async () => {
			dispatched += 1;
			await held;
			const answer = { kind: "accepted", operationId: command.operationId };
			daemon.rememberOperationAnswer(command.operationId, answer);
			sent.push(answer);
		};
		const reject = () => {};

		daemon.enqueue(command, dispatch, reject, String);
		daemon.enqueue({ ...command }, dispatch, reject, String);
		await Promise.resolve();
		expect(dispatched).toBe(1);
		resolve();
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		daemon.rememberOperationAnswer(command.operationId, { kind: "late", operationId: command.operationId });
		daemon.enqueue({ ...command }, dispatch, reject, String);
		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent[1]).toEqual({ kind: "accepted", operationId: command.operationId });
		expect(dispatched).toBe(1);
	});

	it("does not replay an answer recorded while an operation is stopped", async () => {
		const sent: Record<string, unknown>[] = [];
		const daemon = new AgentDaemonCore({
			backendId: "codex",
			daemonInstanceId: "daemon-1",
			targets: {} as TargetSupervisor,
			send: (message) => sent.push(message),
			isReliable: () => false,
		});
		const command = { ownerKey: "owner", agentId: "agent", operationId: "operation-stopped" };
		daemon.rememberOperationAnswer(command.operationId, { kind: "rejected", operationId: command.operationId });
		let dispatched = false;

		daemon.enqueue(
			command,
			async () => {
				dispatched = true;
			},
			() => {},
			String,
		);
		await vi.waitFor(() => expect(dispatched).toBe(true));

		expect(sent).toEqual([]);
	});
});
