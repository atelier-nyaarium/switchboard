import type { AgentCounterKind } from "../../shared/agent-counter.js";
import type { AgentDaemonFailureCode, AgentServiceTier } from "../../shared/agent-state.js";
import type { AgentChild, ExecutionTargetLauncher } from "../devcontainer/codexTargets.js";

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
	startTurn(threadId: string, prompt: string, turn?: TurnOptions): Promise<TurnHandle>;
	/** Omit to disable steering. */
	steerTurn?(threadId: string, turnId: string, prompt: string, key?: string): Promise<void>;
	interruptTurn(threadId: string, turnId: string): Promise<void>;
	/** Optional without readable history. */
	inspectTurn?(threadId: string, turnId: string): Promise<TurnInspection>;
	listModels?(): Promise<AgentModel[]>;
	onActivity(listener: (turnId: string, text: string, itemId?: string) => void): void;
	onCounter?(listener: (turnId: string, counter: TurnCounter) => void): void;
	/** Evict cache on closure. */
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
}
