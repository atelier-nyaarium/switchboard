import type { AgentServiceTier as CodexServiceTier } from "../../shared/agent-state.js";
import type { AgentChild } from "./agentTargets.js";
import { CodexAppServerClient, createJsonlTransport, type LifecycleHooks } from "./codexAppServer.js";
import type { ThreadInspection, ThreadPhase } from "./codexThreadLifecycle.js";
import type { TerminalOutcome } from "./codexTurnOutcome.js";

////////////////////////////////
//  Interfaces & Types

/** Separate from the client class so a test can stand in without a child process. */
export interface AppServerSession {
	onEvent(listener: (message: { method: string; params?: unknown }) => void): void;
	startThread(settings: { cwd: string; model?: string; serviceTier?: CodexServiceTier }): Promise<string>;
	resumeThread(threadId: string): Promise<void>;
	/** Loads the thread and owns a running turn; publishes and deletes nothing. */
	adoptThread(threadId: string): Promise<ThreadInspection>;
	readThread(threadId: string): Promise<unknown>;
	/**
	 * Start a turn, registering for it in `onStarted`, which runs before any terminal buffered for the
	 * new turn is published. The type cannot make a double CALL it: a start whose callback never ran
	 * is refused, and `app-server-double-residue.test.ts` holds the doubles.
	 */
	startTurn(
		threadId: string,
		text: string,
		onStarted: (turnId: string) => void,
		turn?: { model?: string; serviceTier?: CodexServiceTier; outputSchema?: Record<string, unknown> },
	): Promise<string>;
	steerTurn(threadId: string, turnId: string, text: string): Promise<void>;
	interruptTurn(threadId: string, turnId: string): Promise<void>;
	/** The one place a terminal SETTLES, whichever observer produced it; the thread parks behind it. */
	settleTurn(threadId: string, turnId: string, terminal: TerminalOutcome): Promise<void>;
	/** What the owner believes about a thread, which is what says whether a child is reapable. */
	stateOf(threadId: string): ThreadPhase | undefined;
	models(): Promise<string[]>;
	close(): void;
}

////////////////////////////////
//  Functions & Helpers

export async function defaultOpenClient(
	child: AgentChild,
	model: string,
	hooks: LifecycleHooks = {},
): Promise<CodexAppServerClient> {
	return CodexAppServerClient.open(createJsonlTransport(child), model, hooks);
}
