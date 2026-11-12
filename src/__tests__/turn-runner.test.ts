import { describe, expect, it } from "vitest";
import type {
	AgentBackendSession,
	SteerOutcome,
	TurnHandle,
	TurnInspection,
	TurnTerminal,
} from "../mcp/agents/backendSession.js";
import { NO_PROGRESS_MS, TurnRunner } from "../mcp/agents/turnRunner.js";

const DONE: TurnTerminal = { status: "completed", finalResponse: "done" };

/** A driver whose turns the test starts, settles and speaks for. */
function driver(
	offers: { steer?: boolean; resume?: boolean; inspect?: boolean; adopt?: boolean; life?: boolean } = {},
) {
	const finish = new Map<string, (terminal: TurnTerminal) => void>();
	const state = {
		next: 1,
		startError: undefined as Error | undefined,
		steer: (async () => "taken") as (turnId: string, prompt: string, key?: string) => Promise<SteerOutcome>,
		inspection: { known: "unknown" } as TurnInspection,
		adoptable: undefined as TurnHandle | undefined,
		starts: [] as Array<{ threadId: string; prompt: string; key?: string }>,
		interrupts: [] as string[],
		resumed: [] as string[],
		onActivity: (_turnId: string, _text: string, _itemId?: string) => {},
		onProgress: (_turnId: string) => {},
	};
	const handle = (turnId: string): TurnHandle => ({
		turnId,
		settled: new Promise<TurnTerminal>((resolve) => finish.set(turnId, resolve)),
	});
	const session: AgentBackendSession = {
		openThread: async () => "thread-1",
		startTurn: async (threadId, prompt, turn) => {
			state.starts.push({ threadId, prompt, ...(turn?.key ? { key: turn.key } : {}) });
			if (state.startError) throw state.startError;
			const turnId = `turn-${state.next}`;
			state.next += 1;
			return handle(turnId);
		},
		interruptTurn: async (_threadId, turnId) => {
			state.interrupts.push(turnId);
		},
		onActivity: (listener) => {
			state.onActivity = listener;
		},
		onClosed: () => {},
		close: () => {},
		...(offers.steer === false
			? {}
			: { steerTurn: (_thread, turnId, prompt, key) => state.steer(turnId, prompt, key) }),
		...(offers.resume
			? {
					resumeThread: async (threadId: string) => {
						state.resumed.push(threadId);
					},
				}
			: {}),
		...(offers.inspect ? { inspectTurn: async () => state.inspection } : {}),
		...(offers.adopt ? { adoptTurn: async () => state.adoptable } : {}),
		...(offers.life
			? {
					onProgress: (listener: (turnId: string) => void) => {
						state.onProgress = listener;
					},
				}
			: {}),
	};
	return { session, state, handle, finish: (turnId: string, terminal = DONE) => finish.get(turnId)!(terminal) };
}

function runner(offers: Parameters<typeof driver>[0] = {}) {
	const backend = driver(offers);
	const log: string[] = [];
	let now = 1_000;
	const run = new TurnRunner<string>(backend.session, {
		now: () => now,
		terminal: (turn, terminal) => log.push(`${turn.owner} ${turn.turnId} ${terminal.status}`),
		activity: (turn, text) => log.push(`${turn.owner} ${turn.turnId} says ${text}`),
		counter: (turn, counter) => log.push(`${turn.owner} ${turn.turnId} ran ${counter.kind}`),
		giveUp: (turn) => log.push(`gave up ${turn.turnId}`),
		log: (line) => log.push(line),
	});
	return {
		...backend,
		run,
		log,
		advance: (ms: number) => {
			now += ms;
		},
		begin: (prompt = "go") =>
			run.begin("thread-1", "owner", prompt, { key: "op-1" }, (turnId) => log.push(`accepted ${turnId}`)),
		message: (expectedTurnId: string | undefined, key = "op-2") =>
			run.message("thread-1", "owner", "more", { expectedTurnId, cwd: "/work", key }, (outcome) =>
				log.push(`${outcome.kind} ${outcome.turnId}`),
			),
	};
}

async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("TurnRunner", () => {
	it("tells of a turn before anything its child said of it, then of its end once", async () => {
		const context = runner();
		await context.run.openThread("owner", { cwd: "/work" });
		// The child speaks of the turn it is about to name.
		context.state.onActivity("turn-1", "early");

		await context.begin();
		context.state.onActivity("turn-1", "later");
		context.finish("turn-1");
		await tick();
		context.state.onActivity("turn-1", "after the end");

		expect(context.log).toEqual([
			"accepted turn-1",
			"owner turn-1 says early",
			"owner turn-1 says later",
			"owner turn-1 completed",
		]);
		expect(context.run.activeTurn("thread-1")).toBeUndefined();
	});

	it("adopts the turn a failed start left running, never one it already told of", async () => {
		const context = runner({ adopt: true });
		await context.run.openThread("owner", { cwd: "/work" });
		context.state.startError = new Error("the reply was lost");
		context.state.adoptable = context.handle("turn-9");

		expect(await context.begin()).toBe("turn-9");
		context.finish("turn-9");
		await tick();

		// The same turn offered again is another prompt's.
		await expect(context.begin()).rejects.toThrow("the reply was lost");
		context.state.adoptable = undefined;
		await expect(context.begin()).rejects.toThrow("the reply was lost");
	});

	it("steers the turn its sender names, and no other", async () => {
		const context = runner();
		await context.run.openThread("owner", { cwd: "/work" });
		await context.begin();

		expect(await context.message("turn-1")).toEqual({ kind: "steered", turnId: "turn-1" });
		expect(await context.message("turn-0")).toEqual({ kind: "busy" });
		expect(await context.message(undefined)).toEqual({ kind: "busy" });
		expect(context.state.starts).toHaveLength(1);
	});

	it("refuses a message into a running turn when the driver cannot steer", async () => {
		const context = runner({ steer: false });
		await context.run.openThread("owner", { cwd: "/work" });
		await context.begin();

		expect(await context.message("turn-1")).toEqual({ kind: "busy" });
	});

	it("opens a new turn under the same key when the turn ended under the steer", async () => {
		const context = runner();
		await context.run.openThread("owner", { cwd: "/work" });
		await context.begin();
		context.state.steer = async () => {
			context.finish("turn-1");
		};

		expect(await context.message("turn-1", "op-7")).toEqual({ kind: "started", turnId: "turn-2" });
		expect(context.state.starts.at(-1)).toMatchObject({ prompt: "more", key: "op-7" });
		expect(context.log).toContain("owner turn-1 completed");
	});

	it("reads a refused steer's turn from the driver before blaming the steer", async () => {
		const context = runner({ inspect: true });
		await context.run.openThread("owner", { cwd: "/work" });
		await context.begin();
		context.state.steer = async () => {
			throw new Error("no such turn");
		};

		// Still running: the refusal is the answer.
		await expect(context.message("turn-1")).rejects.toThrow("no such turn");
		// The driver holds its end: the prompt opens a new turn.
		context.state.inspection = { known: "settled", terminal: DONE };
		expect(await context.message("turn-1")).toEqual({ kind: "started", turnId: "turn-2" });
		expect(context.log).toContain("owner turn-1 completed");
	});

	it("resumes a thread it does not hold, or says the thread ended with its process", async () => {
		const gone = runner();
		expect(await gone.message(undefined)).toEqual({ kind: "ended" });

		const context = runner({ resume: true });
		expect(await context.message(undefined)).toEqual({ kind: "started", turnId: "turn-1" });
		expect(context.state.resumed).toEqual(["thread-1"]);
		context.finish("turn-1");
		await tick();
		// Held from then on.
		await context.message(undefined);
		expect(context.state.resumed).toEqual(["thread-1"]);
	});

	it("interrupts only the turn that is running", async () => {
		const context = runner();
		await context.run.openThread("owner", { cwd: "/work" });
		await context.begin();

		expect(await context.run.interrupt("thread-1", "turn-0")).toBe(false);
		expect(await context.run.interrupt("thread-1", "turn-1")).toBe(true);
		expect(context.state.interrupts).toEqual(["turn-1"]);
	});

	it("reads a silent turn, interrupts it once, then gives it up", async () => {
		const context = runner({ life: true, inspect: true });
		await context.run.openThread("owner", { cwd: "/work" });
		await context.begin();
		const watch = () => context.run.watch(() => true);

		context.advance(NO_PROGRESS_MS - 1);
		await watch();
		expect(context.state.interrupts).toEqual([]);

		context.advance(1);
		await watch();
		expect(context.state.interrupts).toEqual(["turn-1"]);
		// A sign of life starts the count over.
		context.advance(NO_PROGRESS_MS - 1);
		context.state.onProgress("turn-1");
		context.advance(NO_PROGRESS_MS - 1);
		await watch();
		expect(context.log).not.toContain("gave up turn-1");

		context.advance(1);
		await watch();
		expect(context.state.interrupts).toEqual(["turn-1", "turn-1"]);
		context.advance(NO_PROGRESS_MS);
		await watch();
		expect(context.log).toContain("gave up turn-1");
	});

	it("publishes a silent turn the driver already ended, and watches nothing for a driver that reports no life", async () => {
		const context = runner({ life: true, inspect: true });
		await context.run.openThread("owner", { cwd: "/work" });
		await context.begin();
		context.state.inspection = { known: "settled", terminal: DONE };
		context.advance(NO_PROGRESS_MS);
		await context.run.watch(() => true);
		expect(context.log).toContain("owner turn-1 completed");
		expect(context.state.interrupts).toEqual([]);

		const quiet = runner({ inspect: true });
		await quiet.run.openThread("owner", { cwd: "/work" });
		await quiet.begin();
		quiet.advance(NO_PROGRESS_MS * 3);
		await quiet.run.watch(() => true);
		expect(quiet.state.interrupts).toEqual([]);
	});

	it("tells a turn's new owner after a handover", async () => {
		const context = runner();
		await context.run.openThread("owner", { cwd: "/work" });
		await context.begin();

		context.run.activeTurn("thread-1")!.owner = "heir";
		context.finish("turn-1");
		await tick();

		expect(context.log).toContain("heir turn-1 completed");
	});
});
