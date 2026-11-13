import { PassThrough } from "node:stream";
import type {
	AgentBackendSession,
	AgentDriver,
	ListedThread,
	SteerOutcome,
	TurnCounter,
	TurnHandle,
	TurnInspection,
	TurnOptions,
	TurnTerminal,
} from "../mcp/agents/backendSession.js";
import { AGENT_DRIVERS } from "../mcp/agents/drivers.js";
import type { AgentChild } from "../mcp/devcontainer/agentTargets.js";
import { AGENT_BACKENDS, type AgentBackendId, agentBackend } from "../shared/agent-backend.js";

export interface ScriptedTurn {
	backend: AgentBackendId;
	targetId: string;
	threadId: string;
	turnId: string;
	prompt: string;
	options: TurnOptions;
	/** Oldest first. */
	steers: string[];
	interrupts: number;
	state(): "inProgress" | TurnTerminal["status"];
	activity(text: string, itemId?: string): void;
	counter(counter: TurnCounter): void;
	/** Dead children settle nothing. */
	settle(terminal: TurnTerminal): void;
}

export interface ScriptedBackend {
	/** Oldest first. */
	turns: ScriptedTurn[];
	threads: ReadonlySet<string>;
	/** A thread no agent record names. Null `updatedAt` reads as unknown. */
	plant(threadId: string, targetId: string, updatedAt: number | null, parentId?: string): void;
	launches: number;
	/** Default: activity, then completed. */
	onTurn?: (turn: ScriptedTurn) => void;
	/** Missing handler stalls; throws reject steering. */
	onSteer?: (turn: ScriptedTurn, prompt: string) => SteerOutcome | Promise<SteerOutcome>;
	/** Absent handler interrupts; throws fail. */
	onInterrupt?: (turn: ScriptedTurn) => void | Promise<void>;
	/** Default model only. */
	models?: string[];
	/** Refuses one start. */
	startError?: Error;
	/** Set blocks every launch. */
	launchError?: Error;
}

export interface ScriptedAgents {
	drivers: Record<AgentBackendId, AgentDriver>;
	of(backend: AgentBackendId): ScriptedBackend;
	/** Omitting target exits every child. */
	exitChild(backend: AgentBackendId, targetId?: string): void;
	/** Shared supervisor/service clock. */
	clock: { now(): number };
	/** Advances fake clock. */
	skip(ms: number): void;
}

interface Child extends AgentChild {
	targetId: string;
	alive: boolean;
	exit(code: number | null): void;
}

interface Turn extends ScriptedTurn {
	key: string | undefined;
	owner: Session;
	settled: Promise<TurnTerminal>;
}

/** Mirrors real optional methods. */
export const REAL_SESSION: Record<
	AgentBackendId,
	{ inspects: boolean; adopts: boolean; reportsProgress: boolean; reportsBusy: boolean; keysPrompts: boolean }
> = {
	codex: { inspects: true, adopts: true, reportsProgress: true, reportsBusy: true, keysPrompts: false },
	copilot: { inspects: false, adopts: false, reportsProgress: false, reportsBusy: false, keysPrompts: false },
	opencode: { inspects: true, adopts: false, reportsProgress: true, reportsBusy: false, keysPrompts: true },
};

function completeAtOnce(turn: ScriptedTurn): void {
	turn.activity("working");
	turn.settle({ status: "completed", finalResponse: `done: ${turn.prompt}` });
}

function spawnChild(targetId: string): Child {
	const listeners: Array<(info: { code: number | null; signal: string | null }) => void> = [];
	const child: Child = {
		targetId,
		alive: true,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		kill: () => child.exit(null),
		onExit: (listener) => {
			listeners.push(listener);
		},
		exit: (code) => {
			if (!child.alive) return;
			child.alive = false;
			for (const listener of [...listeners]) listener({ code, signal: code === null ? "SIGTERM" : null });
		},
	};
	return child;
}

/** Threads survive child restarts. */
class Backend implements ScriptedBackend {
	turns: Turn[] = [];
	launches = 0;
	onTurn?: ScriptedBackend["onTurn"];
	onSteer?: ScriptedBackend["onSteer"];
	onInterrupt?: ScriptedBackend["onInterrupt"];
	models?: string[];
	startError?: Error;
	launchError?: Error;
	readonly children: Child[] = [];
	readonly threads = new Set<string>();
	/** Each thread's target. */
	readonly places = new Map<string, string>();
	/** Absent reads as unknown. */
	readonly updated = new Map<string, number>();

	readonly parents = new Map<string, string>();

	plant(threadId: string, targetId: string, updatedAt: number | null, parentId?: string): void {
		this.threads.add(threadId);
		this.places.set(threadId, targetId);
		if (updatedAt !== null) this.updated.set(threadId, updatedAt);
		if (parentId !== undefined) this.parents.set(threadId, parentId);
	}
	minted = 0;

	constructor(
		readonly id: AgentBackendId,
		readonly clock: () => number,
	) {}
}

class Session implements AgentBackendSession {
	inspectTurn?: AgentBackendSession["inspectTurn"];
	adoptTurn?: AgentBackendSession["adoptTurn"];
	onProgress?: AgentBackendSession["onProgress"];
	busy?: AgentBackendSession["busy"];
	private activity: (turnId: string, text: string, itemId?: string) => void = () => {};
	private counted: (turnId: string, counter: TurnCounter) => void = () => {};
	private progress: (turnId: string) => void = () => {};
	private closedListener?: () => void;
	private closed = false;

	constructor(
		private readonly backend: Backend,
		private readonly child: Child,
	) {
		const real = REAL_SESSION[backend.id];
		if (real.inspects) this.inspectTurn = (threadId, turnId) => this.inspect(threadId, turnId);
		if (real.adopts) this.adoptTurn = (threadId) => this.adopt(threadId);
		if (real.reportsProgress) {
			this.onProgress = (listener) => {
				this.progress = listener;
			};
		}
		if (real.reportsBusy) this.busy = () => this.mine().some((turn) => turn.state() === "inProgress");
		child.onExit(() => this.close());
	}

	async openThread(): Promise<string> {
		const threadId = `thread-${this.backend.places.size + 1}`;
		this.backend.threads.add(threadId);
		this.backend.places.set(threadId, this.child.targetId);
		this.backend.updated.set(threadId, this.backend.clock());
		return threadId;
	}

	async resumeThread(threadId: string): Promise<void> {
		if (!this.backend.threads.has(threadId)) throw new Error("thread not found");
	}

	async startTurn(threadId: string, prompt: string, options: TurnOptions = {}): Promise<TurnHandle> {
		const refusal = this.backend.startError;
		if (refusal) {
			this.backend.startError = undefined;
			throw refusal;
		}
		if (this.closed) throw new Error("child exited");
		const repeat =
			options.key && REAL_SESSION[this.backend.id].keysPrompts
				? this.backend.turns.find((turn) => turn.key === options.key && turn.threadId === threadId)
				: undefined;
		if (repeat) return { turnId: repeat.turnId, settled: repeat.settled };

		this.backend.minted += 1;
		let state: "inProgress" | TurnTerminal["status"] = "inProgress";
		let resolve: (terminal: TurnTerminal) => void = () => {};
		const turnId = `turn-${this.backend.minted}`;
		const turn: Turn = {
			backend: this.backend.id,
			targetId: this.child.targetId,
			threadId,
			turnId,
			prompt,
			options,
			key: options.key,
			owner: this,
			steers: [],
			interrupts: 0,
			settled: new Promise<TurnTerminal>((inner) => {
				resolve = inner;
			}),
			state: () => state,
			activity: (text, itemId) => {
				if (state === "inProgress" && !this.closed) this.activity(turnId, text, itemId);
			},
			counter: (counter) => {
				if (state === "inProgress" && !this.closed) this.counted(turnId, counter);
			},
			settle: (terminal) => {
				if (state !== "inProgress" || this.closed) return;
				state = terminal.status;
				resolve(terminal);
			},
		};
		this.backend.turns.push(turn);
		(this.backend.onTurn ?? completeAtOnce)(turn);
		return { turnId, settled: turn.settled };
	}

	async steerTurn(threadId: string, turnId: string, prompt: string): Promise<SteerOutcome> {
		const turn = this.running(threadId, turnId);
		if (!turn) throw new Error("turn is no longer active");
		turn.steers.push(prompt);
		if (this.backend.onSteer) return this.backend.onSteer(turn, prompt);
		// Prompt keys confirm steering.
		return REAL_SESSION[this.backend.id].keysPrompts ? "taken" : undefined;
	}

	async interruptTurn(threadId: string, turnId: string): Promise<void> {
		const turn = this.running(threadId, turnId);
		if (!turn) throw new Error("turn is no longer active");
		turn.interrupts += 1;
		if (this.backend.onInterrupt) await this.backend.onInterrupt(turn);
		else turn.settle({ status: "interrupted" });
	}

	private async inspect(threadId: string, turnId: string): Promise<TurnInspection> {
		const turn = this.backend.turns.find((held) => held.turnId === turnId && held.threadId === threadId);
		if (!turn) return { known: "unknown" };
		if (turn.state() !== "inProgress") return { known: "settled", terminal: await turn.settled };
		return turn.owner === this && !this.closed ? { known: "running" } : { known: "unknown" };
	}

	private async adopt(threadId: string): Promise<TurnHandle | undefined> {
		const turn = this.mine().find((held) => held.threadId === threadId && held.state() === "inProgress");
		return turn && !this.closed ? { turnId: turn.turnId, settled: turn.settled } : undefined;
	}

	private mine(): Turn[] {
		return this.backend.turns.filter((turn) => turn.owner === this);
	}

	async listModels() {
		return (this.backend.models ?? [agentBackend(this.backend.id).defaultModel]).map((id) => ({ id }));
	}

	async listThreads(): Promise<ListedThread[]> {
		return [...this.backend.threads]
			.filter((threadId) => this.backend.places.get(threadId) === this.child.targetId)
			.map((threadId) => ({
				threadId,
				updatedAt: this.backend.updated.get(threadId) ?? null,
				parentId: this.backend.parents.get(threadId) ?? null,
			}));
	}

	/** Delete only store-owned threads. */
	async deleteThread(threadId: string): Promise<"deleted" | "gone"> {
		if (this.backend.places.get(threadId) !== this.child.targetId) return "gone";
		return this.backend.threads.delete(threadId) ? "deleted" : "gone";
	}

	onActivity(listener: (turnId: string, text: string, itemId?: string) => void): void {
		this.activity = (turnId, text, itemId) => {
			this.progress(turnId);
			listener(turnId, text, itemId);
		};
	}

	onCounter(listener: (turnId: string, counter: TurnCounter) => void): void {
		this.counted = listener;
	}

	onClosed(listener: () => void): void {
		this.closedListener = listener;
		if (this.closed) listener();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.closedListener?.();
	}

	private running(threadId: string, turnId: string): Turn | undefined {
		if (this.closed) return undefined;
		return this.backend.turns.find(
			(held) =>
				held.turnId === turnId &&
				held.threadId === threadId &&
				held.owner === this &&
				held.state() === "inProgress",
		);
	}
}

/**
 * A driver per backend whose child is a pair of streams, so a harness runs the daemon's real
 * runtime and the only double is the backend's own process.
 *
 * The backends outlive a daemon, as threads on disk do.
 */
export function scriptedAgents(): ScriptedAgents {
	let offset = 0;
	const clock = (): number => Date.now() + offset;
	const backends = new Map(AGENT_BACKENDS.map(({ id }) => [id, new Backend(id, clock)] as const));
	const of = (backend: AgentBackendId): Backend => {
		const held = backends.get(backend);
		if (!held) throw new Error(`no scripted ${backend} backend`);
		return held;
	};
	const driver = (backend: Backend): AgentDriver => ({
		launcher: {
			launch(target) {
				if (backend.launchError) throw backend.launchError;
				const child = spawnChild(target.targetId);
				backend.children.push(child);
				backend.launches += 1;
				return child;
			},
		},
		open: async (child) => new Session(backend, child as Child),
		threadsResumable: AGENT_DRIVERS[backend.id].threadsResumable,
		failureCode: AGENT_DRIVERS[backend.id].failureCode,
		ownRuntime: AGENT_DRIVERS[backend.id].ownRuntime,
	});
	return {
		drivers: Object.fromEntries([...backends].map(([id, backend]) => [id, driver(backend)])) as Record<
			AgentBackendId,
			AgentDriver
		>,
		of,
		exitChild(backend, targetId) {
			for (const child of of(backend).children) {
				if (child.alive && (targetId === undefined || child.targetId === targetId)) child.exit(1);
			}
		},
		clock: { now: clock },
		skip(ms) {
			offset += ms;
		},
	};
}
