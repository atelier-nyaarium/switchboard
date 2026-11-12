// Codex app-server agent session.

import { CODEX_BACKEND } from "../../shared/agent-backend.js";
import { CodexAppServerTurnCompletedSchema } from "../../shared/codex-app-server.js";
import type { AgentChild } from "../devcontainer/agentTargets.js";
import type { LifecycleHooks } from "../devcontainer/codexAppServer.js";
import { type AppServerSession, defaultOpenClient } from "../devcontainer/codexAppServerSession.js";
import type { PoisonReason } from "../devcontainer/codexThreadLifecycle.js";
import { outcomeFromRead, type ReadOutcome, terminalOf } from "../devcontainer/codexTurnOutcome.js";
import { CodexTurnTracker } from "../devcontainer/codexTurnTracker.js";
import type {
	AgentBackendSession,
	AgentModel,
	ThreadOptions,
	TurnCounter,
	TurnHandle,
	TurnInspection,
	TurnOptions,
	TurnTerminal,
} from "./backendSession.js";

////////////////////////////////
//  Interfaces & Types

export interface CodexOpenOptions {
	openClient?: (child: AgentChild, model: string, hooks: LifecycleHooks) => Promise<AppServerSession>;
	now?: () => number;
	setTimer?: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface Parked {
	threadId: string;
	resolve: (terminal: TurnTerminal) => void;
	promise: Promise<TurnTerminal>;
}

////////////////////////////////
//  Constants

const HELD_TERMINAL_MS = 10_000;
const THREAD_MEMORY = 256;
const FRAME_GAP_LOG_MS = 60_000;

////////////////////////////////
//  Functions & Helpers

function causeOf(reason: PoisonReason): string {
	return reason.kind === "failure" ? reason.failure.kind : `archive refused ${reason.attempts} times`;
}

function framedTurn(message: { params?: unknown }): { threadId: string; turnId: string } | null {
	if (typeof message.params !== "object" || message.params === null) return null;
	const params = message.params as { threadId?: unknown; turnId?: unknown; turn?: { id?: unknown } };
	const turnId = typeof params.turnId === "string" ? params.turnId : params.turn?.id;
	if (typeof params.threadId !== "string" || typeof turnId !== "string") return null;
	return { threadId: params.threadId, turnId };
}

function heldTurn(message: unknown): { threadId: string; turnId: string } | null {
	const parsed = CodexAppServerTurnCompletedSchema.safeParse(message);
	if (!parsed.success) return null;
	return { threadId: parsed.data.params.threadId, turnId: parsed.data.params.turn.id };
}

////////////////////////////////
//  Class

/**
 * Events settle turns; child exit settles pending turns.
 */
export class CodexBackendSession implements AgentBackendSession {
	/** Settles only its thread. */
	private readonly pending = new Map<string, Parked>();
	/** Deadlines settle held terminals. */
	private readonly held = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly threads = new Map<string, true>();
	private readonly tracker: CodexTurnTracker;
	private activityListener?: (turnId: string, text: string, itemId?: string) => void;
	private counterListener?: (turnId: string, counter: TurnCounter) => void;
	private progressListener?: (turnId: string) => void;
	private closedListener?: () => void;
	private closedNotified = false;
	/** Ignore events after close. */
	private closed = false;
	private lastFrameAt: number;

	private constructor(
		private readonly client: AppServerSession,
		private readonly now: () => number,
		private readonly setTimer: (run: () => void, ms: number) => ReturnType<typeof setTimeout>,
		private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void,
	) {
		this.lastFrameAt = now();
		this.tracker = new CodexTurnTracker(
			(item) => {
				if (this.closed) return;
				this.activityListener?.(item.turnId, item.text, item.itemId);
			},
			(item) => {
				if (this.closed) return;
				this.counterListener?.(item.turnId, {
					kind: item.kind,
					itemId: item.itemId,
					...(item.filesChanged === undefined ? {} : { filesChanged: item.filesChanged }),
				});
			},
		);
	}

	static async open(child: AgentChild, options: CodexOpenOptions = {}): Promise<CodexBackendSession> {
		const openClient = options.openClient ?? defaultOpenClient;
		const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
		const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
		// Hooks capture the session.
		let session: CodexBackendSession | undefined;
		const early: Array<{ threadId: string; reason: PoisonReason }> = [];
		const client = await openClient(child, CODEX_BACKEND.defaultModel, {
			onTerminal: (threadId, turnId, terminal) => session?.settle(threadId, turnId, terminal),
			onPoisoned: (threadId, reason) => {
				if (session) session.close();
				else early.push({ threadId, reason });
			},
		});
		const poisoned = early[0];
		if (poisoned) {
			try {
				client.close();
			} catch {
				// Already gone.
			}
			throw new Error(`codex thread poisoned while opening: ${poisoned.threadId} ${causeOf(poisoned.reason)}`);
		}
		const opened = new CodexBackendSession(client, options.now ?? Date.now, setTimer, clearTimer);
		session = opened;
		client.onEvent((message) => opened.onServerEvent(message));
		child.onExit(() => {
			opened.closed = true;
			opened.clearDeadlines();
			opened.settleAll(`codex app-server exited`);
			opened.notifyClosed();
		});
		return opened;
	}

	onActivity(listener: (turnId: string, text: string, itemId?: string) => void): void {
		this.activityListener = listener;
	}

	onCounter(listener: (turnId: string, counter: TurnCounter) => void): void {
		this.counterListener = listener;
	}

	onProgress(listener: (turnId: string) => void): void {
		this.progressListener = listener;
	}

	onClosed(listener: () => void): void {
		this.closedListener = listener;
		if (this.closed) listener();
	}

	async openThread(options: ThreadOptions): Promise<string> {
		const threadId = await this.client.startThread({
			cwd: options.cwd,
			model: options.model,
			serviceTier: options.serviceTier,
		});
		this.rememberThread(threadId);
		return threadId;
	}

	async resumeThread(threadId: string): Promise<void> {
		await this.client.resumeThread(threadId);
		this.rememberThread(threadId);
	}

	async listModels(): Promise<AgentModel[]> {
		return (await this.client.models()).map((id) => ({ id }));
	}

	async startTurn(threadId: string, prompt: string, turn: TurnOptions = {}): Promise<TurnHandle> {
		// The owner publishes after registration.
		let handle: TurnHandle | undefined;
		const turnId = await this.client.startTurn(
			threadId,
			prompt,
			(id) => {
				handle = { turnId: id, settled: this.park(threadId, id) };
			},
			{
				model: turn.model,
				serviceTier: turn.serviceTier,
				outputSchema: turn.outputSchema,
			},
		);
		if (!handle) throw new Error(`codex app-server started turn ${turnId} without registering it`);
		return handle;
	}

	async steerTurn(threadId: string, turnId: string, prompt: string): Promise<void> {
		await this.client.steerTurn(threadId, turnId, prompt);
	}

	async interruptTurn(threadId: string, turnId: string): Promise<void> {
		await this.client.interruptTurn(threadId, turnId);
	}

	async inspectTurn(threadId: string, turnId: string): Promise<TurnInspection> {
		const observed = await this.readOutcome(threadId, turnId);
		if (observed.known !== "settled") return observed;
		// While its deadline is armed, a held terminal's answer may still come.
		const answerless = observed.outcome.status === "completed" && observed.outcome.finalResponse === undefined;
		if (answerless && this.held.has(turnId) && this.tracker.holding(threadId, turnId)) return { known: "running" };
		this.dropDeadline(turnId);
		this.settleVia(threadId, turnId, observed.outcome);
		return { known: "settled", terminal: observed.outcome };
	}

	async adoptTurn(threadId: string): Promise<TurnHandle | undefined> {
		const adopted = await this.client.adoptThread(threadId);
		this.rememberThread(threadId);
		if (adopted.known !== "running") return undefined;
		const parked = this.pending.get(adopted.turnId);
		if (parked?.threadId === threadId) return { turnId: adopted.turnId, settled: parked.promise };
		return { turnId: adopted.turnId, settled: this.park(threadId, adopted.turnId) };
	}

	busy(): boolean {
		for (const threadId of this.threads.keys()) {
			const phase = this.client.stateOf(threadId)?.phase;
			if (phase === "active" || phase === "parking") return true;
		}
		return false;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.clearDeadlines();
		this.settleAll(`codex app-server closed`);
		this.client.close();
		this.notifyClosed();
	}

	private onServerEvent(message: { method: string; params?: unknown }): void {
		const named = framedTurn(message);
		const gap = this.now() - this.lastFrameAt;
		if (gap > FRAME_GAP_LOG_MS) {
			console.error(
				`[codex-daemon] frame after ${Math.round(gap / 1000)}s: ${message.method} turn=${named?.turnId ?? "-"}`,
			);
		}
		this.lastFrameAt = this.now();
		const outcome = this.tracker.accept(message);
		if (outcome) {
			if (outcome.status === "interrupted")
				console.error(`[codex-daemon] turn ${outcome.turnId} interrupted (${message.method})`);
			this.dropDeadline(outcome.turnId);
			this.settleVia(outcome.threadId, outcome.turnId, terminalOf(outcome));
			return;
		}
		if (named && !this.closed && this.pending.get(named.turnId)?.threadId === named.threadId) {
			this.progressListener?.(named.turnId);
		}
		const held = heldTurn(message);
		if (held && this.tracker.holding(held.threadId, held.turnId)) {
			this.holdDeadline(held.threadId, held.turnId);
		}
	}

	private async settleHeld(threadId: string, turnId: string): Promise<void> {
		const observed = await this.readOutcome(threadId, turnId);
		if (this.closed) return;
		if (observed.known === "running") return;
		const heldOutcome = this.tracker.settlePending(threadId, turnId);
		const terminal =
			observed.known === "settled"
				? observed.outcome
				: heldOutcome === null
					? undefined
					: terminalOf(heldOutcome);
		if (!terminal) return;
		this.settleVia(threadId, turnId, terminal);
	}

	private readOutcome(threadId: string, turnId: string): Promise<ReadOutcome> {
		return this.client
			.readThread(threadId)
			.then((result) => outcomeFromRead(result, threadId, turnId))
			.catch(() => ({ known: "unknown" as const }));
	}

	private holdDeadline(threadId: string, turnId: string): void {
		if (this.held.has(turnId)) return;
		this.held.set(
			turnId,
			this.setTimer(() => {
				this.held.delete(turnId);
				if (this.closed) return;
				void this.settleHeld(threadId, turnId);
			}, HELD_TERMINAL_MS),
		);
	}

	private dropDeadline(turnId: string): void {
		const timer = this.held.get(turnId);
		if (timer === undefined) return;
		this.clearTimer(timer);
		this.held.delete(turnId);
	}

	private clearDeadlines(): void {
		for (const timer of this.held.values()) this.clearTimer(timer);
		this.held.clear();
	}

	private rememberThread(threadId: string): void {
		this.threads.delete(threadId);
		this.threads.set(threadId, true);
		if (this.threads.size <= THREAD_MEMORY) return;
		for (const oldest of [...this.threads.keys()]) {
			if (this.threads.size <= THREAD_MEMORY) return;
			if (oldest === threadId) continue;
			const phase = this.client.stateOf(oldest)?.phase;
			if (phase === "active" || phase === "parking") continue;
			this.threads.delete(oldest);
		}
	}

	private park(threadId: string, turnId: string): Promise<TurnTerminal> {
		let resolve: (terminal: TurnTerminal) => void = () => {};
		const promise = new Promise<TurnTerminal>((res) => {
			resolve = res;
		});
		this.pending.set(turnId, { threadId, resolve, promise });
		return promise;
	}

	private settle(threadId: string, turnId: string, terminal: TurnTerminal): void {
		const parked = this.pending.get(turnId);
		if (parked?.threadId !== threadId) return;
		this.pending.delete(turnId);
		parked.resolve(terminal);
	}

	private settleAll(error: string): void {
		for (const [turnId, parked] of [...this.pending]) {
			this.pending.delete(turnId);
			parked.resolve({ status: "failed", error });
		}
	}

	private settleVia(threadId: string, turnId: string, terminal: TurnTerminal): void {
		void this.client.settleTurn(threadId, turnId, terminal).catch((error) => {
			console.error(`[codex] settling ${turnId}: ${error instanceof Error ? error.message : ""}`);
		});
	}

	private notifyClosed(): void {
		if (this.closedNotified) return;
		this.closedNotified = true;
		this.closedListener?.();
	}
}
