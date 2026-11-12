import { CODEX_BACKEND } from "../../shared/agent-backend.js";
import type { AgentChild } from "../devcontainer/agentTargets.js";
import type { LifecycleHooks } from "../devcontainer/codexAppServer.js";
import { type AppServerSession, defaultOpenClient } from "../devcontainer/codexAppServerSession.js";
import type { PoisonReason } from "../devcontainer/codexThreadLifecycle.js";
import { outcomeFromRead, type ReadOutcome, type TerminalOutcome } from "../devcontainer/codexTurnOutcome.js";
import { CodexTurns } from "../devcontainer/codexTurns.js";
import type {
	AgentBackendSession,
	AgentModel,
	ThreadOptions,
	TurnCounter,
	TurnHandle,
	TurnInspection,
	TurnOptions,
} from "./backendSession.js";

////////////////////////////////
//  Interfaces & Types

export interface CodexOpenOptions {
	openClient?: (child: AgentChild, model: string, hooks: LifecycleHooks) => Promise<AppServerSession>;
	now?: () => number;
	setTimer?: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

////////////////////////////////
//  Constants

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

////////////////////////////////
//  Class

export class CodexBackendSession implements AgentBackendSession {
	private readonly threads = new Map<string, true>();
	private readonly turns: CodexTurns;
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
		setTimer: (run: () => void, ms: number) => ReturnType<typeof setTimeout>,
		clearTimer: (handle: ReturnType<typeof setTimeout>) => void,
	) {
		this.lastFrameAt = now();
		this.turns = new CodexTurns({
			read: (threadId, turnId) => this.readOutcome(threadId, turnId),
			submit: (threadId, turnId, terminal) => this.park(threadId, turnId, terminal),
			setTimer,
			clearTimer,
			onCommentary: (item) => {
				if (this.closed) return;
				this.activityListener?.(item.turnId, item.text, item.itemId);
			},
			onCounter: (item) => {
				if (this.closed) return;
				this.counterListener?.(item.turnId, {
					kind: item.kind,
					itemId: item.itemId,
					...(item.filesChanged === undefined ? {} : { filesChanged: item.filesChanged }),
				});
			},
		});
	}

	static async open(child: AgentChild, options: CodexOpenOptions = {}): Promise<CodexBackendSession> {
		const openClient = options.openClient ?? defaultOpenClient;
		const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
		const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
		let session: CodexBackendSession | undefined;
		const early: Array<{ threadId: string; reason: PoisonReason }> = [];
		const client = await openClient(child, CODEX_BACKEND.defaultModel, {
			onTerminal: (threadId, turnId, terminal) => session?.turns.published(threadId, turnId, terminal),
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
			opened.turns.lose(`codex app-server exited`);
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
		let handle: TurnHandle | undefined;
		const turnId = await this.client.startTurn(
			threadId,
			prompt,
			(id) => {
				handle = { turnId: id, settled: this.turns.register(threadId, id) };
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
		const observed = await this.turns.inspect(threadId, turnId);
		return observed.known === "settled" ? { known: "settled", terminal: observed.outcome } : observed;
	}

	async adoptTurn(threadId: string): Promise<TurnHandle | undefined> {
		const adopted = await this.client.adoptThread(threadId);
		this.rememberThread(threadId);
		if (adopted.known !== "running") return undefined;
		return { turnId: adopted.turnId, settled: this.turns.register(threadId, adopted.turnId) };
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
		this.turns.lose(`codex app-server closed`);
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
		const ended = this.turns.accept(message);
		if (ended) {
			if (ended.status === "interrupted")
				console.error(`[codex-daemon] turn ${ended.turnId} interrupted (${message.method})`);
			return;
		}
		if (named && !this.closed && this.turns.registered(named.threadId, named.turnId)) {
			this.progressListener?.(named.turnId);
		}
	}

	private readOutcome(threadId: string, turnId: string): Promise<ReadOutcome> {
		return this.client
			.readThread(threadId)
			.then((result) => outcomeFromRead(result, threadId, turnId))
			.catch(() => ({ known: "unknown" as const }));
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

	private park(threadId: string, turnId: string, terminal: TerminalOutcome): void {
		void this.client.settleTurn(threadId, turnId, terminal).catch((error) => {
			console.error(`[codex] parking behind ${turnId}: ${error instanceof Error ? error.message : ""}`);
		});
	}

	private notifyClosed(): void {
		if (this.closedNotified) return;
		this.closedNotified = true;
		this.closedListener?.();
	}
}
