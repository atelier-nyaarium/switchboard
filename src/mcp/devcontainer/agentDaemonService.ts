import crypto from "node:crypto";
import { type AgentBackendDescriptor, agentFrameType } from "../../shared/agent-backend.js";
import type { AgentResolvedTarget } from "../../shared/agent-execution-target.js";
import { agentErrorText } from "../../shared/agent-identity.js";
import type { AgentDaemonFailureCode } from "../../shared/agent-state.js";
import { type AgentDaemonCommand, agentWire, isReliableAgentMessage } from "../../shared/agent-wire.js";
import {
	type AgentBackendSession,
	settledNow,
	type TurnCounter,
	type TurnHandle,
	type TurnOptions,
	type TurnTerminal,
} from "../agents/backendSession.js";
import { AgentDaemonCore, type AgentEventAck } from "./agentDaemonCore.js";
import { resolveAgentTarget } from "./agentTargetResolve.js";
import type { AgentChild, TargetLease, TargetSupervisor } from "./codexTargets.js";

////////////////////////////////
//  Interfaces & Types

export interface AgentDaemonDeps {
	backend: AgentBackendDescriptor;
	targets: TargetSupervisor;
	daemonInstanceId: string;
	send(message: Record<string, unknown>): void;
	open(child: AgentChild): Promise<AgentBackendSession>;
	resolveHostCwd(hint: string | undefined): string;
	failureCode?(error: string): AgentDaemonFailureCode | undefined;
	/** What a target must hold before a child launches there. */
	prepareTarget?(target: AgentResolvedTarget): Promise<void>;
}

interface Binding {
	ownerKey: string;
	agentId: string;
	threadId: string;
}

interface NamedTurn {
	binding: Binding;
	turnId: string;
}

interface ActiveTurn extends NamedTurn {
	settled: Promise<TurnTerminal>;
}

interface TargetSession {
	targetId: string;
	generation: number;
	client: AgentBackendSession;
	nextEventId: number;
	threads: Map<string, Binding>;
	/** One turn per thread. */
	active: Map<string, ActiveTurn>;
	/** Buffers events before announcement. */
	held: Map<string, Array<() => void>>;
	/** Its driver closed, perhaps before it was held as live. */
	closed: boolean;
}

type Command<Kind extends AgentDaemonCommand["kind"]> = Extract<AgentDaemonCommand, { kind: Kind }>;

////////////////////////////////
//  Constants

const HELD_TURNS_MAX = 32;
const HELD_EVENTS_MAX = 64;

////////////////////////////////
//  Class

export class AgentDaemonService {
	private readonly core: AgentDaemonCore<TargetSession>;
	private readonly wire: ReturnType<typeof agentWire>;
	private readonly openErrors = new Map<string, string>();
	private readonly name: string;
	private stopped = false;

	constructor(private readonly deps: AgentDaemonDeps) {
		this.wire = agentWire(deps.backend.id);
		this.name = deps.backend.displayName;
		this.core = new AgentDaemonCore({
			backendId: deps.backend.id,
			daemonInstanceId: deps.daemonInstanceId,
			targets: deps.targets,
			send: deps.send,
			isReliable: (message) => isReliableAgentMessage(message as Parameters<typeof isReliableAgentMessage>[0]),
			helloSchema: this.wire.hello,
			retiredTurnTerminalizers: (session) =>
				[...session.active.values()].map(
					(active) => (reason) => this.emitTerminal(session, active, { status: "interrupted", reason }),
				),
			onRetire: (session) => {
				session.active.clear();
				session.held.clear();
			},
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
		const parsed = this.wire.command.safeParse(raw);
		if (!parsed.success) return;
		const command = parsed.data;
		if (this.stopped) {
			this.reject(command, `${this.name} daemon is shutting down`);
			return;
		}
		this.core.enqueue(
			command,
			(next) => this.dispatch(next),
			(next, error) => this.reject(next, error),
			(error) => this.describe(error),
		);
	}

	shutdown(): void {
		this.stopped = true;
		this.core.shutdown();
	}

	private dispatch(command: AgentDaemonCommand): Promise<void> {
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

	private async runStart(command: Command<"start">): Promise<void> {
		const target = resolveAgentTarget(command.target, this.deps.resolveHostCwd);
		const session = await this.session(target);
		if (!session) return this.reject(command, this.unavailable(target));
		const threadId = await session.client.openThread({
			cwd: target.cwd,
			model: command.model ?? this.deps.backend.defaultModel,
			serviceTier: command.serviceTier,
			reasoningEffort: command.reasoningEffort,
		});
		const binding: Binding = { ownerKey: command.ownerKey, agentId: command.agentId, threadId };
		session.threads.set(threadId, binding);
		await this.beginTurn(session, command, target, binding, {
			model: command.model,
			serviceTier: command.serviceTier,
			outputSchema: command.outputSchema,
			key: command.operationId,
		});
	}

	private async runMessage(command: Command<"message">): Promise<void> {
		const session = await this.session(command.target);
		if (!session) return this.reject(command, this.unavailable(command.target));
		const binding: Binding = { ownerKey: command.ownerKey, agentId: command.agentId, threadId: command.sessionId };
		const active = session.active.get(command.sessionId);
		if (active) {
			// Never steer a successor.
			if (!session.client.steerTurn || command.expectedTurnId !== active.turnId)
				return this.reject(command, `${this.name} agent is still working`);
			let steerError: unknown;
			let taken = false;
			try {
				const outcome = await session.client.steerTurn(
					command.sessionId,
					active.turnId,
					command.prompt,
					command.operationId,
				);
				taken = outcome === "taken";
			} catch (error) {
				steerError = error;
			}
			if (!taken) await settledNow(active.settled);
			if (taken || session.active.get(command.sessionId) === active) {
				if (steerError !== undefined) return this.reject(command, this.describe(steerError));
				return this.emitReceipt(session, command, {
					kind: "accepted",
					operationId: command.operationId,
					resolvedTarget: command.target,
					sessionId: command.sessionId,
					turnId: active.turnId,
					delivery: "steered",
				});
			}
			// Preserve prompts when steering ends.
		}
		if (!session.threads.has(command.sessionId)) {
			if (!session.client.resumeThread) return this.reject(command, `${this.name} agent ended with its process`);
			await session.client.resumeThread(command.sessionId, command.target.cwd);
			session.threads.set(command.sessionId, binding);
		}
		await this.beginTurn(session, command, command.target, binding, {
			model: command.model,
			serviceTier: command.serviceTier,
			outputSchema: command.outputSchema,
			key: command.operationId,
		});
	}

	/** Receipt precedes turn events. */
	private async beginTurn(
		session: TargetSession,
		command: Command<"start"> | Command<"message">,
		target: AgentResolvedTarget,
		binding: Binding,
		turn: TurnOptions,
	): Promise<void> {
		const handle: TurnHandle = await session.client.startTurn(binding.threadId, command.prompt, turn);
		const active: ActiveTurn = { binding, turnId: handle.turnId, settled: handle.settled };
		session.active.set(binding.threadId, active);
		this.emitReceipt(session, command, {
			kind: "accepted",
			operationId: command.operationId,
			resolvedTarget: target,
			sessionId: binding.threadId,
			turnId: handle.turnId,
			delivery: "started",
		});
		for (const publish of session.held.get(handle.turnId) ?? []) publish();
		session.held.delete(handle.turnId);
		void handle.settled.then((terminal) => {
			// Retirement already terminalizes turns.
			if (session.active.get(binding.threadId) !== active) return;
			session.active.delete(binding.threadId);
			this.emitTerminal(session, active, terminal);
		});
	}

	private async runInterrupt(command: Command<"interrupt">): Promise<void> {
		const session = await this.session(command.target);
		if (!session) return this.reject(command, this.unavailable(command.target));
		const active = session.active.get(command.sessionId);
		if (!active || active.turnId !== command.turnId)
			return this.reject(command, `${this.name} turn is no longer active`);
		const result = {
			kind: "interruptResult",
			operationId: command.operationId,
			sessionId: command.sessionId,
			turnId: command.turnId,
		};
		try {
			await session.client.interruptTurn(command.sessionId, command.turnId);
		} catch (error) {
			return this.emitReceipt(session, command, { ...result, ok: false, error: this.describe(error) });
		}
		this.emitReceipt(session, command, { ...result, ok: true });
	}

	private async runReconcile(command: Command<"reconcile">): Promise<void> {
		const session = await this.session(command.target);
		if (!session) return this.reject(command, this.unavailable(command.target));
		const reconciled = { kind: "reconciled", resolvedTarget: command.target, sessionId: command.sessionId };
		const active = session.active.get(command.sessionId);
		if (active)
			return this.emitReceipt(session, command, {
				...reconciled,
				turnId: active.turnId,
				turnState: "inProgress",
			});

		const binding: Binding = { ownerKey: command.ownerKey, agentId: command.agentId, threadId: command.sessionId };
		const unknown = () => this.emitReceipt(session, command, { ...reconciled, turnId: command.turnId });
		if (!session.threads.has(command.sessionId)) {
			try {
				await session.client.resumeThread?.(command.sessionId, command.target.cwd);
			} catch {
				return unknown();
			}
			if (session.client.resumeThread) session.threads.set(command.sessionId, binding);
		}
		if (!command.turnId || !session.client.inspectTurn) return unknown();
		const seen = await session.client
			.inspectTurn(command.sessionId, command.turnId)
			.catch(() => ({ known: "unknown" as const }));
		if (seen.known !== "settled") return unknown();
		// Fence receipt before terminal.
		this.emitReceipt(session, command, {
			...reconciled,
			turnId: command.turnId,
			turnState: seen.terminal.status,
		});
		this.emitTerminal(session, { binding, turnId: command.turnId }, seen.terminal);
	}

	private async session(target: AgentResolvedTarget): Promise<TargetSession | null> {
		if (this.deps.prepareTarget && !this.core.getSession(target.targetId)) {
			try {
				await this.deps.prepareTarget(target);
			} catch (error) {
				this.openErrors.set(target.targetId, this.describe(error));
				return null;
			}
		}
		const session = await this.core.acquireSession(target, (resolved, lease) => this.open(resolved, lease));
		if (!session?.closed) return session;
		this.giveUp(session);
		return null;
	}

	private giveUp(session: TargetSession): void {
		if (!this.core.live(session)) return;
		this.core.retire(session);
		this.deps.targets.release(session.targetId, session.generation);
	}

	private async open(target: AgentResolvedTarget, lease: TargetLease): Promise<TargetSession | null> {
		let client: AgentBackendSession;
		try {
			client = await this.deps.open(lease.child);
		} catch (error) {
			this.openErrors.set(target.targetId, this.describe(error));
			this.deps.targets.release(target.targetId, lease.generation);
			return null;
		}
		this.openErrors.delete(target.targetId);
		const session: TargetSession = {
			targetId: target.targetId,
			generation: lease.generation,
			client,
			nextEventId: 0,
			threads: new Map(),
			active: new Map(),
			held: new Map(),
			closed: false,
		};
		client.onActivity((turnId, text, itemId) => this.onActivity(session, turnId, text, itemId));
		client.onCounter?.((turnId, counter) => this.onCounter(session, turnId, counter));
		// A driver can close with its child still alive, or before this session is held.
		client.onClosed(() => {
			session.closed = true;
			this.giveUp(session);
		});
		return session;
	}

	private onActivity(session: TargetSession, turnId: string, text: string, itemId?: string): void {
		if (!text) return;
		this.whenAnnounced(session, turnId, (active) =>
			this.emitEvent(session, active, { kind: "activity", itemId: itemId ?? crypto.randomUUID(), text }),
		);
	}

	private onCounter(session: TargetSession, turnId: string, counter: TurnCounter): void {
		this.whenAnnounced(session, turnId, (active) =>
			this.emitEvent(session, active, {
				kind: "counter",
				counterKind: counter.kind,
				...(counter.itemId === undefined ? {} : { itemId: counter.itemId }),
				...(counter.filesChanged === undefined ? {} : { filesChanged: counter.filesChanged }),
			}),
		);
	}

	/** Hold until turn announcement. */
	private whenAnnounced(session: TargetSession, turnId: string, publish: (active: ActiveTurn) => void): void {
		const run = () => {
			const active = [...session.active.values()].find((candidate) => candidate.turnId === turnId);
			if (active) publish(active);
		};
		if ([...session.active.values()].some((candidate) => candidate.turnId === turnId)) {
			run();
			return;
		}
		const held = session.held.get(turnId) ?? [];
		if (held.length >= HELD_EVENTS_MAX) return;
		held.push(run);
		session.held.set(turnId, held);
		while (session.held.size > HELD_TURNS_MAX) session.held.delete(session.held.keys().next().value as string);
	}

	private emitTerminal(session: TargetSession, active: NamedTurn, terminal: TurnTerminal): void {
		const outcome =
			terminal.status === "completed"
				? {
						state: "completed",
						finalResponse: terminal.finalResponse ?? "",
						...(terminal.finalItemId === undefined ? {} : { finalItemId: terminal.finalItemId }),
					}
				: terminal.status === "failed"
					? { state: "failed", error: agentErrorText(terminal.error) || `${this.name} turn failed` }
					: { state: "interrupted", ...(terminal.reason === undefined ? {} : { reason: terminal.reason }) };
		this.emitEvent(session, active, { kind: "terminal", ...outcome });
	}

	private emitEvent(session: TargetSession, active: NamedTurn, event: Record<string, unknown>): void {
		this.core.publish(
			session,
			{
				type: agentFrameType(this.deps.backend.id, "event"),
				ownerKey: active.binding.ownerKey,
				agentId: active.binding.agentId,
				sessionId: active.binding.threadId,
				turnId: active.turnId,
				...event,
			},
			this.wire.event,
		);
	}

	/**
	 * Retired generations drop fenced receipts.
	 * Refuse unfenced to settle callers.
	 */
	private emitReceipt(session: TargetSession, command: AgentDaemonCommand, receipt: Record<string, unknown>): void {
		if (!this.core.live(session)) {
			this.reject(command, `${this.name} generation was retired mid-command`);
			return;
		}
		this.core.publish(
			session,
			{
				type: this.receiptType,
				requestId: command.requestId,
				ownerKey: command.ownerKey,
				agentId: command.agentId,
				...receipt,
			},
			this.wire.receipt,
		);
	}

	private reject(command: AgentDaemonCommand, error: string): void {
		const normalized = agentErrorText(error) || `${this.name} command failed`;
		const failureCode = this.deps.failureCode?.(normalized);
		const message = {
			type: this.receiptType,
			kind: "rejected",
			requestId: command.requestId,
			ownerKey: command.ownerKey,
			daemonInstanceId: this.deps.daemonInstanceId,
			agentId: command.agentId,
			...(command.kind === "reconcile" ? {} : { operationId: command.operationId }),
			eventId: this.core.rejectionId(),
			...(failureCode ? { failureCode } : {}),
			error: normalized,
		};
		console.error(`[${this.deps.backend.id}-daemon] refused ${command.kind} for ${command.agentId}: ${normalized}`);
		if (!this.wire.receipt.safeParse(message).success) return;
		this.core.sendOperationAnswer(command.kind === "reconcile" ? undefined : command.operationId, message);
	}

	private unavailable(target: AgentResolvedTarget): string {
		return this.openErrors.get(target.targetId) ?? `execution target is unavailable`;
	}

	private describe(error: unknown): string {
		const text = error instanceof Error ? error.message : String(error);
		return agentErrorText(text) || `${this.name} command failed`;
	}

	private get receiptType(): string {
		return agentFrameType(this.deps.backend.id, "receipt");
	}
}
