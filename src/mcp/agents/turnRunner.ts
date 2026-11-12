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
	/** Current terminal recipient. */
	owner: Owner;
}

export interface TurnRunnerHost<Owner> {
	now(): number;
	terminal(turn: RunningTurn<Owner>, terminal: TurnTerminal): void;
	activity(turn: RunningTurn<Owner>, text: string, itemId?: string): void;
	counter(turn: RunningTurn<Owner>, counter: TurnCounter): void;
	/** Retire a silent driver session. */
	giveUp(turn: RunningTurn<Owner>): void;
	log(line: string): void;
}

export interface MessageOptions extends TurnOptions {
	/** Steer only this turn. */
	expectedTurnId: string | undefined;
	/** CWD for resumed threads. */
	cwd: string;
}

export type MessageOutcome =
	| { kind: "steered"; turnId: string }
	| { kind: "started"; turnId: string }
	| { kind: "busy" }
	/** Thread cannot be resumed. */
	| { kind: "ended" };

interface ActiveTurn<Owner> extends RunningTurn<Owner> {
	settled: Promise<TurnTerminal>;
	/** Last progress time. */
	at: number;
	/** Silence interrupt sent. */
	warned: boolean;
}

////////////////////////////////
//  Constants

const EARLY_TURNS_MAX = 32;
const EARLY_EVENTS_MAX = 64;
const THREAD_MEMORY = 256;
const SEEN_TURNS_MAX = 1024;
const ENDED_MEMORY = 256;
export const NO_PROGRESS_MS = 600_000;
const UNKNOWN: TurnInspection = { known: "unknown" };

////////////////////////////////
//  Class

export class TurnRunner<Owner> {
	private readonly threads = new Set<string>();
	private readonly active = new Map<string, ActiveTurn<Owner>>();
	/** Events before announcement. */
	private readonly early = new Map<string, Array<(turn: ActiveTurn<Owner>) => void>>();
	/** Announced turns: an adopted one is never among them. */
	private readonly seen = new Set<string>();
	/** How its turns ended, for a reconcile the driver cannot answer. Oldest first. */
	private readonly ended = new Map<string, TurnTerminal>();

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

	/** Bound remembered idle threads. */
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

	/** Clear without publishing terminals. */
	clear(): void {
		this.active.clear();
		this.early.clear();
	}

	/**
	 * A new turn, its thread held from here on. `accepted` runs before anything its child said early.
	 * Throws when the driver refuses and no turn of this prompt is found running.
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

	/** Take ownership of a running turn. */
	adopt(threadId: string, owner: Owner, handle: TurnHandle, accepted: (turnId: string) => void): void {
		this.announce(threadId, owner, handle, accepted);
	}

	/**
	 * Into the running turn when the driver steers, else a new turn. A steer whose turn ended under it
	 * opens one under the same key. Throws what the driver refused with.
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
				// Driver may retain terminal.
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

	/** False when that turn is not the thread's running one. */
	async interrupt(threadId: string, turnId: string): Promise<boolean> {
		const active = this.active.get(threadId);
		if (!active || active.turnId !== turnId) return false;
		await this.client.interruptTurn(threadId, turnId);
		return true;
	}

	/** A turn this runner ended is answered from memory. */
	async inspect(threadId: string, turnId: string): Promise<TurnInspection> {
		const terminal = this.ended.get(turnId);
		if (terminal) return { known: "settled", terminal };
		return (await this.client.inspectTurn?.(threadId, turnId).catch(() => UNKNOWN)) ?? UNKNOWN;
	}

	settle(turn: RunningTurn<Owner>, terminal: TurnTerminal): void {
		const active = this.active.get(turn.threadId);
		if (active !== turn) return;
		this.active.delete(turn.threadId);
		this.ended.set(turn.turnId, terminal);
		if (this.ended.size > ENDED_MEMORY) this.ended.delete(this.ended.keys().next().value as string);
		this.host.terminal(active, terminal);
	}

	/** Inspect silence, interrupt once, then give up. */
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
		for (const publish of this.early.get(handle.turnId) ?? []) publish(active);
		this.early.delete(handle.turnId);
		void handle.settled.then((terminal) => this.settle(active, terminal));
	}

	private alive(turnId: string): void {
		const active = this.byTurn(turnId);
		if (!active) return;
		active.at = this.host.now();
		active.warned = false;
	}

	private whenAnnounced(turnId: string, publish: (turn: ActiveTurn<Owner>) => void): void {
		const active = this.byTurn(turnId);
		if (active) {
			publish(active);
			return;
		}
		const said = this.early.get(turnId) ?? [];
		if (said.length >= EARLY_EVENTS_MAX) return;
		said.push(publish);
		this.early.set(turnId, said);
		while (this.early.size > EARLY_TURNS_MAX) this.early.delete(this.early.keys().next().value as string);
	}

	private byTurn(turnId: string): ActiveTurn<Owner> | undefined {
		for (const active of this.active.values()) if (active.turnId === turnId) return active;
		return undefined;
	}
}
