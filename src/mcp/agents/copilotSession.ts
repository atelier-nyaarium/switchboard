import crypto from "node:crypto";
import { COPILOT_BACKEND } from "../../shared/agent-backend.js";
import { counterKindOfTool } from "../../shared/agent-counter.js";
import type { AgentDaemonFailureCode } from "../../shared/agent-state.js";
import type { AgentChild } from "../devcontainer/agentTargets.js";
import {
	type CopilotHeadlessClient,
	defaultOpenCopilotClient,
	type HeadlessModel,
	HeadlessTurn,
	type SessionEvent,
} from "../devcontainer/copilotHeadless.js";
import type {
	AgentBackendSession,
	AgentModel,
	ThreadOptions,
	TurnCounter,
	TurnHandle,
	TurnOptions,
	TurnTerminal,
} from "./backendSession.js";

////////////////////////////////
//  Interfaces & Types

interface ActiveTurn {
	turnId: string;
	turn: HeadlessTurn;
	cancelled: boolean;
	settle: (terminal: TurnTerminal) => void;
}

////////////////////////////////
//  Functions & Helpers

export function copilotFailureCode(error: string): AgentDaemonFailureCode {
	if (/auth|login|not logged in|unauthori[sz]ed|credential/i.test(error)) return "authentication_required";
	if (/protocol version|incompatible/i.test(error)) return "protocol_incompatible";
	if (/timed out|timeout|exited|closed|broken pipe/i.test(error)) return "app_server_unavailable";
	if (/target|container|binary|unavailable/i.test(error)) return "daemon_unavailable";
	return "protocol_error";
}

////////////////////////////////
//  Class

export class CopilotBackendSession implements AgentBackendSession {
	private readonly active = new Map<string, ActiveTurn>();
	private activityListener?: (turnId: string, text: string, itemId?: string) => void;
	private counterListener?: (turnId: string, counter: TurnCounter) => void;
	private closedListener?: () => void;
	private closed = false;

	private constructor(
		private readonly client: CopilotHeadlessClient,
		/** Unreadable catalogs skip validation. */
		private readonly models: HeadlessModel[],
	) {}

	static async open(
		child: AgentChild,
		openClient: (child: AgentChild) => Promise<CopilotHeadlessClient> = defaultOpenCopilotClient,
	): Promise<CopilotBackendSession> {
		const client = await openClient(child);
		let exited = false;
		let opened: CopilotBackendSession | undefined;
		// Exit settles active turns.
		child.onExit(() => {
			exited = true;
			if (!opened) return;
			opened.closed = true;
			opened.settleAll({ status: "failed", error: `Copilot exited` });
			opened.closedListener?.();
		});
		const models = await client.listModels().catch((): HeadlessModel[] => []);
		// Nothing would evict a session whose child left before it opened.
		if (exited) throw new Error(`Copilot exited`);
		const session = new CopilotBackendSession(client, models);
		client.onEvent((sessionId, event) => session.onEvent(sessionId, event));
		opened = session;
		return session;
	}

	onActivity(listener: (turnId: string, text: string, itemId?: string) => void): void {
		this.activityListener = listener;
	}

	onCounter(listener: (turnId: string, counter: TurnCounter) => void): void {
		this.counterListener = listener;
	}

	onClosed(listener: () => void): void {
		this.closedListener = listener;
		if (this.closed) listener();
	}

	async listModels(): Promise<AgentModel[]> {
		return this.models.map((model) => ({ id: model.id, reasoningEfforts: [...model.reasoningEfforts] }));
	}

	async openThread(options: ThreadOptions): Promise<string> {
		const model = options.model ?? COPILOT_BACKEND.defaultModel;
		const effort = options.reasoningEffort;
		const offered = this.models.find((candidate) => candidate.id === model)?.reasoningEfforts;
		if (effort !== undefined && offered !== undefined && !offered.includes(effort))
			throw new Error(`reasoning effort ${effort} is not offered for ${model}; offered: ${offered.join(", ")}`);
		return this.client.createSession({ cwd: options.cwd, model, reasoningEffort: effort });
	}

	async resumeThread(sessionId: string, cwd: string): Promise<void> {
		await this.client.resumeSession(sessionId, cwd);
	}

	async startTurn(sessionId: string, prompt: string, turn: TurnOptions = {}): Promise<TurnHandle> {
		// Copilot lacks turn IDs.
		const turnId = crypto.randomUUID();
		let settle: (terminal: TurnTerminal) => void = () => undefined;
		const settled = new Promise<TurnTerminal>((resolve) => {
			settle = resolve;
		});
		const active: ActiveTurn = { turnId, turn: new HeadlessTurn(), cancelled: false, settle };
		this.active.set(sessionId, active);
		// Not awaited: a child slow to answer must not hold the turn's acceptance.
		void this.client.send(sessionId, prompt, { outputSchema: turn.outputSchema }).catch((error) => {
			this.retire(sessionId, active);
			const text = error instanceof Error ? error.message : String(error);
			settle({ status: "failed", error: text.trim() || `copilot turn failed` });
		});
		return { turnId, settled };
	}

	async steerTurn(sessionId: string, turnId: string, prompt: string): Promise<void> {
		const active = this.active.get(sessionId);
		if (!active || active.turnId !== turnId) throw new Error(`Copilot turn is no longer active`);
		await this.client.steer(sessionId, prompt);
	}

	async interruptTurn(sessionId: string, turnId: string): Promise<void> {
		const active = this.active.get(sessionId);
		if (!active || active.turnId !== turnId) return;
		// Mark cancellation before abort.
		active.cancelled = true;
		await this.client.abort(sessionId);
	}

	close(): void {
		this.settleAll({ status: "failed", error: `Copilot closed` });
		this.client.close();
	}

	private settleAll(terminal: TurnTerminal): void {
		for (const active of this.active.values()) active.settle(terminal);
		this.active.clear();
	}

	/** Late events cannot clear successors. */
	private retire(sessionId: string, active: ActiveTurn): void {
		if (this.active.get(sessionId) === active) this.active.delete(sessionId);
	}

	private onEvent(sessionId: string, event: SessionEvent): void {
		const active = this.active.get(sessionId);
		if (!active) return;
		if (event.type === "tool.execution_start")
			this.counterListener?.(active.turnId, { kind: counterKindOfTool(String(event.data?.toolName ?? "")) });
		for (const text of active.turn.fold(event)) this.activityListener?.(active.turnId, text);
		const terminal = active.turn.settle(event);
		if (!terminal) return;
		this.retire(sessionId, active);
		active.settle(active.cancelled ? { status: "interrupted" } : terminal);
	}
}
