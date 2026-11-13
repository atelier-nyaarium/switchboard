import crypto from "node:crypto";
import { type AgentBackendDescriptor, agentFrameType } from "../../shared/agent-backend.js";
import type { AgentExecutionTarget, AgentResolvedTarget } from "../../shared/agent-execution-target.js";
import { agentErrorText } from "../../shared/agent-identity.js";
import type { AgentDaemonFailureCode } from "../../shared/agent-state.js";
import { type AgentDaemonCommand, agentWire, isReliableAgentMessage } from "../../shared/agent-wire.js";
import type { HostAgentModelsResult } from "../../shared/host-op.js";
import { createSingleFlight } from "../../shared/single-flight.js";
import type { AgentBackendSession, ListedThread, TurnTerminal } from "../agents/backendSession.js";
import { type RunningTurn, TurnRunner } from "../agents/turnRunner.js";
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
}

type NamedTurn = Pick<RunningTurn<Binding>, "owner" | "threadId" | "turnId">;

interface TargetSession {
	targetId: string;
	generation: number;
	client: AgentBackendSession;
	nextEventId: number;
	runner: TurnRunner<Binding>;
	/** Closure may precede acquisition. */
	closed: boolean;
	usedAt: number;
}

type Command<Kind extends AgentDaemonCommand["kind"]> = Extract<AgentDaemonCommand, { kind: Kind }>;

////////////////////////////////
//  Constants

const SWEEP_MS = 30_000;
const REAP_QUIET_MS = 600_000;
const THREAD_AGENTS_MAX = 4_096;

////////////////////////////////
//  Class

/** A backend's commands on the daemon wire, each run through its session's `TurnRunner`. */
export class AgentDaemonService {
	private readonly core: AgentDaemonCore<TargetSession>;
	private readonly wire: ReturnType<typeof agentWire>;
	private readonly openErrors = new Map<string, string>();
	private readonly name: string;
	private readonly sessions = new Set<TargetSession>();
	private readonly listings = createSingleFlight<string, HostAgentModelsResult>();
	/** Maps threads to command queues. */
	private readonly threadAgents = new Map<string, Binding>();
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
				session.runner
					.activeTurns()
					.map((active) => (reason) => this.emitTerminal(session, active, { status: "interrupted", reason })),
			onRetire: (session) => {
				session.runner.clear();
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
			this.releaseOpened(opens, held.session);
		}
	}

	/** Records which queue must precede a delete. */
	private bind(targetId: string, threadId: string, agent: Binding): void {
		const key = `${targetId} ${threadId}`;
		this.threadAgents.delete(key);
		this.threadAgents.set(key, { ownerKey: agent.ownerKey, agentId: agent.agentId });
		if (this.threadAgents.size <= THREAD_AGENTS_MAX) return;
		for (const oldest of this.threadAgents.keys()) {
			this.threadAgents.delete(oldest);
			break;
		}
	}

	/** Known threads delete in agent order. Throws on failure. */
	async deleteThread(requested: AgentExecutionTarget, threadId: string): Promise<"deleted" | "gone"> {
		if (this.stopped) throw new Error(`${this.name} daemon is shutting down`);
		const target = resolveAgentTarget(requested, this.deps.resolveHostCwd);
		const agent = this.threadAgents.get(`${target.targetId} ${threadId}`);
		if (!agent) return this.deleteNow(target, threadId);
		return this.core.inOrder(agent, () => this.deleteNow(target, threadId));
	}

	/** Every thread in this backend's store at a place. Throws rather than answer part of it. */
	async listThreads(requested: AgentExecutionTarget): Promise<ListedThread[]> {
		if (this.stopped) throw new Error(`${this.name} daemon is shutting down`);
		const target = resolveAgentTarget(requested, this.deps.resolveHostCwd);
		const opens = !this.core.getSession(target.targetId);
		const held: { session?: TargetSession } = {};
		try {
			return await this.lease(async () => {
				const session = await this.session(target);
				if (!session) throw new Error(this.unavailable(target));
				held.session = session;
				return session.client.listThreads();
			});
		} finally {
			this.quietSince = this.now();
			this.releaseOpened(opens, held.session);
		}
	}

	private async deleteNow(target: AgentResolvedTarget, threadId: string): Promise<"deleted" | "gone"> {
		const opens = !this.core.getSession(target.targetId);
		const held: { session?: TargetSession } = {};
		try {
			return await this.lease(async () => {
				const session = await this.session(target);
				if (!session) throw new Error(this.unavailable(target));
				held.session = session;
				const client = session.client;
				const running = session.runner.activeTurn(threadId);
				if (running) {
					// Retry after interruption.
					void client.interruptTurn(threadId, running.turnId).catch(() => undefined);
					throw new Error(`${this.name} thread is still running`);
				}
				const outcome = await client.deleteThread(threadId);
				session.runner.forget(threadId);
				this.threadAgents.delete(`${target.targetId} ${threadId}`);
				return outcome;
			});
		} finally {
			this.quietSince = this.now();
			this.releaseOpened(opens, held.session);
		}
	}

	/** Reaps idle children opened for one operation. */
	private releaseOpened(opens: boolean, session: TargetSession | undefined): void {
		const idle = session?.runner.empty() === true && this.inFlight === 0;
		if (opens && idle && session && !this.deps.threadsResumable) this.giveUp(session);
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
		const owner: Binding = { ownerKey: command.ownerKey, agentId: command.agentId };
		const threadId = await session.client.openThread({
			cwd: target.cwd,
			model: command.model ?? this.deps.backend.defaultModel,
			serviceTier: command.serviceTier,
			reasoningEffort: command.reasoningEffort,
		});
		this.bind(target.targetId, threadId, owner);
		await session.runner.begin(
			threadId,
			owner,
			command.prompt,
			{
				model: command.model,
				serviceTier: command.serviceTier,
				outputSchema: command.outputSchema,
				key: command.operationId,
			},
			(turnId) =>
				this.emitReceipt(session, command, {
					kind: "accepted",
					operationId: command.operationId,
					resolvedTarget: target,
					sessionId: threadId,
					turnId,
					delivery: "started",
				}),
		);
	}

	private async runMessage(command: Command<"message">): Promise<void> {
		const session = await this.session(command.target);
		if (!session) return this.reject(command, this.unavailable(command.target));
		this.bind(command.target.targetId, command.sessionId, command);
		const outcome = await session.runner.message(
			command.sessionId,
			{ ownerKey: command.ownerKey, agentId: command.agentId },
			command.prompt,
			{
				expectedTurnId: command.expectedTurnId,
				cwd: command.target.cwd,
				model: command.model,
				serviceTier: command.serviceTier,
				outputSchema: command.outputSchema,
				key: command.operationId,
			},
			(accepted) =>
				this.emitReceipt(session, command, {
					kind: "accepted",
					operationId: command.operationId,
					resolvedTarget: command.target,
					sessionId: command.sessionId,
					turnId: accepted.turnId,
					delivery: accepted.kind,
				}),
		);
		if (outcome.kind === "busy") return this.reject(command, `${this.name} agent is still working`);
		if (outcome.kind === "ended") return this.reject(command, `${this.name} agent ended with its process`);
	}

	private async runInterrupt(command: Command<"interrupt">): Promise<void> {
		const session = await this.session(command.target);
		if (!session) return this.reject(command, this.unavailable(command.target));
		const result = {
			kind: "interruptResult",
			operationId: command.operationId,
			sessionId: command.sessionId,
			turnId: command.turnId,
		};
		let interrupted: boolean;
		try {
			interrupted = await session.runner.interrupt(command.sessionId, command.turnId);
		} catch (error) {
			return this.emitReceipt(session, command, { ...result, ok: false, error: this.describe(error) });
		}
		if (!interrupted) return this.reject(command, `${this.name} turn is no longer active`);
		this.emitReceipt(session, command, { ...result, ok: true });
	}

	private async runReconcile(command: Command<"reconcile">): Promise<void> {
		const session = await this.session(command.target);
		if (!session) return this.reject(command, this.unavailable(command.target));
		const { runner } = session;
		const threadId = command.sessionId;
		const reconciled = { kind: "reconciled", resolvedTarget: command.target, sessionId: threadId };
		const owner: Binding = { ownerKey: command.ownerKey, agentId: command.agentId };
		this.bind(command.target.targetId, threadId, owner);
		const active = runner.activeTurn(threadId);
		if (active) {
			// Handover changes owner.
			active.owner = owner;
			runner.remember(threadId);
			const asked = command.turnId !== undefined && command.turnId !== active.turnId ? command.turnId : undefined;
			const earlier = asked ? await runner.inspect(threadId, asked) : undefined;
			if (asked && earlier?.known === "settled") {
				this.emitReceipt(session, command, {
					...reconciled,
					turnId: asked,
					turnState: earlier.terminal.status,
				});
				return this.emitTerminal(session, { owner, threadId, turnId: asked }, earlier.terminal);
			}
			// Turn may settle mid-read.
			if (runner.activeTurn(threadId) === active) {
				return this.emitReceipt(session, command, {
					...reconciled,
					turnId: active.turnId,
					turnState: "inProgress",
				});
			}
		}

		const unknown = () => this.emitReceipt(session, command, { ...reconciled, turnId: command.turnId });
		const held = runner.holds(threadId);
		if (!held) {
			try {
				await session.client.resumeThread?.(threadId, command.target.cwd);
			} catch {
				return unknown();
			}
			if (session.client.resumeThread) runner.remember(threadId);
		}
		if (!command.turnId) return unknown();
		const seen = await runner.inspect(threadId, command.turnId);
		if (seen.known === "running") {
			const running = held ? await session.client.adoptTurn?.(threadId).catch(() => undefined) : undefined;
			if (running?.turnId !== command.turnId || runner.activeTurn(threadId)) return unknown();
			return runner.adopt(threadId, owner, running, () =>
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
		this.emitTerminal(session, { owner, threadId, turnId: command.turnId }, seen.terminal);
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
		const used = () => {
			session.usedAt = this.now();
		};
		const session: TargetSession = {
			targetId: target.targetId,
			generation: lease.generation,
			client,
			nextEventId: 0,
			runner: new TurnRunner<Binding>(client, {
				now: () => this.now(),
				terminal: (turn, terminal) => {
					used();
					this.emitTerminal(session, turn, terminal);
				},
				activity: (turn, text, itemId) => {
					used();
					this.emitEvent(session, turn, { kind: "activity", itemId: itemId ?? crypto.randomUUID(), text });
				},
				counter: (turn, counter) => {
					used();
					this.emitEvent(session, turn, {
						kind: "counter",
						counterKind: counter.kind,
						...(counter.itemId === undefined ? {} : { itemId: counter.itemId }),
						...(counter.filesChanged === undefined ? {} : { filesChanged: counter.filesChanged }),
					});
				},
				giveUp: (turn) => {
					console.error(
						`[${this.deps.backend.id}-daemon] retiring ${session.targetId} generation ${session.generation}: ${turn.threadId} made no progress on ${turn.turnId}`,
					);
					this.giveUp(session);
				},
				log: (line) => console.error(`[${this.deps.backend.id}-daemon] ${session.targetId} ${line}`),
			}),
			closed: false,
			usedAt: this.now(),
		};
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
				if (this.core.live(session))
					await this.lease(() => session.runner.watch(() => this.core.live(session)));
			}
			this.reapIdle();
		} finally {
			this.sweeping = false;
		}
	}

	private reapIdle(): void {
		if (!this.deps.threadsResumable || this.inFlight > 0) return;
		const now = this.now();
		if (now - this.quietSince < REAP_QUIET_MS) return;
		for (const session of [...this.sessions]) {
			if (!this.core.live(session) || session.runner.activeTurns().length > 0) continue;
			if (now - session.usedAt < REAP_QUIET_MS || session.client.busy?.()) continue;
			console.error(
				`[${this.deps.backend.id}-daemon] reaping ${session.targetId} generation ${session.generation}: idle for ${Math.round((now - session.usedAt) / 1_000)}s`,
			);
			this.giveUp(session);
		}
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
				ownerKey: active.owner.ownerKey,
				agentId: active.owner.agentId,
				sessionId: active.threadId,
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
