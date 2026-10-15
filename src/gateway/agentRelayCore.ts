import { type AgentBackendId, type AgentFrameKind, agentFrameType } from "../shared/agent-backend.js";
import { fromReplacedDaemon } from "../shared/agent-fence.js";
import type { Ambient } from "../shared/ambient.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";

////////////////////////////////
//  Interfaces & Types

/** `applied` and `ignored` retire a frame on the daemon; `reconcile` and `failed` hold it. */
export type AgentApplication<TAgent> =
	| { disposition: "applied"; owner: SessionRecord; agent: TAgent; catalogRevision: number }
	| { disposition: "ignored"; reason: string }
	| { disposition: "reconcile"; owner: SessionRecord; agent: TAgent }
	// A reducer bug. Acknowledging would delete the daemon's only copy.
	| { disposition: "failed"; reason: string };

export interface AgentRelayFrame {
	type: string;
	kind: string;
	ownerKey: string;
	agentId: string;
	daemonInstanceId: string;
	eventId: number;
}

export interface AgentRelayReceipt extends AgentRelayFrame {
	requestId: string;
	operationId?: string;
}

export interface AgentRelayAgent {
	agentId: string;
	agentState: string;
}

export interface AgentRelaySchema<T> {
	safeParse(
		value: unknown,
	): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ message: string }> } };
}

export interface AgentRelayDeps {
	sessionStore: SessionStore;
	/** Reconnect reconciliation retries unsent commands. */
	sendToHost(message: Record<string, unknown>): boolean;
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
}

export interface AgentRelayFamily<
	TEvent extends AgentRelayFrame,
	TReceipt extends AgentRelayReceipt,
	TRequest extends Record<string, unknown>,
	TAgent extends AgentRelayAgent,
> {
	backendId: AgentBackendId;
	helloSchema: AgentRelaySchema<{ daemonInstanceId: string }>;
	eventSchema: AgentRelaySchema<TEvent>;
	receiptSchema: AgentRelaySchema<TReceipt>;
	commandSchema: { safeParse(value: unknown): { success: boolean } };
	listAgents(owner: SessionRecord): readonly TAgent[];
	applyEvent(event: TEvent, at: number): AgentApplication<TAgent>;
	applyReceipt(receipt: TReceipt, at: number): AgentApplication<TAgent>;
	/** Undefined marks an unaskable agent. */
	reconcileRequest(ownerKey: string, agent: TAgent): TRequest | undefined;
}

interface StreamProgress {
	committedThrough: number;
	/** Retains later decisions while holds block acknowledgement. */
	highestDecided: number;
	/** Held event IDs per agent. */
	undecided: Map<number, string>;
}

type HeldFrame<TEvent, TReceipt> = { frame: "event"; message: TEvent } | { frame: "receipt"; message: TReceipt };

type FencedFrame = AgentRelayFrame & { targetId: string; generation: number };

////////////////////////////////
//  Constants

const MAX_DEFERRED_PER_AGENT = 128;

export const RECONCILE_GUARD_MS = 300_000;

////////////////////////////////
//  Functions & Helpers

function streamKey(message: { daemonInstanceId: string; targetId: string; generation: number }): string {
	return `${message.daemonInstanceId} ${message.targetId} ${message.generation}`;
}

function agentKey(ownerKey: string, agentId: string): string {
	return `${ownerKey} ${agentId}`;
}

// Refusals carry no stream.
function isFenced(message: AgentRelayFrame): message is FencedFrame {
	return "targetId" in message && "generation" in message;
}

////////////////////////////////
//  Class

/** Shared relay; each backend supplies its wire and applier. */
export class AgentRelayCore<
	TEvent extends AgentRelayFrame,
	TReceipt extends AgentRelayReceipt,
	TRequest extends Record<string, unknown>,
	TAgent extends AgentRelayAgent,
> {
	private readonly sections = new Map<string, Promise<unknown>>();
	private readonly streams = new Map<string, StreamProgress>();
	private readonly listeners = new Map<string, Set<() => void>>();
	// Match request IDs before clearing.
	private readonly reconciling = new Map<string, { requestId: string; askedAt: number }>();
	private readonly deferred = new Map<string, Array<HeldFrame<TEvent, TReceipt>>>();
	private liveInstanceId: string | undefined;

	constructor(
		private readonly deps: AgentRelayDeps,
		private readonly family: AgentRelayFamily<TEvent, TReceipt, TRequest, TAgent>,
	) {}

	dispatch(command: TRequest): boolean {
		return this.send(this.deps.ambient.newId(), command);
	}

	reconcileStale(owner: SessionRecord): void {
		const ownerKey = this.deps.sessionStore.teamOf(owner);
		for (const agent of this.family.listAgents(owner)) {
			if (this.needsReconciliation(ownerKey, agent)) this.requestReconciliation(ownerKey, agent);
		}
	}

	handleHostMessage(raw: Record<string, unknown>): void {
		if (raw.type === this.frameType("hello")) this.onHello(raw);
		else if (raw.type === this.frameType("receipt")) this.onReceipt(raw);
		else if (raw.type === this.frameType("event")) this.onEvent(raw);
	}

	onAgentChange(ownerKey: string, agentId: string, listener: () => void): () => void {
		const key = agentKey(ownerKey, agentId);
		const set = this.listeners.get(key) ?? new Set<() => void>();
		set.add(listener);
		this.listeners.set(key, set);
		return () => {
			set.delete(listener);
			if (set.size === 0) this.listeners.delete(key);
		};
	}

	waitFor(ownerKey: string, agentId: string, settled: () => boolean, deadline: number): Promise<boolean> {
		if (settled()) return Promise.resolve(true);
		return new Promise((resolve) => {
			const finish = (value: boolean) => {
				this.deps.ambient.clearTimer(timer);
				unsubscribe();
				resolve(value);
			};
			const timer = this.deps.ambient.setTimer(() => finish(false), Math.max(0, deadline - this.now()));
			const unsubscribe = this.onAgentChange(ownerKey, agentId, () => {
				if (settled()) finish(true);
			});
		});
	}

	private send(requestId: string, command: TRequest): boolean {
		const message = { type: this.frameType("command"), requestId, ...command };
		if (!this.family.commandSchema.safeParse(message).success) return false;
		return this.deps.sendToHost(message);
	}

	private onHello(raw: Record<string, unknown>): void {
		const hello = this.parse(this.family.helloSchema, raw, "hello");
		if (!hello) return;
		this.liveInstanceId = hello.daemonInstanceId;
		this.reconciling.clear();
		for (const owner of this.deps.sessionStore.list()) {
			const ownerKey = this.deps.sessionStore.teamOf(owner);
			for (const agent of this.family.listAgents(owner)) {
				// Held frames need reconciling, even idle.
				if (this.needsReconciliation(ownerKey, agent) || this.deferred.has(agentKey(ownerKey, agent.agentId))) {
					this.requestReconciliation(ownerKey, agent);
				}
			}
		}
	}

	private onReceipt(raw: Record<string, unknown>): void {
		const receipt = this.parse(this.family.receiptSchema, raw, "receipt");
		if (!receipt) return;
		void this.serialize(receipt.ownerKey, receipt.agentId, () => this.reduceReceipt(receipt));
	}

	private onEvent(raw: Record<string, unknown>): void {
		const event = this.parse(this.family.eventSchema, raw, "event");
		if (!event) return;
		void this.serialize(event.ownerKey, event.agentId, () => this.reduceEvent(event));
	}

	private parse<T>(schema: AgentRelaySchema<T>, raw: unknown, what: string): T | undefined {
		const parsed = schema.safeParse(raw);
		if (parsed.success) return parsed.data;
		const reason = parsed.error.issues[0]?.message ?? "invalid";
		console.warn(`[${this.family.backendId}] dropped a malformed ${what}: ${reason}`);
		return undefined;
	}

	private reduceReceipt(receipt: TReceipt): void {
		// Would install a dead fence.
		if (receipt.kind === "reconciled" && fromReplacedDaemon(this.liveInstanceId, receipt)) return;
		const application = this.family.applyReceipt(receipt, this.now());
		this.settle({ frame: "receipt", message: receipt }, application);
		// Operation refusals skip guard clearing.
		if (receipt.kind === "rejected" && receipt.operationId !== undefined) return;
		if (receipt.kind !== "reconciled" && receipt.kind !== "rejected") return;
		const key = agentKey(receipt.ownerKey, receipt.agentId);
		if (this.reconciling.get(key)?.requestId !== receipt.requestId) return;
		this.reconciling.delete(key);
		if (application.disposition === "applied") this.drainDeferred(receipt.ownerKey, receipt.agentId);
	}

	private reduceEvent(event: TEvent): void {
		this.settle({ frame: "event", message: event }, this.family.applyEvent(event, this.now()));
	}

	private settle(held: HeldFrame<TEvent, TReceipt>, application: AgentApplication<TAgent>): void {
		const { message } = held;
		// Hold failures and askable reconciliations.
		const repairable =
			application.disposition === "failed" ||
			(application.disposition === "reconcile" && this.isAskable(message.ownerKey, application.agent));
		if (repairable) {
			this.defer(held);
			if (application.disposition === "reconcile") {
				this.requestReconciliation(message.ownerKey, application.agent);
			}
		}
		if (isFenced(message)) this.advance(message, repairable ? "hold" : "decided");
		if (application.disposition !== "applied") return;
		for (const listener of this.listeners.get(agentKey(message.ownerKey, message.agentId)) ?? []) listener();
	}

	private advance(message: FencedFrame, outcome: "hold" | "decided"): void {
		const key = streamKey(message);
		const progress = this.streams.get(key) ?? {
			committedThrough: -1,
			highestDecided: -1,
			undecided: new Map<number, string>(),
		};
		this.streams.set(key, progress);
		if (outcome === "hold") {
			progress.undecided.set(message.eventId, agentKey(message.ownerKey, message.agentId));
			return;
		}
		progress.undecided.delete(message.eventId);
		progress.highestDecided = Math.max(progress.highestDecided, message.eventId);
		this.acknowledge(message, progress);
	}

	private acknowledge(
		message: { daemonInstanceId: string; targetId: string; generation: number },
		progress: StreamProgress,
	): void {
		const lowestUndecided = progress.undecided.size === 0 ? Infinity : Math.min(...progress.undecided.keys());
		const through = Math.min(progress.highestDecided, lowestUndecided - 1);
		if (through <= progress.committedThrough) return;
		// Keep acknowledgement frames schema-exact.
		const sent = this.deps.sendToHost({
			type: this.frameType("ack"),
			daemonInstanceId: message.daemonInstanceId,
			targetId: message.targetId,
			generation: message.generation,
			throughEventId: through,
		});
		// Commit after send.
		if (sent) progress.committedThrough = through;
	}

	private defer(held: HeldFrame<TEvent, TReceipt>): void {
		const key = agentKey(held.message.ownerKey, held.message.agentId);
		const queue = this.deferred.get(key) ?? [];
		// Deduplicate reconnect replays.
		const replayed = queue.some(
			(existing) => existing.frame === held.frame && existing.message.eventId === held.message.eventId,
		);
		if (replayed) return;
		queue.push(held);
		this.deferred.set(key, queue);
		while (queue.length > MAX_DEFERRED_PER_AGENT) {
			// Drop activity first.
			const index = queue.findIndex((candidate) => candidate.message.kind === "activity");
			queue.splice(index >= 0 ? index : 0, 1);
		}
	}

	private drainDeferred(ownerKey: string, agentId: string): void {
		const key = agentKey(ownerKey, agentId);
		const queue = this.deferred.get(key);
		this.deferred.delete(key);
		// Reconciliation settles held frames.
		for (const [streamId, progress] of this.streams) {
			for (const [eventId, owner] of progress.undecided) {
				if (owner === key) progress.undecided.delete(eventId);
			}
			this.releaseStream(streamId, progress);
		}
		if (!queue?.length) return;
		// Replay in event order.
		for (const held of [...queue].sort((left, right) => left.message.eventId - right.message.eventId)) {
			if (held.frame === "event") this.reduceEvent(held.message);
			else this.reduceReceipt(held.message);
		}
	}

	private releaseStream(streamId: string, progress: StreamProgress): void {
		const [daemonInstanceId, targetId, generation] = streamId.split(" ");
		if (!daemonInstanceId || !targetId || generation === undefined) return;
		this.acknowledge({ daemonInstanceId, targetId, generation: Number(generation) }, progress);
	}

	private isAskable(ownerKey: string, agent: TAgent): boolean {
		return this.family.reconcileRequest(ownerKey, agent) !== undefined;
	}

	private needsReconciliation(ownerKey: string, agent: TAgent): boolean {
		return this.isAskable(ownerKey, agent) && (agent.agentState === "working" || agent.agentState === "recovering");
	}

	private requestReconciliation(ownerKey: string, agent: TAgent): void {
		const request = this.family.reconcileRequest(ownerKey, agent);
		if (!request) return;
		const key = agentKey(ownerKey, agent.agentId);
		// Time-bound each agent guard.
		const asked = this.reconciling.get(key);
		if (asked !== undefined && this.now() - asked.askedAt < RECONCILE_GUARD_MS) return;
		const requestId = this.deps.ambient.newId();
		this.reconciling.set(key, { requestId, askedAt: this.now() });
		// Failed sends release guards.
		if (!this.send(requestId, request)) this.reconciling.delete(key);
	}

	/** Serialize reducers per agent. */
	private serialize(ownerKey: string, agentId: string, step: () => void): Promise<void> {
		const key = agentKey(ownerKey, agentId);
		const previous = this.sections.get(key) ?? Promise.resolve();
		const next = previous
			.then(step)
			.catch((error) => console.error(`[${this.family.backendId}-relay] reducer step failed:`, error))
			.finally(() => {
				if (this.sections.get(key) === next) this.sections.delete(key);
			});
		this.sections.set(key, next);
		return next;
	}

	private frameType(kind: AgentFrameKind): string {
		return agentFrameType(this.family.backendId, kind);
	}

	private now(): number {
		return this.deps.ambient.now();
	}
}
