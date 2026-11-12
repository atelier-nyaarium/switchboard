////////////////////////////////
//  Interfaces & Types

export interface FrameIdentity {
	frame: "event" | "receipt";
	/** Whose reducer takes it. */
	agent: string;
	daemonInstanceId: string;
	eventId: number;
	/** Refusals have no stream. */
	stream?: { targetId: string; generation: number };
	droppable: boolean;
}

/** Unconfirmed record write. */
export type HoldReason = "reconcile" | "failed" | "awaiting";

export interface FrameTicket<P> {
	readonly identity: FrameIdentity;
	payload: P;
	state: "open" | "held" | "decided";
	why?: HoldReason;
	/** First hold time survives retries. */
	heldSince?: number;
	counted: boolean;
	/** Repeat ack at or below mark. */
	readonly acked: boolean;
}

export type FrameArrival<P> =
	| { kind: "new"; ticket: FrameTicket<P> }
	| { kind: "held"; ticket: FrameTicket<P> }
	| { kind: "queued" }
	| { kind: "decided"; ack?: FrameAck };

export interface FrameAck {
	daemonInstanceId: string;
	targetId: string;
	generation: number;
	throughEventId: number;
}

export interface HoldResult {
	/** False if this ticket was dropped. */
	kept: boolean;
	acks: FrameAck[];
}

interface Stream<P> {
	daemonInstanceId: string;
	targetId: string;
	generation: number;
	open: Map<number, FrameTicket<P>>;
	highestDecided: number;
	committedThrough: number;
}

////////////////////////////////
//  Functions & Helpers

function streamKey(daemonInstanceId: string, stream: { targetId: string; generation: number }): string {
	return `${daemonInstanceId} ${stream.targetId} ${stream.generation}`;
}

function unfencedKey(identity: FrameIdentity): string {
	return `${identity.frame} ${identity.daemonInstanceId} ${identity.eventId}`;
}

////////////////////////////////
//  Class

/** Undecided frames block acknowledgements. */
export class AgentFrameLedger<P> {
	private readonly streams = new Map<string, Stream<P>>();
	private readonly unfenced = new Map<string, FrameTicket<P>>();
	private readonly held = new Map<string, Array<FrameTicket<P>>>();

	constructor(private readonly maxHeldPerAgent: number) {}

	receive(identity: FrameIdentity, payload: P): FrameArrival<P> {
		const stream = identity.stream ? this.stream(identity.daemonInstanceId, identity.stream) : undefined;
		const standing = stream ? stream.open.get(identity.eventId) : this.unfenced.get(unfencedKey(identity));
		if (standing) return standing.state === "held" ? { kind: "held", ticket: standing } : { kind: "queued" };
		// Retries may need the lost acknowledgement.
		const acked = stream !== undefined && identity.eventId <= stream.committedThrough;
		// Events order by stream; receipts by operation.
		if (stream && identity.frame === "event" && identity.eventId <= stream.highestDecided) {
			const ack = this.ackOf(stream, acked);
			return { kind: "decided", ...(ack ? { ack } : {}) };
		}
		const ticket: FrameTicket<P> = { identity, payload, state: "open", counted: false, acked };
		if (stream) stream.open.set(identity.eventId, ticket);
		else this.unfenced.set(unfencedKey(identity), ticket);
		return { kind: "new", ticket };
	}

	/** Commit only after sending. */
	decide(ticket: FrameTicket<P>): FrameAck | undefined {
		if (ticket.state === "decided") return undefined;
		if (ticket.state === "held") this.unlist(ticket);
		ticket.state = "decided";
		const { identity } = ticket;
		if (!identity.stream) {
			this.unfenced.delete(unfencedKey(identity));
			return undefined;
		}
		const stream = this.stream(identity.daemonInstanceId, identity.stream);
		stream.open.delete(identity.eventId);
		stream.highestDecided = Math.max(stream.highestDecided, identity.eventId);
		return this.ackOf(stream, ticket.acked);
	}

	hold(ticket: FrameTicket<P>, why: HoldReason, now: number): HoldResult {
		if (ticket.state === "decided") return { kept: false, acks: [] };
		const queue = this.held.get(ticket.identity.agent) ?? [];
		if (ticket.state !== "held") {
			queue.push(ticket);
			this.held.set(ticket.identity.agent, queue);
		}
		ticket.state = "held";
		ticket.why = why;
		ticket.heldSince ??= now;
		const acks: FrameAck[] = [];
		while (queue.length > this.maxHeldPerAgent) {
			const dropped = queue.find((candidate) => candidate.identity.droppable);
			if (!dropped) break;
			const ack = this.decide(dropped);
			if (ack) acks.push(ack);
		}
		return { kept: ticket.state === "held", acks };
	}

	heldFor(agent: string): Array<FrameTicket<P>> {
		return [...(this.held.get(agent) ?? [])].sort((left, right) => left.identity.eventId - right.identity.eventId);
	}

	holds(agent: string): boolean {
		return this.held.has(agent);
	}

	heldAgents(): string[] {
		return [...this.held.keys()];
	}

	/** Oldest matching hold time. */
	heldSince(agent: string, reasons: readonly HoldReason[]): number | undefined {
		let oldest: number | undefined;
		for (const ticket of this.held.get(agent) ?? []) {
			if (ticket.why === undefined || !reasons.includes(ticket.why) || ticket.heldSince === undefined) continue;
			oldest = oldest === undefined ? ticket.heldSince : Math.min(oldest, ticket.heldSince);
		}
		return oldest;
	}

	/** Only sent acknowledgements advance the mark. */
	acknowledged(ack: FrameAck): void {
		const stream = this.streams.get(streamKey(ack.daemonInstanceId, ack));
		if (stream) stream.committedThrough = Math.max(stream.committedThrough, ack.throughEventId);
	}

	private unlist(ticket: FrameTicket<P>): void {
		const queue = this.held.get(ticket.identity.agent);
		if (!queue) return;
		const index = queue.indexOf(ticket);
		if (index >= 0) queue.splice(index, 1);
		if (queue.length === 0) this.held.delete(ticket.identity.agent);
	}

	private stream(daemonInstanceId: string, at: { targetId: string; generation: number }): Stream<P> {
		const key = streamKey(daemonInstanceId, at);
		let stream = this.streams.get(key);
		if (!stream) {
			stream = {
				daemonInstanceId,
				targetId: at.targetId,
				generation: at.generation,
				open: new Map(),
				highestDecided: -1,
				committedThrough: -1,
			};
			this.streams.set(key, stream);
		}
		return stream;
	}

	/** Only the decided prefix is acknowledged. */
	private ackOf(stream: Stream<P>, again: boolean): FrameAck | undefined {
		let lowestOpen = Number.POSITIVE_INFINITY;
		for (const eventId of stream.open.keys()) lowestOpen = Math.min(lowestOpen, eventId);
		const through = Math.min(stream.highestDecided, lowestOpen - 1);
		if (through < stream.committedThrough || (through === stream.committedThrough && !again)) return undefined;
		return {
			daemonInstanceId: stream.daemonInstanceId,
			targetId: stream.targetId,
			generation: stream.generation,
			throughEventId: through,
		};
	}
}
