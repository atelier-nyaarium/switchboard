import { describe, expect, it } from "vitest";
import type {
	AgentBackendSession,
	TurnHandle,
	TurnInspection,
	TurnOptions,
	TurnTerminal,
} from "../mcp/agents/backendSession.js";
import { AgentDaemonService } from "../mcp/devcontainer/agentDaemonService.js";
import type { AgentChild, TargetSupervisor } from "../mcp/devcontainer/agentTargets.js";
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
	adoptTurn?: AgentBackendSession["adoptTurn"];
	onProgress?: AgentBackendSession["onProgress"];
	busy?: AgentBackendSession["busy"];
	listModels?: AgentBackendSession["listModels"];
	resumed: string[] = [];
	interrupts = 0;
	failStart?: Error;
	resumeThread?: AgentBackendSession["resumeThread"] = async (threadId) => {
		if (!this.resumable) throw new Error("thread is gone");
		this.resumed.push(threadId);
	};

	openThread = async () => "thread-1";

	async startTurn(_thread: string, _prompt: string, turn?: TurnOptions): Promise<TurnHandle> {
		if (this.failStart) throw this.failStart;
		this.keys.push(turn?.key);
		this.started += 1;
		return this.running(`turn-${this.started}`);
	}

	running(turnId: string): TurnHandle {
		const settled = new Promise<TurnTerminal>((resolve) => this.turns.set(turnId, resolve));
		this.duringStart(turnId);
		return { turnId, settled };
	}

	interruptTurn = async () => {
		this.interrupts += 1;
		return this.interrupt();
	};
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

const TEN_MINUTES = 600_000;

function setup(
	configure: (session: FakeSession) => void = () => {},
	prepareTarget?: (target: { targetId: string }) => Promise<void>,
	threadsResumable = false,
) {
	const session = new FakeSession();
	configure(session);
	let opened = 0;
	let now = 1_000_000;
	let runSweep: () => void = () => {};
	const sent: Record<string, unknown>[] = [];
	const released: Array<[string, number]> = [];
	const targets: TargetSupervisor = {
		acquire: () => ({ state: "running", lease: { generation: released.length + 1, child: {} as AgentChild } }),
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
		threadsResumable,
		now: () => now,
		setSweep: (run) => {
			runSweep = run;
			return 0 as unknown as ReturnType<typeof setInterval>;
		},
		clearSweep: () => {},
	});
	const sweepAfter = async (ms: number) => {
		now += ms;
		runSweep();
		await settle();
	};
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
	return { session, service, sent, released, command, start, message, kinds, sweepAfter, opened: () => opened };
}

function reportingLife(fake: FakeSession): { alive(turnId: string): void } {
	let listener: (turnId: string) => void = () => {};
	fake.onProgress = (next) => {
		listener = next;
	};
	return { alive: (turnId) => listener(turnId) };
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

	it("opens a new turn after a refused steer when its driver reads the turn as ended, and refuses when it still runs", async () => {
		const ended = setup((fake) => {
			fake.steer = async () => {
				throw new Error("turn is no longer active");
			};
			fake.inspectTurn = async () => ({
				known: "settled",
				terminal: { status: "completed", finalResponse: "First." },
			});
		});
		await ended.start();
		ended.message({ expectedTurnId: "turn-1" });
		await settle();
		expect(ended.sent.slice(1).map((frame) => [frame.kind, frame.turnId, frame.delivery ?? frame.state])).toEqual([
			["terminal", "turn-1", "completed"],
			["accepted", "turn-2", "started"],
		]);
		// Late terminal stays unique.
		ended.session.end("turn-1", { status: "completed", finalResponse: "First." });
		await settle();
		expect(ended.kinds().filter((kind) => kind.startsWith("terminal"))).toEqual(["terminal:completed"]);

		const running = setup((fake) => {
			fake.steer = async () => {
				throw new Error("steer refused");
			};
			fake.inspectTurn = async () => ({ known: "running" });
		});
		await running.start();
		running.message({ expectedTurnId: "turn-1" });
		await settle();
		expect(running.sent.at(-1)).toMatchObject({ kind: "rejected" });
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

		// A driver that cannot inspect: the turn's end is the runner's to tell.
		const ended = setup();
		await ended.start();
		ended.session.end("turn-1", { status: "completed", finalResponse: "Done." });
		await settle();
		ended.sent.length = 0;
		ended.command("reconcile", { target: TARGET, sessionId: "thread-1", turnId: "turn-1" });
		await settle();
		expect(ended.kinds()).toEqual(["reconciled", "terminal:completed"]);
		expect(ended.sent[0]).toMatchObject({ turnId: "turn-1", turnState: "completed" });

		const gone = setup((fake) => {
			fake.resumable = false;
		});
		gone.command("reconcile", { target: TARGET, sessionId: "thread-9", turnId: "turn-9" });
		await settle();
		expect(gone.sent).toHaveLength(1);
		expect(gone.sent[0]).toMatchObject({ kind: "reconciled", turnId: "turn-9" });
		expect(gone.sent[0]).not.toHaveProperty("turnState");
	});

	it("settles an earlier turn it is asked about while the thread runs a later one", async () => {
		const { sent, start, command, kinds } = setup((fake) => {
			fake.inspectTurn = async (_thread, turnId) =>
				turnId === "turn-0"
					? { known: "settled", terminal: { status: "completed", finalResponse: "Earlier." } }
					: { known: "running" };
		});
		await start();
		command("reconcile", { target: TARGET, sessionId: "thread-1", turnId: "turn-0" });
		await settle();
		expect(kinds()).toEqual(["accepted", "reconciled", "terminal:completed"]);
		expect(sent[1]).toMatchObject({ turnId: "turn-0", turnState: "completed" });
		expect(sent[2]).toMatchObject({ turnId: "turn-0", finalResponse: "Earlier." });

		command("reconcile", { target: TARGET, sessionId: "thread-1", turnId: "turn-1" });
		await settle();
		expect(sent.at(-1)).toMatchObject({ kind: "reconciled", turnId: "turn-1", turnState: "inProgress" });
	});

	it("keeps a running thread through a flood of others, and reopens an idle one it forgot", async () => {
		const { session, sent, start, message, command, kinds } = setup();
		const answered = () => sent.filter((frame) => frame.kind === "reconciled").length;
		const flood = async (label: string) => {
			const before = answered();
			for (let index = 0; index < 270; index += 1)
				command("reconcile", { target: TARGET, sessionId: `${label}-${index}` });
			while (answered() < before + 270) await new Promise((resolve) => setTimeout(resolve, 0));
		};
		await start();
		await flood("busy");
		session.end("turn-1", { status: "completed", finalResponse: "Done." });
		await settle();
		expect(sent.at(-1)).toMatchObject({ kind: "terminal", sessionId: "thread-1", turnId: "turn-1" });
		expect(session.resumed).not.toContain("thread-1");

		await flood("idle");
		message();
		await settle();
		expect(session.resumed).toContain("thread-1");
		expect(kinds().at(-1)).toBe("accepted");
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

	it("interrupts a turn silent for ten minutes, then gives its child up when it stays silent", async () => {
		let life!: ReturnType<typeof reportingLife>;
		const { session, sent, released, start, sweepAfter } = setup((fake) => {
			life = reportingLife(fake);
		});
		await start();

		await sweepAfter(TEN_MINUTES - 1);
		expect(session.interrupts).toBe(0);
		life.alive("turn-1");
		await sweepAfter(TEN_MINUTES - 1);
		expect(session.interrupts).toBe(0);

		await sweepAfter(1);
		expect(session.interrupts).toBe(1);
		expect(released).toEqual([]);

		await sweepAfter(TEN_MINUTES);
		expect(sent.at(-1)).toMatchObject({ kind: "terminal", turnId: "turn-1", state: "interrupted" });
		expect(released).toEqual([["host", 1]]);
	});

	it("publishes a silent turn its driver reads as settled, and never judges a driver that reports no life", async () => {
		const read = setup((fake) => {
			reportingLife(fake);
			fake.inspectTurn = async () => ({
				known: "settled",
				terminal: { status: "completed", finalResponse: "Done." },
			});
		});
		await read.start();
		await read.sweepAfter(TEN_MINUTES);
		expect(read.sent.at(-1)).toMatchObject({ kind: "terminal", state: "completed", finalResponse: "Done." });
		expect(read.session.interrupts).toBe(0);
		// Late end publishes nothing.
		read.session.end("turn-1", { status: "completed", finalResponse: "Late." });
		await settle();
		expect(read.kinds()).toEqual(["accepted", "terminal:completed"]);

		const mute = setup();
		await mute.start();
		await mute.sweepAfter(TEN_MINUTES * 3);
		expect(mute.session.interrupts).toBe(0);
		expect(mute.kinds()).toEqual(["accepted"]);
	});

	it("reaps an idle child whose threads reopen, and reopens the thread on the next message", async () => {
		const { session, released, start, message, sweepAfter, kinds, opened } = setup(undefined, undefined, true);
		await start();
		await sweepAfter(TEN_MINUTES * 2);
		expect(released).toEqual([]);

		session.end("turn-1", { status: "completed", finalResponse: "Done." });
		await settle();
		session.busy = () => true;
		await sweepAfter(TEN_MINUTES);
		expect(released).toEqual([]);
		session.busy = () => false;
		await sweepAfter(1);
		expect(released).toEqual([["host", 1]]);

		message();
		await settle();
		expect(opened()).toBe(2);
		expect(session.resumed).toEqual(["thread-1"]);
		expect(kinds().at(-1)).toBe("accepted");
	});

	it("keeps an idle child whose threads would die with it", async () => {
		const { session, released, start, sweepAfter } = setup();
		await start();
		session.end("turn-1", { status: "completed", finalResponse: "Done." });
		await settle();
		await sweepAfter(TEN_MINUTES * 2);
		expect(released).toEqual([]);
	});

	it("takes the turn found running when its start failed, and refuses when none runs", async () => {
		const adopted = setup((fake) => {
			fake.failStart = new Error("turn/start timed out");
			fake.adoptTurn = async () => fake.running("turn-7");
		});
		await adopted.start();
		expect(adopted.sent.at(-1)).toMatchObject({ kind: "accepted", turnId: "turn-7", delivery: "started" });
		adopted.session.end("turn-7", { status: "completed", finalResponse: "Done." });
		await settle();
		expect(adopted.kinds()).toEqual(["accepted", "terminal:completed"]);

		const none = setup((fake) => {
			fake.failStart = new Error("turn/start timed out");
			fake.adoptTurn = async () => undefined;
		});
		await none.start();
		expect(none.sent.at(-1)).toMatchObject({ kind: "rejected", error: "turn/start timed out" });
	});

	it("holds a turn found running at reconcile on a thread it knew, and only reports one on a thread it did not", async () => {
		const knew = setup((fake) => {
			fake.inspectTurn = async () => ({ known: "running" });
			fake.adoptTurn = async () => fake.running("turn-9");
		});
		await knew.start();
		knew.session.end("turn-1", { status: "completed", finalResponse: "Done." });
		await settle();
		knew.command("reconcile", { target: TARGET, sessionId: "thread-1", turnId: "turn-9" });
		await settle();
		expect(knew.sent.at(-1)).toMatchObject({ kind: "reconciled", turnId: "turn-9", turnState: "inProgress" });
		knew.session.end("turn-9", { status: "interrupted" });
		await settle();
		expect(knew.sent.at(-1)).toMatchObject({ kind: "terminal", turnId: "turn-9", state: "interrupted" });

		const fresh = setup((fake) => {
			fake.inspectTurn = async () => ({ known: "running" });
			fake.adoptTurn = async () => fake.running("turn-9");
		});
		fresh.command("reconcile", { target: TARGET, sessionId: "thread-9", turnId: "turn-9" });
		await settle();
		expect(fresh.sent).toHaveLength(1);
		expect(fresh.sent[0]).not.toHaveProperty("turnState");
	});

	it("publishes a running turn under the owner its last reconcile named", async () => {
		const { session, sent, start, command } = setup();
		await start();
		command("reconcile", { ownerKey: "recipe-app.moved", target: TARGET, sessionId: "thread-1", turnId: "turn-1" });
		await settle();
		expect(sent.at(-1)).toMatchObject({ kind: "reconciled", turnId: "turn-1", turnState: "inProgress" });

		session.end("turn-1", { status: "completed", finalResponse: "Done." });
		await settle();
		expect(sent.at(-1)).toMatchObject({ kind: "terminal", turnId: "turn-1", ownerKey: "recipe-app.moved" });
	});

	it("lists the models its driver reads on a target, and says why when it cannot", async () => {
		const listed = setup((fake) => {
			fake.listModels = async () => [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }];
		});
		expect(await listed.service.listModels({ kind: "host", workdirHint: "agent" })).toEqual({
			kind: "listed",
			models: ["gpt-6-luna", "gpt-6.1-sol"],
		});

		const mute = setup();
		expect(await mute.service.listModels({ kind: "host", workdirHint: "agent" })).toMatchObject({
			kind: "refused",
		});

		const broken = setup((fake) => {
			fake.listModels = async () => {
				throw new Error("model/list timed out");
			};
		});
		expect(await broken.service.listModels({ kind: "host", workdirHint: "agent" })).toEqual({
			kind: "refused",
			reason: "model/list timed out",
		});
	});

	it("shares one model read per target, and gives up a child it opened only to list", async () => {
		let reads = 0;
		const { service, released, start } = setup((fake) => {
			fake.listModels = async () => {
				reads += 1;
				await settle();
				return [{ id: "gpt-6-luna" }];
			};
		});
		const target = { kind: "host", workdirHint: "agent" } as const;
		const [first, second] = await Promise.all([service.listModels(target), service.listModels(target)]);
		expect(second).toEqual(first);
		expect(reads).toBe(1);
		expect(released).toHaveLength(1);

		await start();
		await service.listModels(target);
		expect(released).toHaveLength(1);
	});

	it("refuses commands once it is shutting down", async () => {
		const { service, sent, start } = setup();
		service.shutdown();
		await start();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ kind: "rejected", error: "Copilot daemon is shutting down" });
	});
});
