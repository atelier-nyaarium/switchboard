import { type AgentBackendId, agentFrameType } from "../../shared/agent-backend.js";
import type { AgentResolvedTarget } from "../../shared/agent-execution-target.js";
import { AGENT_TURN_LOST_REASON } from "../../shared/agent-record.js";
import { createKeyedFifo } from "../../shared/keyed-fifo.js";
import { createOpDedupe } from "../../shared/op-dedupe.js";
import { createSingleFlight } from "../../shared/single-flight.js";
import type { TargetLease, TargetSupervisor } from "./agentTargets.js";

////////////////////////////////
//  Interfaces & Types

export interface AgentDaemonSession {
	targetId: string;
	generation: number;
	nextEventId: number;
	client: { close(): void };
}

export interface AgentDaemonSchema<T> {
	safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface AgentEventAck {
	type?: string;
	daemonInstanceId?: string;
	targetId: string;
	generation: number;
	throughEventId: number;
}

export interface AgentDaemonCoreOptions<TSession extends AgentDaemonSession> {
	backendId: AgentBackendId;
	daemonInstanceId: string;
	targets: TargetSupervisor;
	send(message: Record<string, unknown>): void;
	isReliable(message: unknown): boolean;
	// Validate hello before send; the remote schema is strict.
	helloSchema?: { parse(value: unknown): unknown };
	retiredTurnTerminalizers?: (session: TSession) => readonly ((reason: string) => void)[];
	onRetire?: (session: TSession) => void;
}

interface AgentCommand {
	ownerKey: string;
	agentId: string;
	operationId?: string;
}

type EventIdPlacement = "first" | "last";

////////////////////////////////
//  Constants

const OUTBOX_MAX_ENTRIES = 1_000;
// Deduplicate active and retained operation IDs.
const OPERATION_LEDGER_MAX_ENTRIES = 1_000;

////////////////////////////////
//  Class

/** What every agent daemon shares: which generation serves a target, and the stream back to the Gateway. */
export class AgentDaemonCore<TSession extends AgentDaemonSession> {
	private readonly sessions = new Map<string, TSession>();
	private readonly opening = createSingleFlight<string, TSession | null>();
	private readonly outbox: Array<{ targetId: string; generation: number; eventId: number; message: object }> = [];
	private readonly commands = createKeyedFifo<string>();
	private readonly activeOperations = new Set<string>();
	private readonly operationAnswers = new Map<string, Record<string, unknown>>();
	private readonly operations = createOpDedupe<Record<string, unknown>>({
		now: () => Date.now(),
		maxEntries: OPERATION_LEDGER_MAX_ENTRIES,
	});
	private rejections = 0;
	/** Unacknowledged per-stream evictions reported in hello. */
	private readonly evicted = new Map<string, { targetId: string; generation: number; count: number }>();

	constructor(private readonly options: AgentDaemonCoreOptions<TSession>) {
		options.targets.onRetire?.((targetId, generation) => {
			const session = this.sessions.get(targetId);
			if (session?.generation === generation) this.retire(session);
		});
	}

	hello(): Record<string, unknown> {
		const evicted = [...this.evicted.values()];
		const frame = {
			type: agentFrameType(this.options.backendId, "hello"),
			daemonInstanceId: this.options.daemonInstanceId,
			targets: [...this.sessions.values()].map((session) => ({
				targetId: session.targetId,
				generation: session.generation,
			})),
			// Omit empty for older Gateway schemas.
			...(evicted.length > 0 ? { evicted } : {}),
		};
		this.options.helloSchema?.parse(frame);
		return frame;
	}

	replay(): void {
		for (const entry of [...this.outbox].sort((left, right) => left.eventId - right.eventId)) {
			this.options.send(entry.message as Record<string, unknown>);
		}
	}

	acknowledge(ack: AgentEventAck): void {
		// Other daemon streams reuse event IDs.
		if (ack.daemonInstanceId !== undefined && ack.daemonInstanceId !== this.options.daemonInstanceId) return;
		for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
			const entry = this.outbox[index]!;
			if (
				entry.targetId === ack.targetId &&
				entry.generation === ack.generation &&
				entry.eventId <= ack.throughEventId
			) {
				this.outbox.splice(index, 1);
			}
		}
	}

	/** Serializes with agent commands. */
	inOrder<T>(agent: { ownerKey: string; agentId: string }, work: () => Promise<T>): Promise<T> {
		return this.commands.run(`${agent.ownerKey} ${agent.agentId}`, work);
	}

	enqueue<TCommand extends AgentCommand>(
		command: TCommand,
		dispatch: (command: TCommand) => Promise<void>,
		reject: (command: TCommand, error: string) => void,
		describe: (error: unknown) => string,
	): void {
		const run = async (): Promise<Record<string, unknown> | undefined> =>
			this.inOrder(command, async () => {
				const operationId = command.operationId;
				if (operationId) {
					this.activeOperations.add(operationId);
					this.operationAnswers.delete(operationId);
				}
				try {
					try {
						await dispatch(command);
					} catch (error) {
						try {
							reject(command, describe(error));
						} catch (failed) {
							console.error(`[${this.options.backendId}-daemon] rejecting a command failed:`, failed);
						}
					}
					return operationId ? this.operationAnswers.get(operationId) : undefined;
				} finally {
					if (operationId) {
						this.activeOperations.delete(operationId);
						this.operationAnswers.delete(operationId);
					}
				}
			});
		if (!command.operationId) {
			void run();
			return;
		}
		void this.operations.once(
			command.operationId,
			async () => (await run()) ?? {},
			(answer) => {
				if (Object.keys(answer).length > 0) this.options.send(answer);
			},
		);
	}

	async acquireSession(
		target: AgentResolvedTarget,
		buildSession: (target: AgentResolvedTarget, lease: TargetLease) => Promise<TSession | null>,
	): Promise<TSession | null> {
		const availability = this.options.targets.acquire(target);
		if (availability.state !== "running") return null;
		const generation = availability.lease.generation;
		const existing = this.sessions.get(target.targetId);
		if (existing && existing.generation === generation) return existing;

		const key = `${target.targetId} ${generation}`;
		return this.opening.run(key, () => this.open(target, availability.lease, buildSession));
	}

	getSession(targetId: string): TSession | undefined {
		return this.sessions.get(targetId);
	}

	/** Publishers must check this before sending. */
	live(session: TSession): boolean {
		return this.sessions.get(session.targetId) === session;
	}

	/** Retired generations publish nothing; retained events replay. */
	retire(session: TSession): void {
		if (!this.live(session)) return;
		try {
			for (const terminalize of this.options.retiredTurnTerminalizers?.(session) ?? []) {
				try {
					terminalize(AGENT_TURN_LOST_REASON);
				} catch (error) {
					console.error(`[${this.options.backendId}-daemon] ending a retired turn failed:`, error);
				}
			}
		} catch (error) {
			console.error(`[${this.options.backendId}-daemon] listing retired turns failed:`, error);
		} finally {
			try {
				this.options.onRetire?.(session);
			} catch (error) {
				console.error(`[${this.options.backendId}-daemon] retiring a session failed:`, error);
			} finally {
				this.sessions.delete(session.targetId);
				try {
					session.client.close();
				} catch (error) {
					console.error(`[${this.options.backendId}-daemon] closing a retired session failed:`, error);
				}
			}
		}
	}

	shutdown(): void {
		for (const session of [...this.sessions.values()]) this.retire(session);
	}

	rejectionId(): number {
		this.rejections += 1;
		return this.rejections;
	}

	publish<T>(
		session: TSession,
		partial: Record<string, unknown>,
		schema: AgentDaemonSchema<T>,
		eventIdPlacement: EventIdPlacement = "last",
	): Record<string, unknown> | undefined {
		// The Gateway silently drops retired generations.
		if (!this.live(session)) {
			console.error(
				`[${this.options.backendId}-daemon] dropped a ${partial.kind} from a retired generation on ${session.targetId}`,
			);
			return undefined;
		}
		const eventId = session.nextEventId;
		session.nextEventId += 1;
		const message =
			eventIdPlacement === "first"
				? {
						daemonInstanceId: this.options.daemonInstanceId,
						targetId: session.targetId,
						generation: session.generation,
						eventId,
						...partial,
					}
				: {
						daemonInstanceId: this.options.daemonInstanceId,
						targetId: session.targetId,
						generation: session.generation,
						...partial,
						eventId,
					};
		const parsed = schema.safeParse(message);
		if (!parsed.success) {
			// Log failures; unload could discard this terminal.
			console.error(
				`[${this.options.backendId}-daemon] dropped an unpublishable ${partial.kind} on ${session.targetId}`,
			);
			return undefined;
		}
		if (this.options.isReliable(parsed.data)) this.retain(session.targetId, session.generation, eventId, message);
		const operationId = (message as { operationId?: unknown }).operationId;
		if (typeof operationId === "string") this.sendOperationAnswer(operationId, message);
		else this.options.send(message);
		return message;
	}

	sendOperationAnswer(operationId: string | undefined, message: Record<string, unknown>): void {
		if (operationId && this.activeOperations.has(operationId)) this.operationAnswers.set(operationId, message);
		this.options.send(message);
	}

	private async open(
		target: AgentResolvedTarget,
		lease: TargetLease,
		buildSession: (target: AgentResolvedTarget, lease: TargetLease) => Promise<TSession | null>,
	): Promise<TSession | null> {
		const before = this.sessions.get(target.targetId);
		// Return a newer live session without closing it.
		if (before && before.generation > lease.generation) return before;
		if (before) this.retire(before);
		const session = await buildSession(target, lease);
		if (!session) return null;
		const current = this.sessions.get(target.targetId);
		if (current && current.generation > session.generation) {
			session.client.close();
			return current;
		}
		this.sessions.set(target.targetId, session);
		return session;
	}

	private retain(targetId: string, generation: number, eventId: number, message: object): void {
		this.outbox.push({ targetId, generation, eventId, message });
		const sameStream = (entry: { targetId: string; generation: number }) =>
			entry.targetId === targetId && entry.generation === generation;
		while (this.outbox.filter(sameStream).length > OUTBOX_MAX_ENTRIES) {
			const index = this.outbox.findIndex(sameStream);
			if (index < 0) break;
			const [dropped] = this.outbox.splice(index, 1);
			const key = `${targetId} ${generation}`;
			this.evicted.set(key, { targetId, generation, count: (this.evicted.get(key)?.count ?? 0) + 1 });
			console.error(
				`[${this.options.backendId}-daemon] outbox overflow, dropped event ${dropped?.eventId} on ${targetId}`,
			);
		}
	}
}
