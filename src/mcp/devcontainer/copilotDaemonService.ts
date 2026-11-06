import crypto from "node:crypto";
import type { AgentResolvedTarget } from "../../shared/agent-execution-target.js";
import {
	COPILOT_DEFAULT_MODEL,
	type CopilotDaemonCommand,
	CopilotDaemonCommandSchema,
	type CopilotDaemonEvent,
	CopilotDaemonEventSchema,
	type CopilotDaemonFailureCode,
	CopilotDaemonHelloSchema,
	type CopilotDaemonReceipt,
	CopilotDaemonReceiptSchema,
	isReliableCopilotMessage,
	sanitizeCopilotErrorText,
} from "../../shared/copilot-agent.js";
import { AgentDaemonCore, type AgentEventAck } from "./agentDaemonCore.js";
import { resolveAgentTarget } from "./agentTargetResolve.js";
import type { AgentChild, TargetLease, TargetSupervisor } from "./codexTargets.js";
import {
	type CopilotHeadlessClient,
	defaultOpenCopilotClient,
	HeadlessTurn,
	type SessionEvent,
} from "./copilotHeadless.js";

////////////////////////////////
//  Interfaces & Types

export interface CopilotDaemonDeps {
	targets: TargetSupervisor;
	daemonInstanceId: string;
	send(message: Record<string, unknown>): void;
	openClient?(child: AgentChild): Promise<CopilotHeadlessClient>;
	resolveHostCwd(hint: string | undefined): string;
	now?(): number;
}

interface Binding {
	ownerKey: string;
	agentId: string;
	sessionId: string;
}

interface ActivePrompt {
	binding: Binding;
	turnId: string;
	turn: HeadlessTurn;
	cancelled: boolean;
}

interface TargetSession {
	targetId: string;
	generation: number;
	client: CopilotHeadlessClient;
	nextEventId: number;
	sessions: Map<string, Binding>;
	active: Map<string, ActivePrompt>;
}

////////////////////////////////
//  Functions & Helpers

function describe(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return sanitizeCopilotErrorText(text) || `Copilot command failed`;
}

function failureCode(error: string): CopilotDaemonFailureCode {
	if (/auth|login|not logged in|unauthori[sz]ed|credential/i.test(error)) return "authentication_required";
	if (/protocol version|incompatible/i.test(error)) return "protocol_incompatible";
	if (/timed out|timeout|exited|closed|broken pipe/i.test(error)) return "app_server_unavailable";
	if (/target|container|binary|unavailable/i.test(error)) return "daemon_unavailable";
	return "protocol_error";
}

////////////////////////////////
//  Class

export class CopilotDaemonService {
	private readonly core: AgentDaemonCore<TargetSession>;
	private readonly openErrors = new Map<string, string>();

	constructor(private readonly deps: CopilotDaemonDeps) {
		this.core = new AgentDaemonCore({
			backendId: "copilot",
			daemonInstanceId: deps.daemonInstanceId,
			targets: deps.targets,
			send: deps.send,
			isReliable: isReliableCopilotMessage,
			helloSchema: CopilotDaemonHelloSchema,
		});
	}

	hello(): Record<string, unknown> {
		return this.core.hello();
	}

	replay(): void {
		this.core.replay();
	}

	acknowledge(ack: AgentEventAck): void {
		this.core.acknowledge(ack);
	}

	handleCommand(raw: unknown): void {
		const parsed = CopilotDaemonCommandSchema.safeParse(raw);
		if (!parsed.success) return;
		const command = parsed.data;
		this.core.enqueue(
			command,
			(next) => this.dispatch(next),
			(next, error) => this.reject(next, error),
			describe,
		);
	}

	shutdown(): void {
		this.core.shutdown();
	}

	private async dispatch(command: CopilotDaemonCommand): Promise<void> {
		switch (command.kind) {
			case "start":
				return this.runStart(command);
			case "message":
				return this.runMessage(command);
			case "interrupt":
				return this.runInterrupt(command);
			case "reconcile":
				return this.runReconcile(command);
		}
	}

	private async runStart(command: Extract<CopilotDaemonCommand, { kind: "start" }>): Promise<void> {
		const target = resolveAgentTarget(command.target, this.deps.resolveHostCwd);
		const session = await this.session(target);
		if (!session)
			return this.reject(command, this.openErrors.get(target.targetId) ?? `execution target is unavailable`);
		let sessionId: string;
		try {
			sessionId = await session.client.createSession({
				cwd: target.cwd,
				model: command.model ?? COPILOT_DEFAULT_MODEL,
			});
		} catch (error) {
			return this.reject(command, describe(error));
		}
		const turnId = crypto.randomUUID();
		const binding: Binding = { ownerKey: command.ownerKey, agentId: command.agentId, sessionId };
		session.sessions.set(sessionId, binding);
		this.emitReceipt(session, command, {
			kind: "accepted",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			agentId: command.agentId,
			operationId: command.operationId,
			resolvedTarget: target,
			sessionId,
			turnId,
			delivery: "started",
		});
		void this.runPrompt(session, binding, turnId, command.prompt);
	}

	private async runMessage(command: Extract<CopilotDaemonCommand, { kind: "message" }>): Promise<void> {
		const session = await this.session(command.target);
		if (!session)
			return this.reject(
				command,
				this.openErrors.get(command.target.targetId) ?? `execution target is unavailable`,
			);
		const binding: Binding = { ownerKey: command.ownerKey, agentId: command.agentId, sessionId: command.sessionId };
		if (session.active.has(command.sessionId)) return this.reject(command, `Copilot agent is still working`);
		if (!session.sessions.has(command.sessionId)) {
			try {
				await session.client.resumeSession(command.sessionId, command.target.cwd);
			} catch (error) {
				return this.reject(command, describe(error));
			}
			session.sessions.set(command.sessionId, binding);
		}
		const turnId = crypto.randomUUID();
		this.emitReceipt(session, command, {
			kind: "accepted",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			agentId: command.agentId,
			operationId: command.operationId,
			resolvedTarget: command.target,
			sessionId: command.sessionId,
			turnId,
			delivery: "followup",
		});
		void this.runPrompt(session, binding, turnId, command.prompt);
	}

	/** The send answers at once; the turn settles from its events in `onEvent`. */
	private async runPrompt(session: TargetSession, binding: Binding, turnId: string, prompt: string): Promise<void> {
		const active: ActivePrompt = { binding, turnId, turn: new HeadlessTurn(), cancelled: false };
		session.active.set(binding.sessionId, active);
		try {
			await session.client.send(binding.sessionId, prompt);
		} catch (error) {
			if (session.active.get(binding.sessionId) !== active) return;
			session.active.delete(binding.sessionId);
			this.emitTerminal(session, active, { state: "failed", error: describe(error) });
		}
	}

	private emitTerminal(
		session: TargetSession,
		active: ActivePrompt,
		outcome:
			| { state: "completed"; finalResponse: string }
			| { state: "failed"; error: string }
			| { state: "interrupted" },
	): void {
		this.emitEvent(session, {
			kind: "terminal",
			ownerKey: active.binding.ownerKey,
			agentId: active.binding.agentId,
			sessionId: active.binding.sessionId,
			turnId: active.turnId,
			...outcome,
		});
	}

	private async runInterrupt(command: Extract<CopilotDaemonCommand, { kind: "interrupt" }>): Promise<void> {
		const session = await this.session(command.target);
		if (!session)
			return this.reject(
				command,
				this.openErrors.get(command.target.targetId) ?? `execution target is unavailable`,
			);
		const active = session.active.get(command.sessionId);
		if (!active || active.turnId !== command.turnId)
			return this.reject(command, `Copilot turn is no longer active`);
		active.cancelled = true;
		try {
			await session.client.abort(command.sessionId);
		} catch (error) {
			return this.reject(command, describe(error));
		}
		this.emitReceipt(session, command, {
			kind: "interruptResult",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			agentId: command.agentId,
			operationId: command.operationId,
			sessionId: command.sessionId,
			turnId: command.turnId,
			ok: true,
		});
	}

	private async runReconcile(command: Extract<CopilotDaemonCommand, { kind: "reconcile" }>): Promise<void> {
		const session = await this.session(command.target);
		if (!session)
			return this.reject(
				command,
				this.openErrors.get(command.target.targetId) ?? `execution target is unavailable`,
			);
		const active = session.active.get(command.sessionId);
		if (!active) {
			try {
				await session.client.resumeSession(command.sessionId, command.target.cwd);
			} catch (error) {
				return this.reject(command, describe(error));
			}
			session.sessions.set(command.sessionId, {
				ownerKey: command.ownerKey,
				agentId: command.agentId,
				sessionId: command.sessionId,
			});
		}
		this.emitReceipt(session, command, {
			kind: "reconciled",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			agentId: command.agentId,
			sessionId: command.sessionId,
			turnId: active?.turnId ?? command.turnId,
			active: !!active,
		});
	}

	private session(target: AgentResolvedTarget): Promise<TargetSession | null> {
		return this.core.acquireSession(target, (resolved, lease) => this.open(resolved, lease));
	}

	private async open(target: AgentResolvedTarget, lease: TargetLease): Promise<TargetSession | null> {
		const opened = this.deps.openClient ?? defaultOpenCopilotClient;
		let client: CopilotHeadlessClient;
		try {
			client = await opened(lease.child);
		} catch (error) {
			this.openErrors.set(target.targetId, describe(error));
			this.deps.targets.release(target.targetId, lease.generation);
			return null;
		}
		this.openErrors.delete(target.targetId);
		const session: TargetSession = {
			targetId: target.targetId,
			generation: lease.generation,
			client,
			nextEventId: 0,
			sessions: new Map(),
			active: new Map(),
		};
		client.onEvent((sessionId, event) => this.onEvent(session, sessionId, event));
		return session;
	}

	private onEvent(session: TargetSession, sessionId: string, event: SessionEvent): void {
		const active = session.active.get(sessionId);
		if (!active) return;
		for (const text of active.turn.fold(event)) {
			this.emitEvent(session, {
				kind: "activity",
				ownerKey: active.binding.ownerKey,
				agentId: active.binding.agentId,
				sessionId: active.binding.sessionId,
				turnId: active.turnId,
				itemId: crypto.randomUUID(),
				text,
			});
		}
		const terminal = active.turn.settle(event);
		if (!terminal) return;
		session.active.delete(sessionId);
		if (active.cancelled || terminal.status === "interrupted") {
			this.emitTerminal(session, active, { state: "interrupted" });
		} else if (terminal.status === "failed") {
			this.emitTerminal(session, active, {
				state: "failed",
				error: sanitizeCopilotErrorText(terminal.error) || `Copilot turn failed`,
			});
		} else {
			this.emitTerminal(session, active, { state: "completed", finalResponse: terminal.finalResponse });
		}
	}

	private emitEvent(session: TargetSession, event: Record<string, unknown>): void {
		this.core.publish(session, { type: "copilot_event", ...event }, CopilotDaemonEventSchema, "first");
	}

	/**
	 * A receipt carries this generation's fence, which the gateway drops once it has retired it.
	 *
	 * So a command whose generation died mid-flight is refused instead: a refusal carries no
	 * generation and is delivered, where an acceptance the gateway fences out hangs the caller.
	 */
	private emitReceipt(session: TargetSession, command: CopilotDaemonCommand, receipt: Record<string, unknown>): void {
		if (!this.core.live(session)) {
			this.reject(command, `Copilot generation was retired mid-command`);
			return;
		}
		this.core.publish(
			session,
			{
				type: "copilot_receipt",
				daemonInstanceId: this.deps.daemonInstanceId,
				targetId: session.targetId,
				generation: session.generation,
				...receipt,
			},
			CopilotDaemonReceiptSchema,
			"first",
		);
	}

	private reject(command: CopilotDaemonCommand, error: string): void {
		const normalized = sanitizeCopilotErrorText(error) || `Copilot command failed`;
		const message = {
			type: "copilot_receipt",
			kind: "rejected",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			daemonInstanceId: this.deps.daemonInstanceId,
			agentId: command.agentId,
			...(command.kind === "reconcile" ? {} : { operationId: command.operationId }),
			eventId: this.core.rejectionId(),
			failureCode: failureCode(normalized),
			error: normalized,
		};
		if (CopilotDaemonReceiptSchema.safeParse(message).success) this.deps.send(message);
	}
}

export type { CopilotDaemonEvent, CopilotDaemonReceipt };
