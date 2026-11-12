import type { AgentCounterKind } from "../../shared/agent-counter.js";
import type { AgentDaemonFailureCode, AgentServiceTier } from "../../shared/agent-state.js";
import type { AgentChild, ExecutionTargetLauncher } from "../devcontainer/agentTargets.js";

////////////////////////////////
//  Interfaces & Types

export type TurnTerminal =
	| { status: "completed"; finalResponse?: string; finalItemId?: string }
	| { status: "failed"; error: string }
	| { status: "interrupted"; reason?: string };

/** IDs precede terminal results. */
export interface TurnHandle {
	turnId: string;
	/** Failures resolve as terminals. */
	settled: Promise<TurnTerminal>;
}

export interface ThreadOptions {
	cwd: string;
	model?: string;
	serviceTier?: AgentServiceTier;
	reasoningEffort?: string;
}

export interface TurnOptions {
	/** Model selects service tier. */
	model?: string;
	serviceTier?: AgentServiceTier;
	outputSchema?: Record<string, unknown>;
	/** Deduplicate prompts by key. */
	key?: string;
}

export interface TurnCounter {
	kind: AgentCounterKind;
	itemId?: string;
	filesChanged?: number;
}

// biome-ignore lint/suspicious/noConfusingVoidType: a driver that cannot tell resolves with nothing.
export type SteerOutcome = "taken" | void;

export type TurnInspection = { known: "running" } | { known: "settled"; terminal: TurnTerminal } | { known: "unknown" };

export interface AgentModel {
	id: string;
	reasoningEfforts?: string[];
}

export interface AgentBackendSession {
	/** Thread directory stays fixed. */
	openThread(options: ThreadOptions): Promise<string>;
	/** Omit for ephemeral threads. */
	resumeThread?(threadId: string, cwd: string): Promise<void>;
	/** Resolves on acceptance; later failure settles terminal. */
	startTurn(threadId: string, prompt: string, turn?: TurnOptions): Promise<TurnHandle>;
	/**
	 * Omit to disable steering. `taken`: the turn holds the prompt. Anything else: only sent, so a
	 * turn that ended since is given it again as a new turn.
	 */
	steerTurn?(threadId: string, turnId: string, prompt: string, key?: string): Promise<SteerOutcome>;
	interruptTurn(threadId: string, turnId: string): Promise<void>;
	/** A settled read ends the handle. */
	inspectTurn?(threadId: string, turnId: string): Promise<TurnInspection>;
	/** The thread's running turn, as the caller's. */
	adoptTurn?(threadId: string): Promise<TurnHandle | undefined>;
	listModels?(): Promise<AgentModel[]>;
	onActivity(listener: (turnId: string, text: string, itemId?: string) => void): void;
	onCounter?(listener: (turnId: string, counter: TurnCounter) => void): void;
	/** Omit to disable silence checks. */
	onProgress?(listener: (turnId: string) => void): void;
	/** True while work prevents reaping. */
	busy?(): boolean;
	/** Closure evicts cache; late listeners fire immediately. */
	onClosed(listener: () => void): void;
	close(): void;
}

/** The terminal a turn already holds, once every earlier reader of it has run. */
export function settledNow(settled: Promise<TurnTerminal>): Promise<TurnTerminal | undefined> {
	return Promise.race([settled, Promise.resolve().then(() => undefined)]);
}

export interface AgentDriver {
	launcher: ExecutionTargetLauncher;
	open(child: AgentChild): Promise<AgentBackendSession>;
	/** Reopen thread state after reap. */
	threadsResumable: boolean;
	/** Classify driver refusal text. */
	failureCode?(error: string): AgentDaemonFailureCode | undefined;
	/** Its child is this build's own entry point, which a container must hold first. */
	ownRuntime?: true;
}
