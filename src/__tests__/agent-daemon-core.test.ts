import { describe, expect, it, vi } from "vitest";
import { AgentDaemonCore, type AgentDaemonSession } from "../mcp/devcontainer/agentDaemonCore.js";
import type { AgentChild, TargetSupervisor } from "../mcp/devcontainer/agentTargets.js";
import type { AgentResolvedTarget } from "../shared/agent-execution-target.js";
import { agentWire } from "../shared/agent-wire.js";

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
			daemon.sendOperationAnswer(command.operationId, answer);
		};
		const reject = () => {};

		daemon.enqueue(command, dispatch, reject, String);
		daemon.enqueue({ ...command }, dispatch, reject, String);
		await Promise.resolve();
		expect(dispatched).toBe(1);
		resolve();
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		daemon.sendOperationAnswer(command.operationId, { kind: "late", operationId: command.operationId });
		daemon.enqueue({ ...command }, dispatch, reject, String);
		await vi.waitFor(() => expect(sent).toHaveLength(3));
		expect(sent[1]).toEqual({ kind: "late", operationId: command.operationId });
		expect(sent[2]).toEqual({ kind: "accepted", operationId: command.operationId });
		expect(dispatched).toBe(1);
	});

	it("sends but does not retain an answer while an operation is stopped", async () => {
		const sent: Record<string, unknown>[] = [];
		const daemon = new AgentDaemonCore({
			backendId: "codex",
			daemonInstanceId: "daemon-1",
			targets: {} as TargetSupervisor,
			send: (message) => sent.push(message),
			isReliable: () => false,
		});
		const command = { ownerKey: "owner", agentId: "agent", operationId: "operation-stopped" };
		daemon.sendOperationAnswer(command.operationId, { kind: "rejected", operationId: command.operationId });
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

		expect(sent).toEqual([{ kind: "rejected", operationId: command.operationId }]);
	});

	it("terminalizes bound work before removing and closing a retired session", async () => {
		const order: string[] = [];
		const session: AgentDaemonSession = {
			targetId: "container:recipe-app",
			generation: 1,
			nextEventId: 0,
			client: {
				close: () => {
					order.push("close");
				},
			},
		};
		let daemon!: AgentDaemonCore<AgentDaemonSession>;
		daemon = new AgentDaemonCore({
			backendId: "codex",
			daemonInstanceId: "daemon-1",
			targets: {
				acquire: () => ({ state: "running", lease: { generation: 1, child: {} as AgentChild } }),
				release: () => {},
			} as TargetSupervisor,
			send: () => {},
			isReliable: () => false,
			retiredTurnTerminalizers: (current) => [(reason) => order.push(`turn ${reason} ${daemon.live(current)}`)],
			onRetire: (current) => order.push(`cleanup ${daemon.live(current)}`),
		});
		await daemon.acquireSession(
			{
				kind: "devcontainer",
				targetId: "container:recipe-app",
				cwd: "/workspace/recipe-app",
			} as AgentResolvedTarget,
			async () => session,
		);

		daemon.retire(session);

		expect(order).toEqual(["turn turn lost: its agent process ended true", "cleanup true", "close"]);
		expect(daemon.live(session)).toBe(false);
	});

	it("names in its hello the stream whose outbox dropped frames nobody acknowledged", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const session: AgentDaemonSession = {
			targetId: "container:recipe-app",
			generation: 3,
			nextEventId: 0,
			client: { close: () => {} },
		};
		const daemon = new AgentDaemonCore({
			backendId: "codex",
			daemonInstanceId: "daemon-1",
			targets: {
				acquire: () => ({ state: "running", lease: { generation: 3, child: {} as AgentChild } }),
				release: () => {},
			} as TargetSupervisor,
			send: () => {},
			isReliable: () => true,
			helloSchema: agentWire("codex").hello,
		});
		await daemon.acquireSession(
			{ kind: "devcontainer", targetId: session.targetId, cwd: "/workspace/recipe-app" } as AgentResolvedTarget,
			async () => session,
		);
		const anything = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };
		const publish = (count: number) => {
			for (let sent = 0; sent < count; sent += 1) daemon.publish(session, { kind: "terminal" }, anything);
		};

		publish(1_000);
		expect(daemon.hello()).not.toHaveProperty("evicted");

		publish(2);
		expect(daemon.hello()).toMatchObject({
			evicted: [{ targetId: session.targetId, generation: 3, count: 2 }],
		});
	});
});
