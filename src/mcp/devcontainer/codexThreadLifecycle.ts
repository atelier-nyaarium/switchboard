import {
	CodexAppServerThreadReadResultSchema,
	CodexAppServerTurnStartResultSchema,
} from "../../shared/codex-app-server.js";
import { createKeyedFifo } from "../../shared/keyed-fifo.js";
import type { AppServerFailure } from "./codexAppServer.js";
import type { TerminalOutcome } from "./codexTurnOutcome.js";
import { outcomeFromRead } from "./codexTurnOutcome.js";

////////////////////////////////
//  Interfaces & Types

export type ThreadPhase =
	/** Reached by name; activation must resume it. */
	| { phase: "unloaded" }
	/** Loaded, with no owned turn. */
	| { phase: "idle" }
	| { phase: "active"; turnId: string; epoch: number }
	| { phase: "parking"; epoch: number }
	| { phase: "parked"; epoch: number }
	| { phase: "disposed" }
	| { phase: "poisoned"; reason: PoisonReason };

export type PoisonReason = { kind: "failure"; failure: AppServerFailure } | { kind: "exhausted"; attempts: number };

export interface LifecycleDeps {
	request(method: string, params: unknown): Promise<unknown>;
	/** The transport's own failure, or null for anything else. */
	classify(error: unknown): AppServerFailure | null;
	/** Publish and retain before unload, once per turn. */
	onTerminal(threadId: string, turnId: string, terminal: TerminalOutcome): void;
	/** Retire the generation; it cannot reactivate. */
	onPoisoned(threadId: string, reason: PoisonReason): void;
}

export type ThreadInspection =
	| { known: "empty" }
	| { known: "running"; turnId: string }
	| { known: "settled"; turnId: string; outcome: TerminalOutcome }
	| { known: "unknown" };

interface ThreadRecord {
	state: ThreadPhase;
	/** Invalidates retries from earlier activations. */
	epoch: number;
	/** True while start has no turn ID. */
	pendingStart: boolean;
	buffered: Map<string, TerminalOutcome>;
	/** Settled turn IDs already published. */
	published: Set<string>;
	/** Archive refusals before poisoning. */
	parkAttempts: number;
	retry?: ReturnType<typeof setTimeout>;
}

////////////////////////////////
//  Constants

/** Consecutive refusals before poisoning. */
const PARK_ATTEMPTS = 3;

/** Quiet interval between empty reads before deletion. */
const DISPOSE_QUIET_MS = 250;

const PARK_RETRY_MS = 1_000;

/** Retirements retained before oldest eviction. */
const RETIRED_MEMORY = 256;

////////////////////////////////
//  Class

/** A Codex thread's requests in order, its terminals published once, and its parking. */
export class ThreadLifecycle {
	private readonly threads = new Map<string, ThreadRecord>();
	/** One entry per retired thread, oldest retirement first. */
	private readonly retired = new Map<string, ThreadRecord>();
	/** Pending pauses released on close. */
	private readonly pauses = new Map<ReturnType<typeof setTimeout>, () => void>();
	/** Replacements get fresh queues. */
	private readonly queues = createKeyedFifo<ThreadRecord>();
	private closed = false;

	constructor(private readonly deps: LifecycleDeps) {}

	stateOf(threadId: string): ThreadPhase | undefined {
		return this.threads.get(threadId)?.state;
	}

	/** Parking threads remain loaded until archive completes. */
	loaded(): string[] {
		return [...this.threads]
			.filter(([, record]) => ["idle", "active", "parking"].includes(record.state.phase))
			.map(([threadId]) => threadId);
	}

	/** The reply is authoritative: a known id is a new thread. Its old retry is cancelled first. */
	started(threadId: string): void {
		const previous = this.threads.get(threadId);
		if (previous) this.cancelRetry(previous);
		this.retired.delete(threadId);
		this.threads.set(threadId, { ...this.fresh(), state: { phase: "idle" } });
	}

	track(threadId: string): void {
		if (!this.threads.has(threadId)) this.threads.set(threadId, this.fresh());
	}

	/** Resume; unarchive on refusal. */
	activate(threadId: string): Promise<void> {
		this.track(threadId);
		return this.run(threadId, async (record) => {
			this.refuseEnded(threadId, record);
			await this.load(threadId, record);
		});
	}

	/** Register the turn before publishing buffered terminals. */
	startTurn(threadId: string, params: unknown, onStarted: (turnId: string) => void): Promise<string> {
		this.track(threadId);
		return this.run(threadId, async (record) => {
			this.refuseEnded(threadId, record);
			await this.load(threadId, record);
			record.pendingStart = true;
			let turnId: string;
			try {
				turnId = await this.mutate(
					threadId,
					record,
					"turn/start",
					params,
					(result) => CodexAppServerTurnStartResultSchema.parse(result).turn.id,
				);
			} catch (error) {
				// Drain terminals; no other observer will report them.
				record.pendingStart = false;
				await this.drain(threadId, record);
				throw error;
			}
			record.pendingStart = false;
			record.epoch += 1;
			record.state = { phase: "active", turnId, epoch: record.epoch };
			record.parkAttempts = 0;
			try {
				onStarted(turnId);
			} finally {
				// Drain even if registration throws.
				await this.drain(threadId, record);
			}
			return turnId;
		});
	}

	/** Refuses only known ended or conflicting turns. */
	steerTurn(threadId: string, turnId: string, params: unknown): Promise<unknown> {
		return this.control(threadId, turnId, "turn/steer", params);
	}

	interruptTurn(threadId: string, turnId: string, params: unknown): Promise<unknown> {
		return this.control(threadId, turnId, "turn/interrupt", params);
	}

	/** Queue reads per thread. */
	read(threadId: string, params: unknown): Promise<unknown> {
		this.track(threadId);
		return this.run(threadId, (record) => {
			this.refuseEnded(threadId, record);
			return this.mutate(threadId, record, "thread/read", params, (result) => result);
		});
	}

	/** Publish once; park only when no other turn owns it. */
	settleTurn(threadId: string, turnId: string, terminal: TerminalOutcome): Promise<void> {
		// Track threads with terminal reports.
		this.track(threadId);
		const record = this.threads.get(threadId) as ThreadRecord;
		// Buffer outside the queue until start returns its ID.
		if (record.pendingStart) {
			record.buffered.set(turnId, terminal);
			return Promise.resolve();
		}
		return this.run(threadId, (current) => this.accept(threadId, current, turnId, terminal));
	}

	/** Caller settles; adoption neither publishes nor deletes. */
	adopt(threadId: string): Promise<ThreadInspection> {
		this.track(threadId);
		return this.run(threadId, async (record) => {
			this.refuseEnded(threadId, record);
			await this.load(threadId, record);
			return this.take(threadId, record);
		});
	}

	/** Two empty reads dispose; unknown preserves. */
	adoptOrDispose(threadId: string): Promise<ThreadInspection> {
		this.track(threadId);
		return this.run(threadId, async (record) => {
			this.refuseEnded(threadId, record);
			const first = await this.take(threadId, record);
			if (first.known === "settled") await this.accept(threadId, record, first.turnId, first.outcome);
			if (first.known !== "empty") return first;
			await this.pause(DISPOSE_QUIET_MS);
			const second = await this.inspect(threadId, record);
			if (second.known !== "empty") return second;
			await this.mutate(threadId, record, "thread/delete", { threadId }, () => undefined);
			record.state = { phase: "disposed" };
			this.retire(threadId, record);
			return second;
		});
	}

	/** Release pauses; do not retry after close. */
	close(): void {
		this.closed = true;
		for (const [timer, release] of this.pauses) {
			clearTimeout(timer);
			release();
		}
		this.pauses.clear();
		this.retired.clear();
		for (const record of this.threads.values()) this.cancelRetry(record);
	}

	private fresh(): ThreadRecord {
		return {
			state: { phase: "unloaded" },
			epoch: 0,
			pendingStart: false,
			buffered: new Map(),
			published: new Set(),
			parkAttempts: 0,
		};
	}

	private run<T>(threadId: string, operation: (record: ThreadRecord) => Promise<T>): Promise<T> {
		const record = this.threads.get(threadId) ?? this.fresh();
		this.threads.set(threadId, record);
		return this.queues.run(record, () => operation(record));
	}

	private phase(record: ThreadRecord): ThreadPhase["phase"] {
		return record.state.phase;
	}

	private refuseEnded(threadId: string, record: ThreadRecord): void {
		if (record.state.phase === "disposed") throw new Error(`thread ${threadId} was disposed`);
		if (record.state.phase === "poisoned") throw new Error(`thread ${threadId} is on a poisoned generation`);
	}

	private control(threadId: string, turnId: string, method: string, params: unknown): Promise<unknown> {
		this.track(threadId);
		return this.run(threadId, async (record) => {
			this.refuseEnded(threadId, record);
			if (record.state.phase === "active" && record.state.turnId !== turnId) {
				throw new Error(`no active turn ${turnId} on thread ${threadId}`);
			}
			return this.deps.request(method, params);
		});
	}

	private async load(threadId: string, record: ThreadRecord): Promise<void> {
		if (record.state.phase === "idle" || record.state.phase === "active") return;
		this.cancelRetry(record);
		if (record.state.phase !== "parking") await this.resume(threadId, record);
		record.epoch += 1;
		record.state = { phase: "idle" };
		// Consume retirement only after resume succeeds.
		if (this.retired.get(threadId) === record) this.retired.delete(threadId);
	}

	private async resume(threadId: string, record: ThreadRecord): Promise<void> {
		try {
			await this.mutate(threadId, record, "thread/resume", { threadId }, () => undefined);
			return;
		} catch (error) {
			if (this.deps.classify(error)?.kind !== "refused") throw error;
			try {
				await this.mutate(threadId, record, "thread/unarchive", { threadId }, () => undefined);
			} catch (unarchive) {
				const refused = this.deps.classify(unarchive);
				if (refused?.kind === "refused") throw error;
				throw unarchive;
			}
			await this.mutate(threadId, record, "thread/resume", { threadId }, () => undefined);
		}
	}

	/** Publish terminals buffered before start returned its ID. */
	private async drain(threadId: string, record: ThreadRecord): Promise<void> {
		const held = [...record.buffered];
		record.buffered.clear();
		for (const [id, terminal] of held) await this.accept(threadId, record, id, terminal);
	}

	private async accept(
		threadId: string,
		record: ThreadRecord,
		turnId: string,
		terminal: TerminalOutcome,
	): Promise<void> {
		if (!record.published.has(turnId)) {
			record.published.add(turnId);
			this.deps.onTerminal(threadId, turnId, terminal);
		}
		// Terminals prove unloaded threads are loaded.
		const own = record.state.phase === "active" && record.state.turnId === turnId;
		if (!own && record.state.phase !== "idle" && record.state.phase !== "unloaded") return;
		record.state = { phase: "parking", epoch: record.epoch };
		await this.park(threadId, record, record.epoch);
	}

	private async park(threadId: string, record: ThreadRecord, epoch: number): Promise<void> {
		if (record.state.phase !== "parking" || record.state.epoch !== epoch) return;
		try {
			await this.mutate(threadId, record, "thread/archive", { threadId }, () => undefined);
			record.state = { phase: "parked", epoch };
			record.parkAttempts = 0;
			this.retire(threadId, record);
			return;
		} catch (error) {
			// Preserve errors after poisoning the generation.
			const phase = this.phase(record);
			if (phase === "poisoned") throw error;
			if (phase !== "parking") return;
			if (this.deps.classify(error)?.kind !== "refused") throw error;
		}
		// Inspect refusals to distinguish no-rollout from other states.
		const first = await this.inspect(threadId, record);
		if (first.known === "running") {
			record.epoch += 1;
			record.state = { phase: "active", turnId: first.turnId, epoch: record.epoch };
			return;
		}
		if (first.known === "empty") {
			await this.pause(DISPOSE_QUIET_MS);
			const second = await this.inspect(threadId, record);
			if (second.known === "empty") {
				try {
					await this.mutate(threadId, record, "thread/delete", { threadId }, () => undefined);
					record.state = { phase: "disposed" };
					this.retire(threadId, record);
					return;
				} catch (error) {
					// Count refused deletes as failed parks.
					if (this.deps.classify(error)?.kind !== "refused") throw error;
				}
			}
		}
		record.parkAttempts += 1;
		if (record.parkAttempts >= PARK_ATTEMPTS) {
			this.poison(threadId, record, { kind: "exhausted", attempts: record.parkAttempts });
			return;
		}
		this.retryLater(threadId, record, epoch);
	}

	/** Scheduled park retry, invalidated by activation. */
	private retryLater(threadId: string, record: ThreadRecord, epoch: number): void {
		if (this.closed) return;
		this.cancelRetry(record);
		record.retry = setTimeout(() => {
			record.retry = undefined;
			void this.run(threadId, (current) => this.park(threadId, current, epoch)).catch(() => undefined);
		}, PARK_RETRY_MS);
	}

	private cancelRetry(record: ThreadRecord): void {
		if (record.retry === undefined) return;
		clearTimeout(record.retry);
		record.retry = undefined;
	}

	/** One read adopts running turns; settled reads end ownership. */
	private async take(threadId: string, record: ThreadRecord): Promise<ThreadInspection> {
		const first = await this.inspect(threadId, record);
		if (first.known === "running") {
			this.cancelRetry(record);
			record.epoch += 1;
			record.state = { phase: "active", turnId: first.turnId, epoch: record.epoch };
		} else if (first.known === "settled" && record.state.phase === "active") {
			record.state = { phase: "idle" };
		}
		return first;
	}

	private async inspect(threadId: string, record: ThreadRecord): Promise<ThreadInspection> {
		const result = await this.mutate(
			threadId,
			record,
			"thread/read",
			{ threadId, includeTurns: true },
			(value) => value,
		);
		return inspectRead(result, threadId);
	}

	/** Timeout or unreadable replies poison; refusals throw. */
	private async mutate<T>(
		threadId: string,
		record: ThreadRecord,
		method: string,
		params: unknown,
		read: (result: unknown) => T,
	): Promise<T> {
		// Stop here; the wire would reach the replacement thread.
		if (this.threads.get(threadId) !== record) throw new Error(`thread ${threadId} was replaced`);
		try {
			return read(await this.deps.request(method, params));
		} catch (error) {
			const failure = this.deps.classify(error);
			if (failure && (failure.kind === "timeout" || failure.kind === "unreadable")) {
				this.poison(threadId, record, { kind: "failure", failure });
			}
			throw error;
		}
	}

	private poison(threadId: string, record: ThreadRecord, reason: PoisonReason): void {
		if (record.state.phase === "poisoned") return;
		this.cancelRetry(record);
		record.state = { phase: "poisoned", reason };
		// Poisoned records are never evicted.
		if (this.retired.get(threadId) === record) this.retired.delete(threadId);
		this.deps.onPoisoned(threadId, reason);
	}

	private retire(threadId: string, record: ThreadRecord): void {
		if (this.threads.get(threadId) !== record) return;
		// Refresh retirement order.
		this.retired.delete(threadId);
		this.retired.set(threadId, record);
		if (this.retired.size <= RETIRED_MEMORY) return;
		for (const [oldest, held] of [...this.retired]) {
			if (this.retired.size <= RETIRED_MEMORY) return;
			// Never evict queued threads.
			if (this.queues.has(held)) continue;
			const phase = held.state.phase;
			if (phase !== "parked" && phase !== "disposed") continue;
			this.retired.delete(oldest);
			this.threads.delete(oldest);
		}
	}

	private pause(ms: number): Promise<void> {
		if (this.closed) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pauses.delete(timer);
				resolve();
			}, ms);
			this.pauses.set(timer, resolve);
		});
	}
}

////////////////////////////////
//  Functions & Helpers

/** Prefer running, then last settled, then empty. */
function inspectRead(result: unknown, threadId: string): ThreadInspection {
	const parsed = CodexAppServerThreadReadResultSchema.safeParse(result);
	if (!parsed.success || parsed.data.thread.id !== threadId) return { known: "unknown" };
	const turns = parsed.data.thread.turns;
	if (turns.length === 0) return { known: "empty" };
	const running = turns.find((turn) => turn.status === "inProgress");
	if (running) return { known: "running", turnId: running.id };
	const last = turns[turns.length - 1]!;
	const outcome = outcomeFromRead(result, threadId, last.id);
	if (outcome.known !== "settled") return { known: "unknown" };
	return { known: "settled", turnId: last.id, outcome: outcome.outcome };
}
