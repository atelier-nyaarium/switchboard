import type { AgentCounterKind } from "../../shared/agent-counter.js";
import { agentErrorText } from "../../shared/agent-identity.js";
import { AGENT_ACTIVITY_MAX_BYTES, AGENT_ACTIVITY_MAX_ITEMS } from "../../shared/agent-record.js";
import {
	CodexAppServerAgentMessageCompletedSchema,
	CodexAppServerOtherItemCompletedSchema,
	CodexAppServerTurnCompletedSchema,
	classifyCodexItemPhase,
} from "../../shared/codex-app-server.js";
import type { ReadOutcome, TerminalOutcome } from "./codexTurnOutcome.js";

////////////////////////////////
//  Interfaces & Types

type Timer = ReturnType<typeof setTimeout>;

export interface CodexTurnsDeps {
	/** Never rejects. */
	read(threadId: string, turnId: string): Promise<ReadOutcome>;
	/** Its thread parks behind it. */
	submit(threadId: string, turnId: string, terminal: TerminalOutcome): void;
	setTimer(run: () => void, ms: number): Timer;
	clearTimer(timer: Timer): void;
	onCommentary?(item: { threadId: string; turnId: string; itemId: string; text: string }): void;
	onCounter?(item: {
		threadId: string;
		turnId: string;
		itemId: string;
		kind: AgentCounterKind;
		filesChanged?: number;
	}): void;
}

export interface EndedTurn {
	turnId: string;
	status: TerminalOutcome["status"];
}

type Ending =
	| { phase: "running" }
	/** Completed, awaiting its answer. `lapsed`: deadlines passed. */
	| { phase: "holding"; lapsed: number; timer: Timer }
	/** Deadline read in flight. */
	| { phase: "checking"; lapsed: number };

interface Turn {
	threadId: string;
	activityCount: number;
	activityBytes: number;
	lastCandidate?: string;
	lastFinalAnswer?: string;
	counterIds: Set<string>;
	ending: Ending;
	handle?: { promise: Promise<TerminalOutcome>; resolve(terminal: TerminalOutcome): void };
}

////////////////////////////////
//  Constants

const HELD_TERMINAL_MS = 10_000;
/** Consecutive running reads tolerated. */
const HELD_CHECKS = 3;
const ENDED_MEMORY = 256;

////////////////////////////////
//  Functions & Helpers

function answerOf(turn: Turn): string | undefined {
	return turn.lastFinalAnswer ?? turn.lastCandidate;
}

function completed(turn: Turn): TerminalOutcome {
	return { status: "completed", finalResponse: answerOf(turn) };
}

function counterKind(type: string): AgentCounterKind | undefined {
	switch (type) {
		case "commandExecution":
			return "shell";
		case "fileChange":
			return "edit";
		case "fileRead":
			return "read";
		case "mcpToolCall":
		case "webSearch":
			return "other";
		default:
			return undefined;
	}
}

////////////////////////////////
//  Class

export class CodexTurns {
	private readonly turns = new Map<string, Turn>();
	/** Oldest first. */
	private readonly ended = new Map<string, { threadId: string; terminal: TerminalOutcome }>();
	/** The child-exit error. */
	private lost?: string;

	constructor(private readonly deps: CodexTurnsDeps) {}

	/** Replays ended turns; otherwise resolves on settlement. */
	register(threadId: string, turnId: string): Promise<TerminalOutcome> {
		if (this.lost !== undefined) return Promise.resolve({ status: "failed", error: this.lost });
		const ended = this.ended.get(turnId);
		if (ended?.threadId === threadId) return Promise.resolve(ended.terminal);
		const turn = this.own(threadId, turnId);
		if (!turn) return Promise.resolve({ status: "failed", error: `turn ${turnId} is not on thread ${threadId}` });
		if (!turn.handle) {
			let resolve: (terminal: TerminalOutcome) => void = () => {};
			const promise = new Promise<TerminalOutcome>((inner) => {
				resolve = inner;
			});
			turn.handle = { promise, resolve };
		}
		return turn.handle.promise;
	}

	registered(threadId: string, turnId: string): boolean {
		const turn = this.turns.get(turnId);
		return turn?.threadId === threadId && turn.handle !== undefined;
	}

	/** Names the turn this frame ended. */
	accept(message: unknown): EndedTurn | null {
		const item = CodexAppServerAgentMessageCompletedSchema.safeParse(message);
		if (item.success) return this.onMessage(item.data.params);

		const other = CodexAppServerOtherItemCompletedSchema.safeParse(message);
		if (other.success) return this.onOtherItem(other.data.params);

		const terminal = CodexAppServerTurnCompletedSchema.safeParse(message);
		if (terminal.success) return this.onTurnCompleted(terminal.data.params);

		return null;
	}

	/** A settled read ends the turn. Answerless, it reads as running until the first deadline. */
	async inspect(threadId: string, turnId: string): Promise<ReadOutcome> {
		const observed = await this.deps.read(threadId, turnId);
		if (observed.known !== "settled") return observed;
		const held = this.turns.get(turnId);
		const turn = held?.threadId === threadId ? held : undefined;
		const answerless = observed.outcome.status === "completed" && observed.outcome.finalResponse === undefined;
		if (answerless && turn?.ending.phase === "holding" && turn.ending.lapsed === 0) return { known: "running" };
		if (turn) {
			this.decide(turnId, turn, observed.outcome);
			return observed;
		}
		if (this.lost !== undefined) return observed;
		if (!this.ended.has(turnId)) this.remember(turnId, threadId, observed.outcome);
		this.deps.submit(threadId, turnId, observed.outcome);
		return observed;
	}

	published(threadId: string, turnId: string, terminal: TerminalOutcome): void {
		if (this.lost !== undefined) return;
		const turn = this.turns.get(turnId);
		if (turn?.threadId === threadId) this.end(turnId, turn, terminal);
		else if (!this.ended.has(turnId)) this.remember(turnId, threadId, terminal);
	}

	/** Fails every turn, and opens none after. */
	lose(error: string): void {
		if (this.lost !== undefined) return;
		this.lost = error;
		for (const turn of this.turns.values()) {
			if (turn.ending.phase === "holding") this.deps.clearTimer(turn.ending.timer);
			turn.handle?.resolve({ status: "failed", error });
		}
		this.turns.clear();
	}

	/** Undefined once ended, or on another thread. */
	private own(threadId: string, turnId: string): Turn | undefined {
		if (this.lost !== undefined || this.ended.has(turnId)) return undefined;
		let turn = this.turns.get(turnId);
		if (!turn) {
			turn = {
				threadId,
				activityCount: 0,
				activityBytes: 0,
				counterIds: new Set(),
				ending: { phase: "running" },
			};
			this.turns.set(turnId, turn);
		}
		return turn.threadId === threadId ? turn : undefined;
	}

	private onMessage(params: {
		threadId: string;
		turnId: string;
		item: { id: string; text: string; phase?: unknown };
	}): EndedTurn | null {
		const turn = this.own(params.threadId, params.turnId);
		if (!turn) return null;
		// Commentary is never the answer.
		switch (classifyCodexItemPhase(params.item.phase)) {
			case "answer":
				turn.lastFinalAnswer = params.item.text;
				break;
			case "commentary":
				this.retain(turn, params, params.item.id, params.item.text);
				break;
			default:
				turn.lastCandidate = params.item.text;
		}
		if (turn.ending.phase === "running" || answerOf(turn) === undefined) return null;
		return this.decide(params.turnId, turn, completed(turn));
	}

	private onTurnCompleted(params: {
		threadId: string;
		turn: { id: string; status: "completed" | "failed" | "interrupted"; error?: { message?: string } | null };
	}): EndedTurn | null {
		const turnId = params.turn.id;
		const turn = this.own(params.threadId, turnId);
		if (!turn) return null;
		if (params.turn.status === "completed") {
			if (answerOf(turn) !== undefined) return this.decide(turnId, turn, completed(turn));
			if (turn.ending.phase === "running") this.hold(turnId, turn, 0);
			return null;
		}
		if (params.turn.status === "interrupted") return this.decide(turnId, turn, { status: "interrupted" });
		const error = params.turn.error?.message ? agentErrorText(params.turn.error.message) : undefined;
		return this.decide(turnId, turn, { status: "failed", error: error || `turn failed` });
	}

	private onOtherItem(params: { threadId: string; turnId: string; item: { id: string; type: string } }): null {
		const kind = counterKind(params.item.type);
		if (!kind) return null;
		const turn = this.own(params.threadId, params.turnId);
		if (!turn || turn.counterIds.has(params.item.id)) return null;
		turn.counterIds.add(params.item.id);
		this.deps.onCounter?.({
			threadId: params.threadId,
			turnId: params.turnId,
			itemId: params.item.id,
			kind,
			...(params.item.type === "fileChange" ? { filesChanged: 1 } : {}),
		});
		return null;
	}

	private hold(turnId: string, turn: Turn, lapsed: number): void {
		const timer = this.deps.setTimer(() => {
			if (this.turns.get(turnId) !== turn || turn.ending.phase !== "holding" || turn.ending.timer !== timer)
				return;
			turn.ending = { phase: "checking", lapsed: lapsed + 1 };
			void this.check(turnId, turn);
		}, HELD_TERMINAL_MS);
		turn.ending = { phase: "holding", lapsed, timer };
	}

	/** Ends the turn or arms the next deadline. */
	private async check(turnId: string, turn: Turn): Promise<void> {
		const observed = await this.deps.read(turn.threadId, turnId);
		if (this.turns.get(turnId) !== turn || turn.ending.phase !== "checking") return;
		if (observed.known === "settled") {
			this.decide(turnId, turn, observed.outcome);
			return;
		}
		if (observed.known === "unknown" || turn.ending.lapsed >= HELD_CHECKS) {
			this.decide(turnId, turn, completed(turn));
			return;
		}
		this.hold(turnId, turn, turn.ending.lapsed);
	}

	private decide(turnId: string, turn: Turn, terminal: TerminalOutcome): EndedTurn {
		this.end(turnId, turn, terminal);
		this.deps.submit(turn.threadId, turnId, terminal);
		return { turnId, status: terminal.status };
	}

	private end(turnId: string, turn: Turn, terminal: TerminalOutcome): void {
		if (turn.ending.phase === "holding") this.deps.clearTimer(turn.ending.timer);
		this.turns.delete(turnId);
		this.remember(turnId, turn.threadId, terminal);
		turn.handle?.resolve(terminal);
	}

	private remember(turnId: string, threadId: string, terminal: TerminalOutcome): void {
		this.ended.set(turnId, { threadId, terminal });
		if (this.ended.size <= ENDED_MEMORY) return;
		const oldest = this.ended.keys().next().value;
		if (oldest !== undefined) this.ended.delete(oldest);
	}

	private retain(turn: Turn, origin: { threadId: string; turnId: string }, itemId: string, text: string): void {
		const size = Buffer.byteLength(text, "utf8");
		if (turn.activityCount >= AGENT_ACTIVITY_MAX_ITEMS || turn.activityBytes + size > AGENT_ACTIVITY_MAX_BYTES)
			return;
		turn.activityCount += 1;
		turn.activityBytes += size;
		this.deps.onCommentary?.({ ...origin, itemId, text });
	}
}
