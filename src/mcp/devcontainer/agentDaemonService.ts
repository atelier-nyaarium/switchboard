import crypto from "node:crypto";
import { type AgentBackendDescriptor, agentFrameType } from "../../shared/agent-backend.js";
import type { AgentExecutionTarget, AgentResolvedTarget } from "../../shared/agent-execution-target.js";
import { agentErrorText } from "../../shared/agent-identity.js";
import type { AgentDaemonFailureCode } from "../../shared/agent-state.js";
import { type AgentDaemonCommand, agentWire, isReliableAgentMessage } from "../../shared/agent-wire.js";
import type { HostAgentModelsResult } from "../../shared/host-op.js";
import { createSingleFlight } from "../../shared/single-flight.js";
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
import type { AgentChild, TargetLease, TargetSupervisor } from "./agentTargets.js";

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
	/** Target setup before launch. */
	prepareTarget?(target: AgentResolvedTarget): Promise<void>;
	/** Reaped threads may reopen. */
	threadsResumable?: boolean;
	now?(): number;
	setSweep?(run: () => void, ms: number): ReturnType<typeof setInterval>;
	clearSweep?(handle: ReturnType<typeof setInterval>): void;
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
	/** Last progress time. */
	at: number;
	/** Interrupted once for silence. */
	warned: boolean;
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
	/** Closure may precede acquisition. */
	closed: boolean;
	usedAt: number;
}

type Command<Kind extends AgentDaemonCommand["kind"]> = Extract<AgentDaemonCommand, { kind: Kind }>;

////////////////////////////////
//  Constants

const HELD_TURNS_MAX = 32;
const HELD_EVENTS_MAX = 64;
const THREAD_MEMORY = 256;
/** Bounds silent reasoning hangs. */
const NO_PROGRESS_MS = 600_000;
const SWEEP_MS = 30_000;
const REAP_QUIET_MS = 600_000;
const UNKNOWN = { known: "unknown" } as const;

////////////////////////////////
//  Class

export class AgentDaemonService {
	private readonly core: AgentDaemonCore<TargetSession>;
	private readonly wire: ReturnType<typeof agentWire>;
	private readonly openErrors = new Map<string, string>();
	private readonly name: string;
	private readonly sessions = new Set<TargetSession>();
	private readonly listings = createSingleFlight<string, HostAgentModelsResult>();
	private stopped = false;
	private inFlight = 0;
	private quietSince = 0;
	private sweeper?: ReturnType<typeof setInterval>;
	private sweeping = false;

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
				this.sessions.delete(session);
			},
		});
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	/** Blocks idle reaping. */
	private async lease<T>(run: () => Promise<T>): Promise<T> {
		this.inFlight += 1;
		try {
			return await run();
		} finally {
			this.inFlight -= 1;
		}
	}

	private async serve(command: AgentDaemonCommand): Promise<void> {
		try {
			await this.lease(() => this.dispatch(command));
		} finally {
			this.quietSince = this.now();
		}
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
			(next) => this.serve(next),
			(next, error) => this.reject(next, error),
			(error) => this.describe(error),
		);
	}

	/** Serialize target model reads. */
	async listModels(requested: AgentExecutionTarget): Promise<HostAgentModelsResult> {
		if (this.stopped) return { kind: "refused", reason: `${this.name} daemon is shutting down` };
		let target: AgentResolvedTarget;
		try {
			target = resolveAgentTarget(requested, this.deps.resolveHostCwd);
		} catch (error) {
			return { kind: "refused", reason: this.describe(error) };
		}
		return this.listings.run(target.targetId, () => this.listOnce(target));
	}

	private async listOnce(target: AgentResolvedTarget): Promise<HostAgentModelsResult> {
		const opens = !this.core.getSession(target.targetId);
		const held: { session?: TargetSession } = {};
		try {
			return await this.lease(async () => {
				const session = await this.session(target);
				if (!session) return { kind: "refused", reason: this.unavailable(target) };
				held.session = session;
				if (!session.client.listModels) return { kind: "refused", reason: `${this.name} lists no models` };
				const models = await session.client.listModels();
				return { kind: "listed", models: models.map((model) => model.id) };
			});
		} catch (error) {
			return { kind: "refused", reason: this.describe(error) };
		} finally {
			this.quietSince = this.now();
			// Nothing else reaps it.
			const idle = held.session?.threads.size === 0 && held.session.active.size === 0 && this.inFlight === 0;
			if (opens && idle && held.session && !this.deps.threadsResumable) this.giveUp(held.session);
		}
	}

	shutdown(): void {
		this.stopped = true;
		if (this.sweeper !== undefined) (this.deps.clearSweep ?? clearInterval)(this.sweeper);
		this.sweeper = undefined;
		this.sessions.clear();
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
		this.remember(session, binding);
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
			if (steerError !== undefined && session.active.get(command.sessionId) === active) {
				// Driver may retain terminal.
				const seen =
					(await session.client.inspectTurn?.(command.sessionId, active.turnId).catch(() => UNKNOWN)) ??
					UNKNOWN;
				if (seen.known === "settled" && session.active.get(command.sessionId) === active) {
					session.active.delete(command.sessionId);
					this.emitTerminal(session, active, seen.terminal);
				}
			}
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
			// Preserve prompts after steering.
		}
		if (!session.threads.has(command.sessionId)) {
			if (!session.client.resumeThread) return this.reject(command, `${this.name} agent ended with its process`);
			await session.client.resumeThread(command.sessionId, command.target.cwd);
		}
		this.remember(session, binding);
		await this.beginTurn(session, command, command.target, binding, {
			model: command.model,
			serviceTier: command.serviceTier,
			outputSchema: command.outputSchema,
			key: command.operationId,
		});
	}

	private async beginTurn(
		session: TargetSession,
		command: Command<"start"> | Command<"message">,
		target: AgentResolvedTarget,
		binding: Binding,
		turn: TurnOptions,
	): Promise<void> {
		let handle: TurnHandle;
		try {
			handle = await session.client.startTurn(binding.threadId, command.prompt, turn);
		} catch (error) {
			const running = await session.client.adoptTurn?.(binding.threadId).catch(() => undefined);
			if (!running) throw error;
			handle = running;
		}
		this.announce(session, binding, handle, () =>
			this.emitReceipt(session, command, {
				kind: "accepted",
				operationId: command.operationId,
				resolvedTarget: target,
				sessionId: binding.threadId,
				turnId: handle.turnId,
				delivery: "started",
			}),
		);
	}

	private announce(session: TargetSession, binding: Binding, handle: TurnHandle, receipt: () => void): void {
		const active: ActiveTurn = {
			binding,
			turnId: handle.turnId,
			settled: handle.settled,
			at: this.now(),
			warned: false,
		};
		session.active.set(binding.threadId, active);
		receipt();
		for (const publish of session.held.get(handle.turnId) ?? []) publish();
		session.held.delete(handle.turnId);
		void handle.settled.then((terminal) => {
			if (session.active.get(binding.threadId) !== active) return;
			session.active.delete(binding.threadId);
			this.emitTerminal(session, active, terminal);
		});
	}

	/** Bounds remembered threads. */
	private remember(session: TargetSession, binding: Binding): void {
		session.threads.delete(binding.threadId);
		session.threads.set(binding.threadId, binding);
		if (!session.client.resumeThread) return;
		for (const oldest of [...session.threads.keys()]) {
			if (session.threads.size <= THREAD_MEMORY) return;
			if (oldest !== binding.threadId && !session.active.has(oldest)) session.threads.delete(oldest);
		}
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
		const binding: Binding = { ownerKey: command.ownerKey, agentId: command.agentId, threadId: command.sessionId };
		const active = session.active.get(command.sessionId);
		if (active) {
			// Handover changes owner.
			active.binding = binding;
			this.remember(session, binding);
			const asked = command.turnId !== undefined && command.turnId !== active.turnId ? command.turnId : undefined;
			const earlier = asked
				? await session.client.inspectTurn?.(command.sessionId, asked).catch(() => UNKNOWN)
				: undefined;
			if (asked && earlier?.known === "settled") {
				this.emitReceipt(session, command, {
					...reconciled,
					turnId: asked,
					turnState: earlier.terminal.status,
				});
				return this.emitTerminal(session, { binding, turnId: asked }, earlier.terminal);
			}
			// Turn may settle mid-read.
			if (session.active.get(command.sessionId) === active) {
				return this.emitReceipt(session, command, {
					...reconciled,
					turnId: active.turnId,
					turnState: "inProgress",
				});
			}
		}

		const unknown = () => this.emitReceipt(session, command, { ...reconciled, turnId: command.turnId });
		const held = session.threads.has(command.sessionId);
		if (!held) {
			try {
				await session.client.resumeThread?.(command.sessionId, command.target.cwd);
			} catch {
				return unknown();
			}
			if (session.client.resumeThread) this.remember(session, binding);
		}
		if (!command.turnId || !session.client.inspectTurn) return unknown();
		const seen = await session.client.inspectTurn(command.sessionId, command.turnId).catch(() => UNKNOWN);
		if (seen.known === "running") {
			const running = held
				? await session.client.adoptTurn?.(command.sessionId).catch(() => undefined)
				: undefined;
			if (running?.turnId !== command.turnId || session.active.has(command.sessionId)) return unknown();
			return this.announce(session, binding, running, () =>
				this.emitReceipt(session, command, { ...reconciled, turnId: running.turnId, turnState: "inProgress" }),
			);
		}
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
		if (session && !session.closed) {
			session.usedAt = this.now();
			return session;
		}
		if (session) this.giveUp(session);
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
		if (this.stopped) {
			client.close();
			this.deps.targets.release(target.targetId, lease.generation);
			return null;
		}
		const session: TargetSession = {
			targetId: target.targetId,
			generation: lease.generation,
			client,
			nextEventId: 0,
			threads: new Map(),
			active: new Map(),
			held: new Map(),
			closed: false,
			usedAt: this.now(),
		};
		client.onActivity((turnId, text, itemId) => this.onActivity(session, turnId, text, itemId));
		client.onCounter?.((turnId, counter) => this.onCounter(session, turnId, counter));
		client.onProgress?.((turnId) => this.alive(session, turnId));
		// Closure may precede acquisition or child exit.
		client.onClosed(() => {
			session.closed = true;
			this.giveUp(session);
		});
		this.sessions.add(session);
		this.startSweeping();
		return session;
	}

	private startSweeping(): void {
		if (this.sweeper !== undefined || this.stopped) return;
		this.sweeper = (this.deps.setSweep ?? ((run, ms) => setInterval(run, ms)))(() => void this.sweep(), SWEEP_MS);
		(this.sweeper as { unref?: () => void }).unref?.();
	}

	private async sweep(): Promise<void> {
		if (this.sweeping) return;
		this.sweeping = true;
		try {
			for (const session of [...this.sessions]) {
				if (this.core.live(session)) await this.lease(() => this.watchTurns(session));
			}
			this.reapIdle();
		} finally {
			this.sweeping = false;
		}
	}

	private async watchTurns(session: TargetSession): Promise<void> {
		if (!session.client.onProgress) return;
		const cutoff = this.now() - NO_PROGRESS_MS;
		for (const active of [...session.active.values()]) {
			if (active.at > cutoff) continue;
			const { threadId } = active.binding;
			const seen = (await session.client.inspectTurn?.(threadId, active.turnId).catch(() => UNKNOWN)) ?? UNKNOWN;
			if (!this.core.live(session)) return;
			if (session.active.get(threadId) !== active) continue;
			if (seen.known === "settled") {
				session.active.delete(threadId);
				this.emitTerminal(session, active, seen.terminal);
				continue;
			}
			if (!active.warned) {
				active.warned = true;
				active.at = this.now();
				console.error(
					`[${this.deps.backend.id}-daemon] ${session.targetId} interrupting turn ${active.turnId}: silent for ${NO_PROGRESS_MS / 1000}s`,
				);
				void session.client.interruptTurn(threadId, active.turnId).catch(() => undefined);
				continue;
			}
			console.error(
				`[${this.deps.backend.id}-daemon] retiring ${session.targetId} generation ${session.generation}: ${threadId} made no progress on ${active.turnId}`,
			);
			this.giveUp(session);
			return;
		}
	}

	private reapIdle(): void {
		if (!this.deps.threadsResumable || this.inFlight > 0) return;
		const now = this.now();
		if (now - this.quietSince < REAP_QUIET_MS) return;
		for (const session of [...this.sessions]) {
			if (!this.core.live(session) || session.active.size > 0) continue;
			if (now - session.usedAt < REAP_QUIET_MS || session.client.busy?.()) continue;
			console.error(
				`[${this.deps.backend.id}-daemon] reaping ${session.targetId} generation ${session.generation}: idle for ${Math.round((now - session.usedAt) / 1_000)}s`,
			);
			this.giveUp(session);
		}
	}

	private alive(session: TargetSession, turnId: string): void {
		session.usedAt = this.now();
		const active = [...session.active.values()].find((candidate) => candidate.turnId === turnId);
		if (!active) return;
		active.at = session.usedAt;
		active.warned = false;
	}

	private onActivity(session: TargetSession, turnId: string, text: string, itemId?: string): void {
		this.alive(session, turnId);
		if (!text) return;
		this.whenAnnounced(session, turnId, (active) =>
			this.emitEvent(session, active, { kind: "activity", itemId: itemId ?? crypto.randomUUID(), text }),
		);
	}

	private onCounter(session: TargetSession, turnId: string, counter: TurnCounter): void {
		this.alive(session, turnId);
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
