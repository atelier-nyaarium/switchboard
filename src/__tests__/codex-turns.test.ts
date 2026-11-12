import { describe, expect, it } from "vitest";
import type { ReadOutcome, TerminalOutcome } from "../mcp/devcontainer/codexTurnOutcome.js";
import { CodexTurns } from "../mcp/devcontainer/codexTurns.js";

const threadId = "thread-1";
const turnId = "turn-1";

function item(text: string, phase?: string, turn = turnId, thread = threadId) {
	return {
		method: "item/completed",
		params: { threadId: thread, turnId: turn, item: { type: "agentMessage", id: text, text, phase } },
	};
}

function terminal(status: "completed" | "failed" | "interrupted" = "completed", error?: string) {
	return {
		method: "turn/completed",
		params: { threadId, turn: { id: turnId, status, error: error ? { message: error } : null } },
	};
}

function setup() {
	const state = {
		read: { known: "unknown" } as ReadOutcome,
		/** A read that answers when the test says. */
		slowRead: undefined as Promise<ReadOutcome> | undefined,
		reads: 0,
		submitted: [] as Array<{ turnId: string; terminal: TerminalOutcome }>,
		commentary: [] as string[],
		counters: [] as Array<{ kind: string; filesChanged?: number }>,
		deadlines: [] as Array<() => void>,
		cleared: 0,
	};
	const turns = new CodexTurns({
		read: async () => {
			state.reads += 1;
			return state.slowRead ?? state.read;
		},
		submit: (_threadId, id, ended) => state.submitted.push({ turnId: id, terminal: ended }),
		setTimer: (run) => {
			state.deadlines.push(run);
			return run as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (timer) => {
			state.cleared += 1;
			state.deadlines = state.deadlines.filter((run) => run !== (timer as unknown));
		},
		onCommentary: (said) => state.commentary.push(said.text),
		onCounter: (counted) => state.counters.push(counted),
	});
	return {
		turns,
		state,
		deadline: async () => {
			const run = state.deadlines.shift();
			if (!run) throw new Error("no deadline is armed");
			run();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		},
	};
}

describe("CodexTurns", () => {
	it("counts completed tool items once each, a file change as one changed file", () => {
		const { turns, state } = setup();
		for (const [id, type] of [
			["shell", "commandExecution"],
			["edit", "fileChange"],
			["read", "fileRead"],
			["read", "fileRead"],
		]) {
			turns.accept({ method: "item/completed", params: { threadId, turnId, item: { id, type } } });
		}
		expect(state.counters).toEqual([
			{ threadId, turnId, itemId: "shell", kind: "shell" },
			{ threadId, turnId, itemId: "edit", kind: "edit", filesChanged: 1 },
			{ threadId, turnId, itemId: "read", kind: "read" },
		]);
	});

	it("ends a turn on its final answer, over later unphased text and never on commentary", async () => {
		const { turns, state } = setup();
		const ended = turns.register(threadId, turnId);
		turns.accept(item("thinking", "commentary"));
		turns.accept(item("answer", "final_answer"));
		turns.accept(item("trailing"));

		expect(turns.accept(terminal())).toEqual({ turnId, status: "completed" });

		expect(await ended).toEqual({ status: "completed", finalResponse: "answer" });
		expect(state.commentary).toEqual(["thinking"]);
		expect(state.submitted).toEqual([{ turnId, terminal: { status: "completed", finalResponse: "answer" } }]);
	});

	it("holds a completed turn for its final item, and commentary does not release it", async () => {
		const { turns, state } = setup();
		const ended = turns.register(threadId, turnId);

		expect(turns.accept(terminal())).toBeNull();
		expect(turns.accept(item("still working", "commentary"))).toBeNull();
		expect(turns.accept(item("answer", "final_answer"))).toEqual({ turnId, status: "completed" });

		expect(await ended).toMatchObject({ finalResponse: "answer" });
		expect(state.deadlines).toEqual([]);
	});

	it("ends a held turn on an answer that lands while its deadline read is out", async () => {
		const { turns, state, deadline } = setup();
		const ended = turns.register(threadId, turnId);
		turns.accept(terminal());
		let answerRead: (outcome: ReadOutcome) => void = () => {};
		state.slowRead = new Promise<ReadOutcome>((resolve) => {
			answerRead = resolve;
		});
		await deadline();

		turns.accept(item("answer", "final_answer"));
		answerRead({ known: "settled", outcome: { status: "failed", error: "a late read" } });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(await ended).toEqual({ status: "completed", finalResponse: "answer" });
		expect(state.submitted).toHaveLength(1);
	});

	it("reads the thread at a held turn's deadline, and ends on what the read holds", async () => {
		const { turns, state, deadline } = setup();
		const ended = turns.register(threadId, turnId);
		turns.accept(terminal());
		state.read = { known: "settled", outcome: { status: "completed", finalResponse: "from the read" } };

		await deadline();

		expect(await ended).toEqual({ status: "completed", finalResponse: "from the read" });
	});

	it("ends a held turn without an answer when its thread cannot be read", async () => {
		const { turns, deadline } = setup();
		const ended = turns.register(threadId, turnId);
		turns.accept(item("working", "commentary"));
		turns.accept(terminal());

		await deadline();

		expect(await ended).toEqual({ status: "completed", finalResponse: undefined });
	});

	it("arms another deadline while the read says running, and ends on what it saw at the third", async () => {
		const { turns, state, deadline } = setup();
		const ended = turns.register(threadId, turnId);
		let answered: TerminalOutcome | undefined;
		void ended.then((value) => {
			answered = value;
		});
		turns.accept(terminal());
		state.read = { known: "running" };

		await deadline();
		await deadline();
		expect(answered).toBeUndefined();
		expect(state.deadlines).toHaveLength(1);

		await deadline();
		expect(answered).toEqual({ status: "completed", finalResponse: undefined });
		expect(state.reads).toBe(3);
	});

	it("inspects a held turn as running until its first deadline, then ends it on an answerless read", async () => {
		const { turns, state, deadline } = setup();
		const ended = turns.register(threadId, turnId);
		turns.accept(terminal());
		const answerless: ReadOutcome = { known: "settled", outcome: { status: "completed" } };

		state.read = answerless;
		expect(await turns.inspect(threadId, turnId)).toEqual({ known: "running" });

		state.read = { known: "running" };
		await deadline();
		state.read = answerless;
		expect(await turns.inspect(threadId, turnId)).toEqual(answerless);
		expect(await ended).toEqual({ status: "completed" });
		expect(state.deadlines).toEqual([]);
	});

	it("ends a running turn on a settled inspect, and passes on what a read cannot say", async () => {
		const { turns, state } = setup();
		const ended = turns.register(threadId, turnId);

		state.read = { known: "running" };
		expect(await turns.inspect(threadId, turnId)).toEqual({ known: "running" });
		state.read = { known: "unknown" };
		expect(await turns.inspect(threadId, turnId)).toEqual({ known: "unknown" });

		state.read = { known: "settled", outcome: { status: "completed", finalResponse: "done" } };
		expect(await turns.inspect(threadId, turnId)).toEqual(state.read);
		expect(await ended).toEqual({ status: "completed", finalResponse: "done" });
		expect(turns.accept(terminal("failed", "late"))).toBeNull();
		expect(state.submitted).toHaveLength(1);
	});

	it("remembers a turn nobody registered once an inspect or its thread's owner ends it", async () => {
		const { turns, state } = setup();
		state.read = { known: "settled", outcome: { status: "completed", finalResponse: "read" } };
		await turns.inspect(threadId, turnId);
		expect(state.submitted).toEqual([{ turnId, terminal: { status: "completed", finalResponse: "read" } }]);
		expect(await turns.register(threadId, turnId)).toEqual({ status: "completed", finalResponse: "read" });
		expect(turns.accept(terminal("failed", "late"))).toBeNull();

		turns.published(threadId, "turn-2", { status: "interrupted" });
		expect(await turns.register(threadId, "turn-2")).toEqual({ status: "interrupted" });
	});

	it("ends a failed turn with its cleaned error and an interrupted one with no answer", async () => {
		const failed = setup();
		const failure = failed.turns.register(threadId, turnId);
		failed.turns.accept(terminal("failed", "model\0refused\u001b[31m"));
		expect(await failure).toMatchObject({ status: "failed", error: expect.not.stringContaining("\0") });

		const interrupted = setup();
		const stopped = interrupted.turns.register(threadId, turnId);
		interrupted.turns.accept(item("partial", "final_answer"));
		interrupted.turns.accept(terminal("interrupted"));
		expect(await stopped).toEqual({ status: "interrupted" });
	});

	it("ignores deltas, other turns, another thread's use of the turn, and a repeated terminal", async () => {
		const { turns } = setup();
		const ended = turns.register(threadId, turnId);
		turns.accept({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "partial" } });
		turns.accept(item("other turn", "final_answer", "turn-2"));
		turns.accept(item("answer", "final_answer"));
		turns.accept(item("other thread", "final_answer", turnId, "thread-2"));

		turns.accept(terminal());

		expect(await ended).toMatchObject({ finalResponse: "answer" });
		expect(turns.accept(terminal("failed", "duplicate"))).toBeNull();
	});

	it("stops passing commentary on past the item bound", () => {
		const { turns, state } = setup();
		for (let index = 0; index < 40; index += 1) turns.accept(item(`note-${index}`, "commentary"));
		expect(state.commentary).toHaveLength(32);
	});

	it("answers one promise per turn, at once for a turn that ended before anyone registered", async () => {
		const { turns } = setup();
		expect(turns.register(threadId, turnId)).toBe(turns.register(threadId, turnId));
		expect(turns.registered(threadId, turnId)).toBe(true);
		expect(turns.registered("thread-2", turnId)).toBe(false);

		turns.accept(item("early", "final_answer", "turn-2"));
		turns.accept({
			method: "turn/completed",
			params: { threadId, turn: { id: "turn-2", status: "completed", error: null } },
		});
		expect(await turns.register(threadId, "turn-2")).toEqual({ status: "completed", finalResponse: "early" });
	});

	it("ends a turn on the terminal its thread's owner published", async () => {
		const { turns, state } = setup();
		const ended = turns.register(threadId, turnId);
		turns.accept(terminal());

		turns.published(threadId, turnId, { status: "interrupted" });

		expect(await ended).toEqual({ status: "interrupted" });
		expect(state.deadlines).toEqual([]);
		expect(state.submitted).toEqual([]);
	});

	it("ends every turn as failed once its child is gone, and opens none after", async () => {
		const { turns, state } = setup();
		const running = turns.register(threadId, turnId);
		const held = turns.register(threadId, "turn-2");
		turns.accept({
			method: "turn/completed",
			params: { threadId, turn: { id: "turn-2", status: "completed", error: null } },
		});

		turns.lose("the child exited");

		expect(await running).toEqual({ status: "failed", error: "the child exited" });
		expect(await held).toEqual({ status: "failed", error: "the child exited" });
		expect(state.deadlines).toEqual([]);
		expect(await turns.register(threadId, "turn-3")).toEqual({ status: "failed", error: "the child exited" });
		expect(turns.accept(item("late", "final_answer", "turn-3"))).toBeNull();
	});
});
