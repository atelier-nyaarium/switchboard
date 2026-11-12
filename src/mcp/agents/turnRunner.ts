import {
	type AgentBackendSession,
	settledNow,
	type TurnCounter,
	type TurnHandle,
	type TurnInspection,
	type TurnOptions,
	type TurnTerminal,
} from "./backendSession.js";

////////////////////////////////
//  Interfaces & Types

export interface RunningTurn<Owner> {
	readonly threadId: string;
	readonly turnId: string;
	/** Who is told about it. A handover changes it. */
	owner: Owner;
}

/** What the runner tells its side: a daemon publishes each, local mode records each. */
export interface TurnRunnerHost<Owner> {
	now(): number;
	terminal(turn: RunningTurn<Owner>, terminal: TurnTerminal): void;
	activity(turn: RunningTurn<Owner>, text: string, itemId?: string): void;
	counter(turn: RunningTurn<Owner>, counter: TurnCounter): void;
	/** A turn silent through an inspection and an interrupt. Its driver session is past saving. */
	giveUp(turn: RunningTurn<Owner>): void;
	log(line: string): void;
}

export interface MessageOptions extends TurnOptions {
	/** The turn its sender believes is running. No other is steered, and none when it names none. */
	expectedTurnId: string | undefined;
	/** Where a thread this session does not hold is resumed. */
	cwd: string;
}

export type MessageOutcome =
	| { kind: "steered"; turnId: string }
	| { kind: "started"; turnId: string }
	| { kind: "busy" }
	/** No thread to resume. */
	| { kind: "ended" };

interface ActiveTurn<Owner> extends RunningTurn<Owner> {
	settled: Promise<TurnTerminal>;
	/** Last sign of life. */
	at: number;
	/** Interrupted once for silence. */
	warned: boolean;
}

////////////////////////////////
//  Constants

const HELD_TURNS_MAX = 32;
const HELD_EVENTS_MAX = 64;
const THREAD_MEMORY = 256;
const SEEN_TURNS_MAX = 1024;
/** Bounds a silent reasoning hang. */
export const NO_PROGRESS_MS = 600_000;
const UNKNOWN: TurnInspection = { known: "unknown" };

////////////////////////////////
//  Class

export class TurnRunner<Owner> {
	private readonly threads = new Set<string>();
	/** One turn per thread. */
	private readonly active = new Map<string, ActiveTurn<Owner>>();
	/** What a child said of a turn not yet announced. */
	private readonly held = new Map<string, Array<(turn: ActiveTurn<Owner>) => void>>();
	/** Every turn announced here, so an adopted one is never another prompt's. */
	private readonly seen = new Set<string>();

	constructor(
		private readonly client: AgentBackendSession,
		private readonly host: TurnRunnerHost<Owner>,
	) {
		client.onActivity((turnId, text, itemId) => {
			this.alive(turnId);
			if (text) this.whenAnnounced(turnId, (turn) => this.host.activity(turn, text, itemId));
		});
		client.onCounter?.((turnId, counter) => {
			this.alive(turnId);
			this.whenAnnounced(turnId, (turn) => this.host.counter(turn, counter));
		});
		client.onProgress?.((turnId) => this.alive(turnId));
	}

	holds(threadId: string): boolean {
		return this.threads.has(threadId);
	}

	/** Holds a thread, the least recently used idle ones forgotten past the bound. */
	remember(threadId: string): void {
		this.threads.delete(threadId);
		this.threads.add(threadId);
		// One that cannot be resumed is never forgotten.
		if (!this.client.resumeThread) return;
		for (const oldest of [...this.threads]) {
			if (this.threads.size <= THREAD_MEMORY) return;
			if (oldest !== threadId && !this.active.has(oldest)) this.threads.delete(oldest);
		}
	}

	activeTurn(threadId: string): RunningTurn<Owner> | undefined {
		return this.active.get(threadId);
	}

	activeTurns(): Array<RunningTurn<Owner>> {
		return [...this.active.values()];
	}

	empty(): boolean {
		return this.threads.size === 0 && this.active.size === 0;
	}

	/** Tells of no terminal. */
	clear(): void {
		this.active.clear();
		this.held.clear();
	}

	/**
	 * A new turn, its thread held from here on. `accepted` runs once the turn is known and before
	 * anything its child said of it is published. Throws when the driver refuses and no turn of this
	 * prompt is found running.
	 */
	async begin(
		threadId: string,
		owner: Owner,
		prompt: string,
		options: TurnOptions,
		accepted: (turnId: string) => void,
	): Promise<string> {
		this.remember(threadId);
		let handle: TurnHandle;
		try {
			handle = await this.client.startTurn(threadId, prompt, options);
		} catch (error) {
			const running = await this.client.adoptTurn?.(threadId).catch(() => undefined);
			// A turn already announced is another prompt's.
			if (!running || this.seen.has(running.turnId)) throw error;
			handle = running;
		}
		this.announce(threadId, owner, handle, accepted);
		return handle.turnId;
	}

	/** A turn the driver already runs, taken as this owner's. */
	adopt(threadId: string, owner: Owner, handle: TurnHandle, accepted: (turnId: string) => void): void {
		this.announce(threadId, owner, handle, accepted);
	}

	/**
	 * A follow-up: into the running turn when the driver steers, else a new turn. A steer whose turn
	 * ended under it opens a new turn with the prompt, under the same key. `accepted` as in `begin`.
	 * Throws what the driver refused with.
	 */
	async message(
		threadId: string,
		owner: Owner,
		prompt: string,
		options: MessageOptions,
		accepted: (outcome: Extract<MessageOutcome, { kind: "steered" | "started" }>) => void,
	): Promise<MessageOutcome> {
		const { expectedTurnId, cwd, ...turn } = options;
		const active = this.active.get(threadId);
		if (active) {
			// Never steer a successor.
			if (!this.client.steerTurn || expectedTurnId !== active.turnId) return { kind: "busy" };
			let steerError: unknown;
			let taken = false;
			try {
				taken = (await this.client.steerTurn(threadId, active.turnId, prompt, turn.key)) === "taken";
			} catch (error) {
				steerError = error;
			}
			if (!taken) await settledNow(active.settled);
			if (steerError !== undefined && this.active.get(threadId) === active) {
				// The driver may hold its terminal.
				const seen = await this.inspect(threadId, active.turnId);
				if (seen.known === "settled") this.settle(active, seen.terminal);
			}
			if (taken || this.active.get(threadId) === active) {
				if (steerError !== undefined) throw steerError;
				const outcome = { kind: "steered" as const, turnId: active.turnId };
				accepted(outcome);
				return outcome;
			}
		}
		if (!this.threads.has(threadId)) {
			if (!this.client.resumeThread) return { kind: "ended" };
			await this.client.resumeThread(threadId, cwd);
		}
		const turnId = await this.begin(threadId, owner, prompt, turn, (started) =>
			accepted({ kind: "started", turnId: started }),
		);
		return { kind: "started", turnId };
	}

	/** False when that turn is not the thread's running one. Throws what the driver refused with. */
	async interrupt(threadId: string, turnId: string): Promise<boolean> {
		const active = this.active.get(threadId);
		if (!active || active.turnId !== turnId) return false;
		await this.client.interruptTurn(threadId, turnId);
		return true;
	}

	async inspect(threadId: string, turnId: string): Promise<TurnInspection> {
		return (await this.client.inspectTurn?.(threadId, turnId).catch(() => UNKNOWN)) ?? UNKNOWN;
	}

	/** Ends a running turn that the driver settled out of band. */
	settle(turn: RunningTurn<Owner>, terminal: TurnTerminal): void {
		const active = this.active.get(turn.threadId);
		if (active !== turn) return;
		this.active.delete(turn.threadId);
		this.host.terminal(active, terminal);
	}

	/**
	 * One pass over turns silent for `NO_PROGRESS_MS`: a settled one is published, a running one is
	 * interrupted once, and one still silent after that is given up. Only for a driver that reports life.
	 */
	async watch(stillServing: () => boolean): Promise<void> {
		if (!this.client.onProgress) return;
		const cutoff = this.host.now() - NO_PROGRESS_MS;
		for (const active of [...this.active.values()]) {
			if (active.at > cutoff) continue;
			const seen = await this.inspect(active.threadId, active.turnId);
			if (!stillServing()) return;
			if (this.active.get(active.threadId) !== active) continue;
			if (seen.known === "settled") {
				this.settle(active, seen.terminal);
				continue;
			}
			if (!active.warned) {
				active.warned = true;
				active.at = this.host.now();
				this.host.log(`interrupting turn ${active.turnId}: silent for ${NO_PROGRESS_MS / 1000}s`);
				void this.client.interruptTurn(active.threadId, active.turnId).catch(() => undefined);
				continue;
			}
			this.host.giveUp(active);
			return;
		}
	}

	private announce(threadId: string, owner: Owner, handle: TurnHandle, accepted: (turnId: string) => void): void {
		const active: ActiveTurn<Owner> = {
			threadId,
			turnId: handle.turnId,
			owner,
			settled: handle.settled,
			at: this.host.now(),
			warned: false,
		};
		this.active.set(threadId, active);
		this.seen.add(handle.turnId);
		if (this.seen.size > SEEN_TURNS_MAX) this.seen.delete(this.seen.values().next().value as string);
		accepted(handle.turnId);
		for (const publish of this.held.get(handle.turnId) ?? []) publish(active);
		this.held.delete(handle.turnId);
		void handle.settled.then((terminal) => this.settle(active, terminal));
	}

	private alive(turnId: string): void {
		const active = this.byTurn(turnId);
		if (!active) return;
		active.at = this.host.now();
		active.warned = false;
	}

	/** Publishes now, or once the turn is announced. */
	private whenAnnounced(turnId: string, publish: (turn: ActiveTurn<Owner>) => void): void {
		const active = this.byTurn(turnId);
		if (active) {
			publish(active);
			return;
		}
		const held = this.held.get(turnId) ?? [];
		if (held.length >= HELD_EVENTS_MAX) return;
		held.push(publish);
		this.held.set(turnId, held);
		while (this.held.size > HELD_TURNS_MAX) this.held.delete(this.held.keys().next().value as string);
	}

	private byTurn(turnId: string): ActiveTurn<Owner> | undefined {
		for (const active of this.active.values()) if (active.turnId === turnId) return active;
		return undefined;
	}
}
