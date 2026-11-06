// The daemon's own headless client, driven directly. A send answers at once; the turn's events carry
// the answer and `session.idle` settles it, which is why a running turn is tracked at all.

import crypto from "node:crypto";
import { COPILOT_DEFAULT_MODEL } from "../../shared/copilot-agent.js";
import type { AgentChild } from "../devcontainer/codexTargets.js";
import type { CopilotHeadlessClient, SessionEvent } from "../devcontainer/copilotHeadless.js";
import { defaultOpenCopilotClient, HeadlessTurn } from "../devcontainer/copilotHeadless.js";
import type { LocalBackendSession, LocalTerminal, LocalTurnHandle } from "./localAgentSession.js";

////////////////////////////////
//  Interfaces & Types

interface ActiveTurn {
	turnId: string;
	turn: HeadlessTurn;
	cancelled: boolean;
	settle: (terminal: LocalTerminal) => void;
}

////////////////////////////////
//  Class

/** One `copilot --headless --stdio` child, driven directly. */
export class CopilotLocalSession implements LocalBackendSession {
	private readonly active = new Map<string, ActiveTurn>();
	private activityListener?: (turnId: string, text: string) => void;
	private closedListener?: () => void;

	private constructor(private readonly client: CopilotHeadlessClient) {}

	static async open(child: AgentChild): Promise<CopilotLocalSession> {
		const client = await defaultOpenCopilotClient(child);
		const session = new CopilotLocalSession(client);
		client.onEvent((sessionId, event) => session.onEvent(sessionId, event));
		// A running turn has no pending request to reject, so the exit settles it here.
		child.onExit(() => {
			session.settleAll({ status: "failed", error: `Copilot exited` });
			session.closedListener?.();
		});
		return session;
	}

	onActivity(listener: (turnId: string, text: string) => void): void {
		this.activityListener = listener;
	}

	onClosed(listener: () => void): void {
		this.closedListener = listener;
	}

	async openThread(options: { cwd: string; model?: string; reasoningEffort?: string }): Promise<string> {
		return this.client.createSession({
			cwd: options.cwd,
			model: options.model ?? COPILOT_DEFAULT_MODEL,
			reasoningEffort: options.reasoningEffort,
		});
	}

	async startTurn(
		sessionId: string,
		prompt: string,
		turn: { outputSchema?: Record<string, unknown> } = {},
	): Promise<LocalTurnHandle> {
		// Minted here: the runtime's turn ids repeat per message, and the runtime needs one up front.
		const turnId = crypto.randomUUID();
		let settle: (terminal: LocalTerminal) => void = () => undefined;
		const settled = new Promise<LocalTerminal>((resolve) => {
			settle = resolve;
		});
		const active: ActiveTurn = { turnId, turn: new HeadlessTurn(), cancelled: false, settle };
		this.active.set(sessionId, active);
		try {
			await this.client.send(sessionId, prompt, { outputSchema: turn.outputSchema });
		} catch (error) {
			this.retire(sessionId, active);
			const text = error instanceof Error ? error.message : String(error);
			settle({ status: "failed", error: text.trim() || `copilot turn failed` });
		}
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
		// Marked before the abort, so the idle it causes reads as interrupted either way.
		active.cancelled = true;
		await this.client.abort(sessionId);
	}

	close(): void {
		this.settleAll({ status: "failed", error: `Copilot closed` });
		this.client.close();
	}

	private settleAll(terminal: LocalTerminal): void {
		for (const active of this.active.values()) active.settle(terminal);
		this.active.clear();
	}

	/** A late event from a replaced turn must not clear its successor. */
	private retire(sessionId: string, active: ActiveTurn): void {
		if (this.active.get(sessionId) === active) this.active.delete(sessionId);
	}

	private onEvent(sessionId: string, event: SessionEvent): void {
		const active = this.active.get(sessionId);
		if (!active) return;
		for (const text of active.turn.fold(event)) this.activityListener?.(active.turnId, text);
		const terminal = active.turn.settle(event);
		if (!terminal) return;
		this.retire(sessionId, active);
		active.settle(active.cancelled ? { status: "interrupted" } : terminal);
	}
}
