import type { AgentServiceTier as CodexServiceTier } from "../../shared/agent-state.js";
import type { AgentChild } from "./agentTargets.js";
import { CodexAppServerClient, createJsonlTransport, type LifecycleHooks } from "./codexAppServer.js";
import type { ThreadInspection, ThreadPhase } from "./codexThreadLifecycle.js";
import type { TerminalOutcome } from "./codexTurnOutcome.js";

////////////////////////////////
//  Interfaces & Types

export interface AppServerSession {
	onEvent(listener: (message: { method: string; params?: unknown }) => void): void;
	startThread(settings: { cwd: string; model?: string; serviceTier?: CodexServiceTier }): Promise<string>;
	resumeThread(threadId: string): Promise<void>;
	/** Loads and owns running turns; publishes and deletes nothing. */
	adoptThread(threadId: string): Promise<ThreadInspection>;
	readThread(threadId: string): Promise<unknown>;
	/** `onStarted` precedes buffered terminal publication. */
	startTurn(
		threadId: string,
		text: string,
		onStarted: (turnId: string) => void,
		turn?: { model?: string; serviceTier?: CodexServiceTier; outputSchema?: Record<string, unknown> },
	): Promise<string>;
	steerTurn(threadId: string, turnId: string, text: string): Promise<void>;
	interruptTurn(threadId: string, turnId: string): Promise<void>;
	/** All observers settle here before parking. */
	settleTurn(threadId: string, turnId: string, terminal: TerminalOutcome): Promise<void>;
	/** State gates child reaping. */
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
