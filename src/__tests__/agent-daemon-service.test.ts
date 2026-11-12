import { describe, expect, it } from "vitest";
import type {
	AgentBackendSession,
	TurnHandle,
	TurnInspection,
	TurnOptions,
	TurnTerminal,
} from "../mcp/agents/backendSession.js";
import { AgentDaemonService } from "../mcp/devcontainer/agentDaemonService.js";
import type { AgentChild, TargetSupervisor } from "../mcp/devcontainer/codexTargets.js";
import { COPILOT_BACKEND } from "../shared/agent-backend.js";

const OWNER_KEY = "recipe-app.work";
const AGENT_ID = "copilot_0123456789abcdef0123456789abcdef";
const TARGET = { kind: "host", targetId: "host", cwd: "/home/agent" } as const;

let minted = 0;
function id(): string {
	minted += 1;
	return `123e4567-e89b-42d3-a456-${String(minted).padStart(12, "0")}`;
}

async function settle(): Promise<void> {
	for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

/** A driver whose turns end when the test says so. */
class FakeSession implements AgentBackendSession {
	turns = new Map<string, (terminal: TurnTerminal) => void>();
	activity: (turnId: string, text: string, itemId?: string) => void = () => {};
	started = 0;
	/** Runs inside `startTurn`, before it answers. */
	duringStart: (turnId: string) => void = () => {};
	steer: (turnId: string) => Promise<void> = async () => {};
	interrupt: () => Promise<void> = async () => {};
	inspect?: (turnId: string) => Promise<TurnInspection>;
	resumable = true;
	/** The key each prompt was posted under. */
	keys: Array<string | undefined> = [];
	steerTurn?: AgentBackendSession["steerTurn"] = (_thread, turnId, _prompt, key) => {
		this.keys.push(key);
		return this.steer(turnId);
	};
	inspectTurn?: AgentBackendSession["inspectTurn"];
	resumeThread?: AgentBackendSession["resumeThread"] = async () => {
		if (!this.resumable) throw new Error("thread is gone");
	};

	openThread = async () => "thread-1";

	async startTurn(_thread: string, _prompt: string, turn?: TurnOptions): Promise<TurnHandle> {
		this.keys.push(turn?.key);
		this.started += 1;
		const turnId = `turn-${this.started}`;
		const settled = new Promise<TurnTerminal>((resolve) => this.turns.set(turnId, resolve));
		this.duringStart(turnId);
		return { turnId, settled };
	}

	interruptTurn = async () => this.interrupt();
	onActivity(listener: (turnId: string, text: string, itemId?: string) => void): void {
		this.activity = listener;
	}
	closed: () => void = () => {};
	onClosed(listener: () => void): void {
		this.closed = listener;
	}
	close(): void {}

	end(turnId: string, terminal: TurnTerminal): void {
		this.turns.get(turnId)?.(terminal);
	}
}

function setup(
	configure: (session: FakeSession) => void = () => {},
	prepareTarget?: (target: { targetId: string }) => Promise<void>,
) {
	const session = new FakeSession();
	configure(session);
	let opened = 0;
	const sent: Record<string, unknown>[] = [];
	const released: Array<[string, number]> = [];
	const targets: TargetSupervisor = {
		acquire: () => ({ state: "running", lease: { generation: 1, child: {} as AgentChild } }),
		release: (targetId, generation) => released.push([targetId, generation]),
	};
	const service = new AgentDaemonService({
		backend: COPILOT_BACKEND,
		targets,
		daemonInstanceId: "daemon-1",
		send: (message) => sent.push(message),
		open: async () => {
			opened += 1;
			return session;
		},
		resolveHostCwd: () => "/home/agent",
		prepareTarget,
	});
	const command = (kind: string, fields: Record<string, unknown> = {}) => {
		const frame: Record<string, unknown> = {
			type: "copilot_command",
			kind,
			requestId: id(),
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			...fields,
		};
		service.handleCommand(frame);
		return frame;
	};
	const start = async () => {
		command("start", { operationId: id(), target: { kind: "host", workdirHint: "agent" }, prompt: "Review" });
		await settle();
	};
	const message = (fields: Record<string, unknown> = {}) =>
		command("message", { operationId: id(), target: TARGET, sessionId: "thread-1", prompt: "And this", ...fields });
	const kinds = () => sent.map((frame) => `${frame.kind}${frame.state ? `:${frame.state}` : ""}`);
	return { session, service, sent, released, command, start, message, kinds, opened: () => opened };
}

describe("the agent daemon service", () => {
	it("announces a turn before what its child said while starting it", async () => {
		const { session, sent, start, kinds } = setup((fake) => {
			fake.duringStart = (turnId) => fake.activity(turnId, "Reading the parser.");
		});
		await start();
		expect(kinds()).toEqual(["accepted", "activity"]);
		expect(sent[1]).toMatchObject({ kind: "activity", turnId: "turn-1", text: "Reading the parser." });

		session.end("turn-1", { status: "completed", finalResponse: "Done." });
		await settle();
		expect(sent.at(-1)).toMatchObject({
			type: "copilot_event",
			kind: "terminal",
			state: "completed",
			sessionId: "thread-1",
			finalResponse: "Done.",
		});
	});

	it("steers the turn the Gateway meant", async () => {
		const { sent, start, message } = setup();
		await start();
		message({ expectedTurnId: "turn-1" });
		await settle();
		expect(sent.at(-1)).toMatchObject({ kind: "accepted", turnId: "turn-1", delivery: "steered" });
	});

	it("refuses a message for a turn the Gateway did not know was running", async () => {
		const { sent, start, message } = setup();
		await start();
		message();
		await settle();
		expect(sent.at(-1)).toMatchObject({ kind: "rejected", error: "Copilot agent is still working" });
	});

	it("opens a new turn with the prompt when its turn ended under the steer", async () => {
		const { session, sent, start, message } = setup((fake) => {
			fake.steer = async (turnId) => {
				fake.end(turnId, { status: "completed", finalResponse: "First." });
				throw new Error("turn is no longer active");
			};
		});
		await start();
		const sentMessage = message({ expectedTurnId: "turn-1" });
		await settle();
		const after = sent.slice(1).map((frame) => [frame.kind, frame.turnId, frame.delivery ?? frame.state]);
		expect(after).toEqual([
			["terminal", "turn-1", "completed"],
			["accepted", "turn-2", "started"],
		]);
		// One prompt, so a driver that can tell posts it once.
		expect(session.keys.slice(1)).toEqual([sentMessage.operationId, sentMessage.operationId]);
	});

	it("answers a failed interrupt as a fenced result", async () => {
		const { sent, start, command } = setup((fake) => {
			fake.interrupt = async () => {
				throw new Error("abort timed out");
			};
		});
		await start();
		command("interrupt", { operationId: id(), target: TARGET, sessionId: "thread-1", turnId: "turn-1" });
		await settle();
		expect(sent.at(-1)).toMatchObject({
			type: "copilot_receipt",
			kind: "interruptResult",
			ok: false,
			error: "abort timed out",
			targetId: "host",
			generation: 1,
		});
	});

	it("reports a running turn, a settled one with its terminal behind it, and one it cannot read", async () => {
		const running = setup();
		await running.start();
		running.command("reconcile", { target: TARGET, sessionId: "thread-1", turnId: "turn-1" });
		await settle();
		expect(running.sent.at(-1)).toMatchObject({ kind: "reconciled", turnId: "turn-1", turnState: "inProgress" });

		const settled = setup((fake) => {
			fake.inspectTurn = async () => ({
				known: "settled",
				terminal: { status: "completed", finalResponse: "Done." },
			});
		});
		settled.command("reconcile", { target: TARGET, sessionId: "thread-9", turnId: "turn-9" });
		await settle();
		expect(settled.kinds()).toEqual(["reconciled", "terminal:completed"]);
		expect(settled.sent[0]).toMatchObject({ turnId: "turn-9", turnState: "completed", resolvedTarget: TARGET });
		expect(settled.sent[1]).toMatchObject({ sessionId: "thread-9", turnId: "turn-9", finalResponse: "Done." });

		const gone = setup((fake) => {
			fake.resumable = false;
		});
		gone.command("reconcile", { target: TARGET, sessionId: "thread-9", turnId: "turn-9" });
		await settle();
		expect(gone.sent).toHaveLength(1);
		expect(gone.sent[0]).toMatchObject({ kind: "reconciled", turnId: "turn-9" });
		expect(gone.sent[0]).not.toHaveProperty("turnState");
	});

	it("refuses a message for a thread that died with its child", async () => {
		const { sent, message } = setup((fake) => {
			fake.resumeThread = undefined;
		});
		message();
		await settle();
		expect(sent.at(-1)).toMatchObject({ kind: "rejected", error: "Copilot agent ended with its process" });
	});

	it("ends a running turn as lost when its driver closes, and gives the target up", async () => {
		const { session, sent, released, start } = setup();
		await start();
		session.closed();
		await settle();
		expect(sent.at(-1)).toMatchObject({ kind: "terminal", turnId: "turn-1", state: "interrupted" });
		expect(released).toEqual([["host", 1]]);
	});

	it("gives up a session whose driver closed before it was held", async () => {
		const { session, sent, released, start } = setup((fake) => {
			// Sticky, as the contract asks: the driver closed while it opened.
			fake.onClosed = (listener) => listener();
		});
		await start();
		expect(session.started).toBe(0);
		expect(sent.at(-1)).toMatchObject({ kind: "rejected" });
		expect(released).toEqual([["host", 1]]);
	});

	it("prepares a target once before its child opens, and refuses with the reason when it cannot", async () => {
		const prepared: string[] = [];
		const ready = setup(undefined, async (target) => {
			prepared.push(target.targetId);
		});
		await ready.start();
		ready.message({ expectedTurnId: "turn-1" });
		await settle();
		expect(prepared).toEqual(["host"]);
		expect(ready.kinds()).toEqual(["accepted", "accepted"]);

		const broken = setup(undefined, async () => {
			throw new Error("runtime could not be copied in");
		});
		await broken.start();
		expect(broken.opened()).toBe(0);
		expect(broken.sent.at(-1)).toMatchObject({ kind: "rejected", error: "runtime could not be copied in" });
	});

	it("refuses commands once it is shutting down", async () => {
		const { service, sent, start } = setup();
		service.shutdown();
		await start();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ kind: "rejected", error: "Copilot daemon is shutting down" });
	});
});
