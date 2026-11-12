import { type AgentBackendId, type AgentFrameKind, agentFrameType } from "../shared/agent-backend.js";
import {
	type AgentCounterKind,
	type AgentProgressCounts,
	addAgentProgressCounts,
	emptyAgentProgressCounts,
} from "../shared/agent-counter.js";
import { fromReplacedDaemon } from "../shared/agent-fence.js";
import type { AgentReconciliationReport } from "../shared/agent-recovery.js";
import type { Ambient } from "../shared/ambient.js";
import { createKeyedFifo } from "../shared/keyed-fifo.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";
import {
	AgentFrameLedger,
	type FrameAck,
	type FrameIdentity,
	type FrameTicket,
	type HoldReason,
} from "./agentFrameLedger.js";

////////////////////////////////
//  Interfaces & Types

/** Only applied or ignored frames retire. */
export type AgentApplication<TAgent> =
	| { disposition: "applied"; owner: SessionRecord; agent: TAgent; catalogRevision: number }
	/** Notify listeners; retain until durable. */
	| { disposition: "unconfirmed"; owner: SessionRecord; agent: TAgent; catalogRevision: number }
	| { disposition: "ignored"; reason: string }
	| { disposition: "reconcile"; owner: SessionRecord; agent: TAgent }
	// Never acknowledge failed frames.
	| { disposition: "failed"; reason: string };

export interface AgentRelayFrame {
	type: string;
	kind: string;
	ownerKey: string;
	agentId: string;
	daemonInstanceId: string;
	eventId: number;
}

export interface AgentRelayHello {
	daemonInstanceId: string;
	evicted?: ReadonlyArray<{ targetId: string; generation: number; count: number }>;
}

export interface AgentRelayReceipt extends AgentRelayFrame {
	requestId: string;
	operationId?: string;
}

export interface AgentRelayAgent {
	agentId: string;
	agentState: string;
	runId?: string;
}

export interface AgentRelaySchema<T> {
	safeParse(
		value: unknown,
	): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ message: string }> } };
}

export interface AgentRelayDeps {
	sessionStore: SessionStore;
	liveDaemonInstanceId(): string | undefined;
	/** Reconnect retries unsent commands. */
	sendToHost(message: Record<string, unknown>): boolean;
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
}

export interface AgentRelayPort<
	TEvent extends AgentRelayFrame,
	TReceipt extends AgentRelayReceipt,
	TRequest extends Record<string, unknown>,
	TAgent extends AgentRelayAgent,
> {
	backendId: AgentBackendId;
	helloSchema: AgentRelaySchema<AgentRelayHello>;
	eventSchema: AgentRelaySchema<TEvent>;
	receiptSchema: AgentRelaySchema<TReceipt>;
	commandSchema: { safeParse(value: unknown): { success: boolean } };
	listAgents(owner: SessionRecord): readonly TAgent[];
	fenceInstanceId(agent: TAgent): string | undefined;
	targetId(agent: TAgent): string | undefined;
	applyEvent(event: TEvent, at: number, held?: boolean): AgentApplication<TAgent>;
	/** Closing trusts daemon reconciliation. */
	applyReceipt(receipt: TReceipt, at: number, closing?: boolean): AgentApplication<TAgent>;
	openTurn(agent: TAgent): string | undefined;
	/** End the turn unless report confirms it. */
	closeHeld(
		ownerKey: string,
		agentId: string,
		report: AgentReconciliationReport | undefined,
		at: number,
	): AgentApplication<TAgent>;
	abandonOperation(ownerKey: string, agentId: string, operationId: string, at: number): AgentApplication<TAgent>;
	reconciliationReport(receipt: TReceipt): AgentReconciliationReport | undefined;
	/** May checkpoint while confirming. */
	confirmation(owner: SessionRecord, revision: number): "confirmed" | "pending" | "gone";
	abandonStaleOperations(
		owner: SessionRecord,
		agent: TAgent,
		daemonInstanceId: string,
		at: number,
	): AgentApplication<TAgent>;
	requestedOperations(ownerKey: string, agent: TAgent, daemonInstanceId: string): readonly TRequest[];
	/** Undefined means unaskable. */
	reconcileRequest(ownerKey: string, agent: TAgent): TRequest | undefined;
	counterEvent(event: TEvent): { turnId: string; kind: AgentCounterKind; filesChanged?: number } | undefined;
	modelTurn(receipt: TReceipt): string | undefined;
}

/** Unconfirmed record write. */
type HeldFrame<TEvent, TReceipt> = ({ frame: "event"; message: TEvent } | { frame: "receipt"; message: TReceipt }) & {
	awaiting?: { owner: SessionRecord; revision: number };
};

type FencedFrame = AgentRelayFrame & { targetId: string; generation: number };
type Awaiting = { owner: SessionRecord; revision: number };
/** Held frames outlast the pending write. */
type Closing = { pending?: Awaiting };
type ProgressEntry = { runId?: string; counts: AgentProgressCounts };

////////////////////////////////
//  Constants

const MAX_HELD_PER_AGENT = 128;
const MAX_PROGRESS_TURNS = 4096;

export const RECONCILE_GUARD_MS = 300_000;
/** How long a frame nothing can place is held. */
export const HELD_FRAME_LIMIT_MS = 600_000;
/** Awaiting writes are already recorded. */
const UNPLACED: readonly HoldReason[] = ["reconcile", "failed"];

////////////////////////////////
//  Functions & Helpers

function agentKey(ownerKey: string, agentId: string): string {
	return `${ownerKey} ${agentId}`;
}

export function inRecord<TAgent>(
	application: AgentApplication<TAgent>,
): application is Extract<AgentApplication<TAgent>, { disposition: "applied" | "unconfirmed" }> {
	return application.disposition === "applied" || application.disposition === "unconfirmed";
}

// Refusals are unfenced.
function isFenced(message: AgentRelayFrame): message is FencedFrame {
	return "targetId" in message && "generation" in message;
}

////////////////////////////////
//  Class

export class AgentRelayCore<
	TEvent extends AgentRelayFrame,
	TReceipt extends AgentRelayReceipt,
	TRequest extends Record<string, unknown>,
	TAgent extends AgentRelayAgent,
> {
	private readonly reducers = createKeyedFifo<string>();
	private readonly frames = new AgentFrameLedger<HeldFrame<TEvent, TReceipt>>(MAX_HELD_PER_AGENT);
	private readonly listeners = new Map<string, Set<() => void>>();
	private readonly lastReconcileAskedAt = new Map<string, { daemonInstanceId: string; askedAt: number }>();
	private readonly watches = new Map<string, ReturnType<Ambient["setTimer"]>>();
	/** Last daemon report for a held agent. */
	private readonly said = new Map<string, { receipt: TReceipt; at: number }>();
	/** Last open turn and change time. */
	private readonly opened = new Map<string, { turnId: string | undefined; at: number }>();
	private lastHelloAt = 0;
	private helloFrom: string | undefined;
	private stopped = false;
	private readonly evictionsSeen = new Map<string, number>();
	private readonly retrying = new Set<string>();
	private readonly retryAgain = new Set<string>();
	private readonly progress = new Map<string, ProgressEntry>();

	constructor(
		private readonly deps: AgentRelayDeps,
		private readonly port: AgentRelayPort<TEvent, TReceipt, TRequest, TAgent>,
	) {}

	progressCounts(ownerKey: string, agentId: string, turnId: string): AgentProgressCounts | undefined {
		const held = this.progress.get(`${agentKey(ownerKey, agentId)} ${turnId}`)?.counts;
		return held ? { ...held } : undefined;
	}

	progressForRun(runId: string): AgentProgressCounts {
		let counts = emptyAgentProgressCounts();
		for (const held of this.progress.values())
			if (held.runId === runId) counts = addAgentProgressCounts(counts, held.counts);
		return counts;
	}

	/** No ask and no close after it. */
	stop(): void {
		this.stopped = true;
		for (const timer of this.watches.values()) this.deps.ambient.clearTimer(timer);
		this.watches.clear();
	}

	dispatch(command: TRequest): boolean {
		return this.send(this.deps.ambient.newId(), command);
	}

	reconcileStale(owner: SessionRecord): void {
		const ownerKey = this.deps.sessionStore.teamOf(owner);
		for (const agent of this.port.listAgents(owner)) {
			if (this.needsReconciliation(ownerKey, agent)) this.requestReconciliation(ownerKey, agent);
		}
		this.retryAwaiting();
	}

	async onHostRegister(): Promise<void> {
		const daemonInstanceId = this.deps.liveDaemonInstanceId();
		if (!daemonInstanceId) return;
		const pending: Promise<void>[] = [];
		for (const owner of this.deps.sessionStore.list()) {
			const ownerKey = this.deps.sessionStore.teamOf(owner);
			for (const agent of this.port.listAgents(owner)) {
				pending.push(
					this.serialize(ownerKey, agent.agentId, () => {
						const application = this.port.abandonStaleOperations(
							owner,
							agent,
							daemonInstanceId,
							this.now(),
						);
						this.notifyChanged(ownerKey, agent.agentId, application);
					}),
				);
			}
		}
		await Promise.all(pending);
	}

	async resendRequested(daemonInstanceId: string | undefined): Promise<void> {
		if (!daemonInstanceId || daemonInstanceId !== this.deps.liveDaemonInstanceId()) return;
		const pending: Promise<void>[] = [];
		for (const owner of this.deps.sessionStore.list()) {
			const ownerKey = this.deps.sessionStore.teamOf(owner);
			for (const agent of this.port.listAgents(owner)) {
				pending.push(
					this.serialize(ownerKey, agent.agentId, () => {
						if (daemonInstanceId !== this.deps.liveDaemonInstanceId()) return;
						const current = this.port
							.listAgents(owner)
							.find((candidate) => candidate.agentId === agent.agentId);
						if (!current) return;
						for (const command of this.port.requestedOperations(ownerKey, current, daemonInstanceId)) {
							this.send(this.deps.ambient.newId(), command);
						}
					}),
				);
			}
		}
		await Promise.all(pending);
	}

	handleHostMessage(raw: Record<string, unknown>): Promise<void> {
		if (raw.type === this.frameType("hello")) return this.onHello(raw);
		if (raw.type === this.frameType("receipt")) return this.onReceipt(raw);
		if (raw.type === this.frameType("event")) return this.onEvent(raw);
		return Promise.resolve();
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
		if (!this.port.commandSchema.safeParse(message).success) return false;
		return this.deps.sendToHost(message);
	}

	private async onHello(raw: Record<string, unknown>): Promise<void> {
		const hello = this.parse(this.port.helloSchema, raw, "hello");
		if (!hello) return;
		const liveDaemonInstanceId = this.deps.liveDaemonInstanceId();
		if (liveDaemonInstanceId !== undefined && hello.daemonInstanceId !== liveDaemonInstanceId) return;
		// Reports from prior daemons do not apply.
		if (this.helloFrom !== hello.daemonInstanceId) this.said.clear();
		this.helloFrom = hello.daemonInstanceId;
		this.lastHelloAt = this.now();
		const evicted = (hello.evicted ?? []).filter(
			(stream) => stream.count > (this.evictionsSeen.get(this.evictionKey(hello.daemonInstanceId, stream)) ?? 0),
		);
		const lossy = new Set(evicted.map((stream) => stream.targetId));
		const unasked = new Set<string>();
		const pending: Promise<void>[] = [];
		for (const owner of this.deps.sessionStore.list()) {
			const ownerKey = this.deps.sessionStore.teamOf(owner);
			for (const agent of this.port.listAgents(owner)) {
				pending.push(
					this.serialize(ownerKey, agent.agentId, () => {
						const targetId = this.port.targetId(agent) ?? "";
						// A dropped terminal requires reconciliation.
						const lost = agent.agentState === "working" && lossy.has(targetId);
						if (
							lost ||
							this.needsReconciliation(ownerKey, agent) ||
							this.frames.holds(agentKey(ownerKey, agent.agentId))
						) {
							if (!this.requestReconciliation(ownerKey, agent, lost) && lost) unasked.add(targetId);
						}
					}),
				);
			}
		}
		await Promise.all(pending);
		// Retry evictions after unsent asks.
		for (const stream of evicted) {
			if (!unasked.has(stream.targetId))
				this.evictionsSeen.set(this.evictionKey(hello.daemonInstanceId, stream), stream.count);
		}
	}

	private evictionKey(daemonInstanceId: string, stream: { targetId: string; generation: number }): string {
		return `${daemonInstanceId} ${stream.targetId} ${stream.generation}`;
	}

	private onReceipt(raw: Record<string, unknown>): Promise<void> {
		const receipt = this.parse(this.port.receiptSchema, raw, "receipt");
		return receipt ? this.arrive({ frame: "receipt", message: receipt }) : Promise.resolve();
	}

	private onEvent(raw: Record<string, unknown>): Promise<void> {
		const event = this.parse(this.port.eventSchema, raw, "event");
		return event ? this.arrive({ frame: "event", message: event }) : Promise.resolve();
	}

	/** Register frames before reducer queuing. */
	private arrive(frame: HeldFrame<TEvent, TReceipt>): Promise<void> {
		const { ownerKey, agentId } = frame.message;
		const arrival = this.frames.receive(this.identityOf(frame), frame);
		if (arrival.kind === "queued") return Promise.resolve();
		if (arrival.kind === "decided") {
			this.sendAck(arrival.ack);
			return Promise.resolve();
		}
		// Held replays retry the stored copy.
		if (arrival.kind === "held") return this.serialize(ownerKey, agentId, () => this.retryHeld(ownerKey, agentId));
		return this.serialize(ownerKey, agentId, () => this.reduce(arrival.ticket));
	}

	private identityOf(frame: HeldFrame<TEvent, TReceipt>): FrameIdentity {
		const { message } = frame;
		return {
			frame: frame.frame,
			agent: agentKey(message.ownerKey, message.agentId),
			daemonInstanceId: message.daemonInstanceId,
			eventId: message.eventId,
			...(isFenced(message) ? { stream: { targetId: message.targetId, generation: message.generation } } : {}),
			droppable: message.kind === "activity",
		};
	}

	private parse<T>(schema: AgentRelaySchema<T>, raw: unknown, what: string): T | undefined {
		const parsed = schema.safeParse(raw);
		if (parsed.success) return parsed.data;
		const reason = parsed.error.issues[0]?.message ?? "invalid";
		console.warn(`[${this.port.backendId}] dropped a malformed ${what}: ${reason}`);
		return undefined;
	}

	/** Closing leaves no ticket open. */
	private reduce(ticket: FrameTicket<HeldFrame<TEvent, TReceipt>>, closing?: Closing): void {
		const retry = ticket.state === "held";
		const { ownerKey, agentId } = ticket.payload.message;
		let application: AgentApplication<TAgent>;
		try {
			application =
				ticket.payload.frame === "event"
					? this.reduceEvent(ticket, ticket.payload.message, retry)
					: this.reduceReceipt(ticket.payload.message);
			this.noteOpenTurn(agentKey(ownerKey, agentId), application);
		} catch (error) {
			console.error(`[${this.port.backendId}-relay] reducing a frame failed:`, error);
			application = { disposition: "failed", reason: "its reducer threw" };
		}
		try {
			this.settle(ticket, application, closing);
			this.askAfterLoss(ticket, application);
		} catch (error) {
			console.error(`[${this.port.backendId}-relay] settling a frame failed:`, error);
		}
		// An open ticket's replay would be dropped as queued.
		if (ticket.state === "open") {
			this.frames.hold(ticket, "failed", this.now());
			this.watch(ownerKey, agentId);
		}
	}

	/** A turn opened on a stream that dropped frames: its terminal may be among them. */
	private askAfterLoss(
		ticket: FrameTicket<HeldFrame<TEvent, TReceipt>>,
		application: AgentApplication<TAgent>,
	): void {
		const { stream, daemonInstanceId } = ticket.identity;
		if (ticket.payload.frame !== "receipt" || !stream || !inRecord(application)) return;
		if (!this.port.modelTurn(ticket.payload.message)) return;
		if ((this.evictionsSeen.get(this.evictionKey(daemonInstanceId, stream)) ?? 0) === 0) return;
		this.requestReconciliation(ticket.payload.message.ownerKey, application.agent, true);
	}

	private noteOpenTurn(key: string, application: AgentApplication<TAgent>): void {
		const known = this.opened.get(key);
		if (!known || !inRecord(application)) return;
		const turnId = this.port.openTurn(application.agent);
		if (turnId !== known.turnId) this.opened.set(key, { turnId, at: this.now() });
	}

	private reduceReceipt(receipt: TReceipt): AgentApplication<TAgent> {
		// Replaced daemons cannot update the fence.
		if (receipt.kind === "reconciled" && fromReplacedDaemon(this.deps.liveDaemonInstanceId(), receipt))
			return { disposition: "ignored", reason: "reconciliation from a replaced daemon" };
		const application = this.port.applyReceipt(receipt, this.now());
		// Ignore duplicate or stale reconciliation reports.
		if (application.disposition !== "ignored" && this.port.reconciliationReport(receipt))
			this.said.set(agentKey(receipt.ownerKey, receipt.agentId), { receipt, at: this.now() });
		if (inRecord(application)) {
			const turnId = this.port.modelTurn(receipt);
			if (turnId) this.countModelTurn(receipt.ownerKey, receipt.agentId, turnId, application.agent.runId);
		}
		return application;
	}

	private reduceEvent(
		ticket: FrameTicket<HeldFrame<TEvent, TReceipt>>,
		event: TEvent,
		held: boolean,
	): AgentApplication<TAgent> {
		const application = this.port.applyEvent(event, this.now(), held);
		const counter = this.port.counterEvent(event);
		const countable =
			inRecord(application) || (application.disposition === "ignored" && application.reason === "counter-only");
		// Count once per frame, despite retries.
		if (counter && countable && !ticket.counted) {
			this.countToolCall(
				event.ownerKey,
				event.agentId,
				counter.turnId,
				counter.kind,
				this.runIdForAgent(event.ownerKey, event.agentId),
				counter.filesChanged,
			);
			ticket.counted = true;
		}
		return application;
	}

	private countModelTurn(ownerKey: string, agentId: string, turnId: string, runId?: string): void {
		const key = `${agentKey(ownerKey, agentId)} ${turnId}`;
		const entry = this.progress.get(key);
		const current = entry?.counts ?? emptyAgentProgressCounts();
		this.setProgress(
			key,
			{
				...current,
				modelTurns: (current.modelTurns ?? 0) + 1,
			},
			runId ?? entry?.runId,
		);
	}

	private countToolCall(
		ownerKey: string,
		agentId: string,
		turnId: string,
		kind: AgentCounterKind,
		runId?: string,
		filesChanged = 0,
	): void {
		const key = `${agentKey(ownerKey, agentId)} ${turnId}`;
		const entry = this.progress.get(key);
		const current = entry?.counts ?? emptyAgentProgressCounts();
		const next = { ...current, toolCalls: current.toolCalls + 1 };
		if (filesChanged > 0) next.filesChanged = (next.filesChanged ?? 0) + filesChanged;
		if (kind === "shell") next.shell += 1;
		else if (kind === "edit") next.edits += 1;
		else if (kind === "read") next.reads += 1;
		else next.other += 1;
		this.setProgress(key, next, runId ?? entry?.runId);
	}

	private setProgress(key: string, counts: AgentProgressCounts, runId?: string): void {
		this.progress.delete(key);
		this.progress.set(key, { ...(runId ? { runId } : {}), counts });
		while (this.progress.size > MAX_PROGRESS_TURNS) {
			const oldest = this.progress.keys().next().value;
			if (oldest === undefined) break;
			this.progress.delete(oldest);
		}
	}

	private runIdForAgent(ownerKey: string, agentId: string): string | undefined {
		const owner = this.deps.sessionStore.getByTeam(ownerKey);
		return owner ? this.port.listAgents(owner).find((agent) => agent.agentId === agentId)?.runId : undefined;
	}

	private settle(
		ticket: FrameTicket<HeldFrame<TEvent, TReceipt>>,
		application: AgentApplication<TAgent>,
		closing?: Closing,
	): void {
		const frame = ticket.payload;
		const { message } = frame;
		const key = agentKey(message.ownerKey, message.agentId);
		// Retain frames until disk confirms.
		const awaiting =
			application.disposition === "unconfirmed" && ticket.identity.stream
				? { owner: application.owner, revision: application.catalogRevision }
				: undefined;
		const why: HoldReason | undefined = awaiting
			? "awaiting"
			: application.disposition === "failed"
				? "failed"
				: application.disposition === "reconcile" && this.isAskable(message.ownerKey, application.agent)
					? "reconcile"
					: undefined;
		const unplaced = why === "reconcile" || why === "failed";
		if (unplaced && closing) {
			this.drop(ticket, closing.pending);
		} else if (closing?.pending && !why && ticket.identity.stream && application.disposition !== "applied") {
			// Later frames wait for the pending write.
			ticket.payload = { ...frame, awaiting: closing.pending };
			this.frames.hold(ticket, "awaiting", this.now());
		} else if (why) {
			if (awaiting) ticket.payload = { ...frame, awaiting };
			for (const ack of this.frames.hold(ticket, why, this.now()).acks) this.sendAck(ack);
		} else {
			this.sendAck(this.frames.decide(ticket));
		}
		if (unplaced && !closing) {
			try {
				const agent =
					application.disposition === "reconcile"
						? application.agent
						: this.agentOf(message.ownerKey, message.agentId);
				// Snapshot the turn predating this hold.
				if (!this.opened.has(key))
					this.opened.set(key, { turnId: agent ? this.port.openTurn(agent) : undefined, at: 0 });
				if (agent) this.requestReconciliation(message.ownerKey, agent);
			} catch (error) {
				// Watch retries failed asks.
				console.error(`[${this.port.backendId}-relay] asking about a held frame failed:`, error);
			}
			this.watch(message.ownerKey, message.agentId);
		}
		this.notifyChanged(message.ownerKey, message.agentId, application);
		// A close tries each unplaced frame itself.
		if (inRecord(application) && !closing) this.retryHeld(message.ownerKey, message.agentId);
		// A landed write confirms earlier writes.
		if (application.disposition === "applied") this.retryAwaiting(key);
		this.forgetIfClear(key);
	}

	/** Commit acknowledgements only after sending. */
	private sendAck(ack: FrameAck | undefined): void {
		if (!ack) return;
		let sent = false;
		try {
			// Keep acknowledgement frames schema-exact.
			sent = this.deps.sendToHost({
				type: this.frameType("ack"),
				daemonInstanceId: ack.daemonInstanceId,
				targetId: ack.targetId,
				generation: ack.generation,
				throughEventId: ack.throughEventId,
			});
		} catch (error) {
			console.error(`[${this.port.backendId}-relay] sending an acknowledgement failed:`, error);
		}
		if (sent) this.frames.acknowledged(ack);
	}

	/** Retries stay unacknowledged until placed. */
	private retryHeld(ownerKey: string, agentId: string, unsynced = new Set<SessionRecord>()): void {
		const key = agentKey(ownerKey, agentId);
		if (this.retrying.has(key)) {
			this.retryAgain.add(key);
			return;
		}
		this.retrying.add(key);
		try {
			do {
				this.retryAgain.delete(key);
				for (const ticket of this.frames.heldFor(key)) {
					// Skip tickets decided earlier this pass.
					if (ticket.state !== "held") continue;
					if (!ticket.payload.awaiting) {
						this.reduce(ticket);
						continue;
					}
					try {
						this.confirmHeld(ticket, ticket.payload.awaiting, unsynced);
					} catch (error) {
						// Failed confirmation leaves frame held.
						console.error(`[${this.port.backendId}-relay] confirming a held frame failed:`, error);
					}
				}
			} while (this.retryAgain.has(key));
		} finally {
			this.retrying.delete(key);
			this.retryAgain.delete(key);
		}
	}

	/** Confirmed frames skip reduction. */
	private confirmHeld(
		ticket: FrameTicket<HeldFrame<TEvent, TReceipt>>,
		awaiting: { owner: SessionRecord; revision: number },
		unsynced: Set<SessionRecord>,
	): void {
		// Checkpoint each owner's whole snapshot once per pass.
		const confirmation = unsynced.has(awaiting.owner)
			? "pending"
			: this.port.confirmation(awaiting.owner, awaiting.revision);
		if (confirmation === "pending") {
			unsynced.add(awaiting.owner);
			return;
		}
		// A gone record cannot retain this frame.
		this.sendAck(this.frames.decide(ticket));
	}

	/** Any later write confirms an awaiting frame. */
	private retryAwaiting(except?: string): void {
		const unsynced = new Set<SessionRecord>();
		for (const key of this.frames.heldAgents()) {
			if (key === except) continue;
			const waiting = this.frames.heldFor(key).find((ticket) => ticket.payload.awaiting);
			if (!waiting) continue;
			const { ownerKey, agentId } = waiting.payload.message;
			void this.serialize(ownerKey, agentId, () => this.retryHeld(ownerKey, agentId, unsynced));
		}
	}

	private isAskable(ownerKey: string, agent: TAgent): boolean {
		return this.port.reconcileRequest(ownerKey, agent) !== undefined;
	}

	private needsReconciliation(ownerKey: string, agent: TAgent): boolean {
		const liveDaemonInstanceId = this.deps.liveDaemonInstanceId();
		if (!liveDaemonInstanceId || !this.isAskable(ownerKey, agent)) return false;
		if (agent.agentState === "recovering") return true;
		return agent.agentState === "working" && this.port.fenceInstanceId(agent) !== liveDaemonInstanceId;
	}

	/** One ask per agent per guard, unless `unguarded`. True once sent. */
	private requestReconciliation(ownerKey: string, agent: TAgent, unguarded = false): boolean {
		if (this.stopped) return false;
		const request = this.port.reconcileRequest(ownerKey, agent);
		if (!request) return false;
		const key = agentKey(ownerKey, agent.agentId);
		const now = this.now();
		const daemonInstanceId = this.deps.liveDaemonInstanceId();
		if (!daemonInstanceId) return false;
		const previousAsk = this.lastReconcileAskedAt.get(key);
		const guarded =
			previousAsk?.daemonInstanceId === daemonInstanceId && now - previousAsk.askedAt < RECONCILE_GUARD_MS;
		if (guarded && !unguarded) return false;
		if (!this.send(this.deps.ambient.newId(), request)) return false;
		this.lastReconcileAskedAt.set(key, { daemonInstanceId, askedAt: now });
		return true;
	}

	private closeAt(key: string): number | undefined {
		const since = this.frames.heldSince(key, UNPLACED);
		// A hello restarts the hold deadline.
		return since === undefined ? undefined : Math.max(since, this.lastHelloAt) + HELD_FRAME_LIMIT_MS;
	}

	private forgetIfClear(key: string): void {
		if (this.closeAt(key) !== undefined) return;
		this.said.delete(key);
		this.opened.delete(key);
	}

	private watch(ownerKey: string, agentId: string, delayMs?: number): void {
		const key = agentKey(ownerKey, agentId);
		if (this.stopped || this.watches.has(key)) return;
		const closeAt = this.closeAt(key);
		if (closeAt === undefined) return;
		const now = this.now();
		const asked = this.lastReconcileAskedAt.get(key)?.askedAt ?? now;
		const due = delayMs ?? Math.min(closeAt, asked + RECONCILE_GUARD_MS) - now;
		const timer = this.deps.ambient.setTimer(
			() => {
				this.watches.delete(key);
				void this.serialize(ownerKey, agentId, () => this.tend(ownerKey, agentId));
			},
			Math.max(0, due),
		);
		this.watches.set(key, timer);
	}

	private tend(ownerKey: string, agentId: string): void {
		// Queued work can outlive stop.
		if (this.stopped) return;
		const key = agentKey(ownerKey, agentId);
		const closeAt = this.closeAt(key);
		if (closeAt === undefined) {
			this.forgetIfClear(key);
			return;
		}
		const live = this.deps.liveDaemonInstanceId();
		// No daemon to ask, and none to give up on.
		if (!live) {
			this.watch(ownerKey, agentId, RECONCILE_GUARD_MS);
			return;
		}
		const now = this.now();
		// Only close after the live daemon's hello.
		const closed = now >= closeAt && live === this.helloFrom && this.close(ownerKey, agentId);
		if (!closed) {
			const agent = this.agentOf(ownerKey, agentId);
			if (agent) this.requestReconciliation(ownerKey, agent);
		}
		// Each attempt resets the guard deadline.
		this.watch(ownerKey, agentId, now < closeAt ? Math.min(RECONCILE_GUARD_MS, closeAt - now) : RECONCILE_GUARD_MS);
	}

	/** Ends a hold nothing placed. False when nothing was given up. */
	private close(ownerKey: string, agentId: string): boolean {
		const key = agentKey(ownerKey, agentId);
		const at = this.now();
		const since = this.frames.heldSince(key, UNPLACED) ?? at;
		const live = this.deps.liveDaemonInstanceId();
		const openedAt = this.opened.get(key)?.at ?? 0;
		const word = this.said.get(key);
		// Only reports at or after the turn opened count.
		const receipt =
			word && word.at >= openedAt && !fromReplacedDaemon(live, word.receipt) ? word.receipt : undefined;
		const asked = this.lastReconcileAskedAt.get(key);
		const askedAt = asked && asked.daemonInstanceId === live ? asked.askedAt : undefined;
		const agent = this.agentOf(ownerKey, agentId);
		// Do not close askable holds without a fresh ask.
		if (agent && this.isAskable(ownerKey, agent) && (askedAt === undefined || askedAt < since)) return false;
		console.error(
			`[${this.port.backendId}-relay] closing the hold on ${agentId}: unplaced for ${Math.round((at - since) / 1000)}s`,
		);
		const closing: Closing = {};
		const taken = (application: AgentApplication<TAgent>): boolean => {
			if (application.disposition === "failed" || application.disposition === "reconcile") return false;
			this.notifyChanged(ownerKey, agentId, application);
			if (application.disposition === "unconfirmed")
				closing.pending = { owner: application.owner, revision: application.catalogRevision };
			// A later landed write confirms earlier writes.
			if (application.disposition === "applied") closing.pending = undefined;
			return true;
		};
		// A refused step keeps the hold open.
		if (receipt && !taken(this.port.applyReceipt(receipt, at, true))) return false;
		// Only end turns asked about since opening.
		const askedSince = askedAt !== undefined && askedAt >= Math.max(openedAt, since);
		const report = receipt ? this.port.reconciliationReport(receipt) : undefined;
		if (askedSince && !taken(this.port.closeHeld(ownerKey, agentId, report, at))) return false;
		for (const ticket of this.frames.heldFor(key)) {
			if (ticket.state === "held" && ticket.why !== "awaiting") this.reduce(ticket, closing);
		}
		this.forgetIfClear(key);
		return true;
	}

	/** Abandon requested operations before dropping receipts. */
	private drop(ticket: FrameTicket<HeldFrame<TEvent, TReceipt>>, unwritten: Awaiting | undefined): void {
		const frame = ticket.payload;
		const { message } = frame;
		let pending = unwritten;
		if (frame.frame === "receipt" && frame.message.operationId) {
			const abandoned = this.port.abandonOperation(
				message.ownerKey,
				message.agentId,
				frame.message.operationId,
				this.now(),
			);
			if (abandoned.disposition === "failed" || abandoned.disposition === "reconcile") return;
			this.notifyChanged(message.ownerKey, message.agentId, abandoned);
			if (abandoned.disposition === "unconfirmed")
				pending = { owner: abandoned.owner, revision: abandoned.catalogRevision };
			if (abandoned.disposition === "applied") pending = undefined;
		}
		// Unfenced frames never block acknowledgements.
		if (pending && ticket.identity.stream) {
			ticket.payload = { ...frame, awaiting: pending };
			this.frames.hold(ticket, "awaiting", this.now());
			return;
		}
		console.error(
			`[${this.port.backendId}-relay] gave up a held ${frame.frame} ${message.kind} ${message.eventId} for ${message.agentId}`,
		);
		this.sendAck(this.frames.decide(ticket));
	}

	private agentOf(ownerKey: string, agentId: string): TAgent | undefined {
		const owner = this.deps.sessionStore.getByTeam(ownerKey);
		return owner ? this.port.listAgents(owner).find((agent) => agent.agentId === agentId) : undefined;
	}

	private notifyChanged(ownerKey: string, agentId: string, application: AgentApplication<TAgent>): void {
		if (!inRecord(application)) return;
		for (const listener of this.listeners.get(agentKey(ownerKey, agentId)) ?? []) {
			// Listener failures cannot undo decisions.
			try {
				listener();
			} catch (error) {
				console.error(`[${this.port.backendId}-relay] an agent change listener failed:`, error);
			}
		}
	}

	private serialize(ownerKey: string, agentId: string, step: () => void): Promise<void> {
		return this.reducers
			.run(agentKey(ownerKey, agentId), step)
			.catch((error) => console.error(`[${this.port.backendId}-relay] reducer step failed:`, error));
	}

	private frameType(kind: AgentFrameKind): string {
		return agentFrameType(this.port.backendId, kind);
	}

	private now(): number {
		return this.deps.ambient.now();
	}
}
