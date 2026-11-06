import { type AgentBackendId, agentFrameType } from "../../shared/agent-backend.js";
import type { AgentResolvedTarget } from "../../shared/agent-execution-target.js";
import { createKeyedFifo } from "../../shared/keyed-fifo.js";
import { createOpDedupe } from "../../shared/op-dedupe.js";
import { createSingleFlight } from "../../shared/single-flight.js";
import type { TargetLease, TargetSupervisor } from "./codexTargets.js";

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
	// Validates hello() before it is sent, matching every sibling frame on this wire. The receiver's
	// schema is .strict(), so an unvalidated drift here is rejected at the far end with no local sign.
	helloSchema?: { parse(value: unknown): unknown };
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
const OPERATION_LEDGER_MAX_ENTRIES = 1_000;

////////////////////////////////
//  Class

/**
 * What every agent daemon shares: which generation serves a target, and the stream back to the
 * gateway.
 *
 * It owns the registry and the fence over it, so a backend cannot publish under a generation the
 * gateway has retired. Protocol belongs to the service above it.
 */
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

	constructor(private readonly options: AgentDaemonCoreOptions<TSession>) {
		options.targets.onRetire?.((targetId, generation) => {
			const session = this.sessions.get(targetId);
			if (session?.generation === generation) this.retire(session);
		});
	}

	hello(): Record<string, unknown> {
		const frame = {
			type: agentFrameType(this.options.backendId, "hello"),
			daemonInstanceId: this.options.daemonInstanceId,
			targets: [...this.sessions.values()].map((session) => ({
				targetId: session.targetId,
				generation: session.generation,
			})),
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

	enqueue<TCommand extends AgentCommand>(
		command: TCommand,
		dispatch: (command: TCommand) => Promise<void>,
		reject: (command: TCommand, error: string) => void,
		describe: (error: unknown) => string,
	): void {
		const run = async (): Promise<Record<string, unknown> | undefined> =>
			this.commands.run(`${command.ownerKey} ${command.agentId}`, async () => {
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

	/**
	 * Whether this generation still serves its target, which is what every publisher must ask.
	 *
	 * Tracking retirement BESIDE the registry rather than in it was tried and silenced a healthy
	 * child, so `retire` drops the session and this one question answers both.
	 */
	live(session: TSession): boolean {
		return this.sessions.get(session.targetId) === session;
	}

	/** Give up a generation: it serves and publishes nothing new. Retained entries still replay. */
	retire(session: TSession): void {
		if (!this.live(session)) return;
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
		// The gateway fences a retired generation out, so publishing under one only looks delivered.
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
			// Silence here loses a terminal whose thread the lifecycle unloads regardless.
			console.error(
				`[${this.options.backendId}-daemon] dropped an unpublishable ${partial.kind} on ${session.targetId}`,
			);
			return undefined;
		}
		if (this.options.isReliable(parsed.data)) this.retain(session.targetId, session.generation, eventId, message);
		const operationId = (message as { operationId?: unknown }).operationId;
		if (typeof operationId === "string" && this.activeOperations.has(operationId))
			this.operationAnswers.set(operationId, message);
		this.options.send(message);
		return message;
	}

	rememberOperationAnswer(operationId: string | undefined, message: Record<string, unknown>): void {
		if (operationId && this.activeOperations.has(operationId)) this.operationAnswers.set(operationId, message);
	}

	private async open(
		target: AgentResolvedTarget,
		lease: TargetLease,
		buildSession: (target: AgentResolvedTarget, lease: TargetLease) => Promise<TSession | null>,
	): Promise<TSession | null> {
		const before = this.sessions.get(target.targetId);
		// An open for an older generation must not close the one already serving, nor replace it when
		// it finishes. The caller is handed that live session instead, since its target is healthy.
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
			console.error(
				`[${this.options.backendId}-daemon] outbox overflow, dropped event ${dropped?.eventId} on ${targetId}`,
			);
		}
	}
}
