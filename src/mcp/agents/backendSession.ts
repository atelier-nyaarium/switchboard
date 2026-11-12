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
	/** Names this prompt: a repeat under the same key lands once. */
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
	/** Optional for ephemeral threads. */
	resumeThread?(threadId: string, cwd: string): Promise<void>;
	/** Answers once the prompt is on its way, within a bound; a later failure is the handle's terminal. */
	startTurn(threadId: string, prompt: string, turn?: TurnOptions): Promise<TurnHandle>;
	/**
	 * Omit to disable steering. `taken` says the turn is known to hold the prompt; anything else says
	 * only that it was sent, so a turn that ended meanwhile is given the prompt again as a new turn.
	 */
	steerTurn?(threadId: string, turnId: string, prompt: string, key?: string): Promise<SteerOutcome>;
	interruptTurn(threadId: string, turnId: string): Promise<void>;
	/** Optional without readable history. A settled read also ends the turn's handle. */
	inspectTurn?(threadId: string, turnId: string): Promise<TurnInspection>;
	/** The turn its thread runs now, as the caller's. */
	adoptTurn?(threadId: string): Promise<TurnHandle | undefined>;
	listModels?(): Promise<AgentModel[]>;
	onActivity(listener: (turnId: string, text: string, itemId?: string) => void): void;
	onCounter?(listener: (turnId: string, counter: TurnCounter) => void): void;
	/** Absent progress disables silence checks. */
	onProgress?(listener: (turnId: string) => void): void;
	/** Own work prevents reaping. */
	busy?(): boolean;
	/** Evict cache on closure. A listener set after the close is called at once. */
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
	/** Reload threads after reap. */
	threadsResumable: boolean;
	/** Map recognizable refusal text. */
	failureCode?(error: string): AgentDaemonFailureCode | undefined;
	/** Its child is this build's own entry point, which a container must hold first. */
	ownRuntime?: true;
}
