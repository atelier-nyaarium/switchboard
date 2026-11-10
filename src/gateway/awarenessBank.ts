import { mintNoAckSessionId } from "../shared/agent-notice.js";
import type { Ambient } from "../shared/ambient.js";
import type { AwarenessObservation, AwarenessSubscriber, Change } from "../shared/awareness-types.js";
import type { ActAxis, ChannelPushPayload, RidingAwareness } from "../shared/types.js";

export type { ActAxis, RidingAwareness } from "../shared/types.js";

/** Waking sessions remain eligible for delivery. */
export type SessionLiveness = "live" | "waking" | "gone";

/** What one carrier holds, settled once. */
export interface AwarenessLease {
	readonly awareness: RidingAwareness;
	/** Changes were left for the next push. */
	readonly overflowed: boolean;
	/** The carrier was accepted; changes observed since stay banked. */
	commit(): void;
	/** The carrier was refused; everything stays banked. */
	release(): void;
}

export interface AwarenessBank {
	register<S>(subscriber: AwarenessSubscriber<S>): (observations: readonly AwarenessObservation<S>[]) => void;
	/** Null while another carrier holds the session's bank. */
	prepareFor(sessionKey: string): AwarenessLease | null;
	dropFor(sessionKey: string): void;
	/** Cannot retract prepared carriers. */
	withdraw(sessionKey: string, source: string, identity: string): void;
	tick(now?: number): void;
	stop(): void;
}

export interface AwarenessBankDeps {
	liveness(sessionKey: string): SessionLiveness;
	deliver(sessionKey: string, payload: ChannelPushPayload): boolean;
	ambient: Pick<Ambient, "now" | "randomBytes">;
}

type Entry = {
	subscriber: AwarenessSubscriber<unknown>;
	changes: Map<string, Change<unknown>>;
};

/** The parts of one notice too large for a push, sent first in order. */
type Part = { from: string; body: string; act: ActAxis };

type SessionBank = {
	entries: Map<string, Entry>;
	parts: Part[];
	firstSeen: number;
	heldSince?: number;
	dueAt?: number;
	leased: boolean;
};

/** Hold window for riding an act-now message. */
export const ACT_NOW_HOLD_MS = 60_000;

/** Maximum wait for a waking session, a failing push, or a gone session's bank. */
export const MAX_HOLD_MS = 600_000;

/** Of one rendered notice, whatever the subscribers render. */
export const MAX_AWARENESS_BODY_CHARS = 16_000;

/** Ends a notice sent in parts. */
const LARGE_NOTICE_NOTE = "This notice was too large for one message and came in parts. Tell the user about it.";

/** Room a part keeps for its marker. */
const PART_NOTE_ROOM = 40 + LARGE_NOTICE_NOTE.length;

/** Between pushes that failed. */
const RETRY_MS = 1_000;

export function createAwarenessBank(deps: AwarenessBankDeps): AwarenessBank {
	const sessions = new Map<string, SessionBank>();
	const clock = () => deps.ambient.now();

	function changeCount(bank: SessionBank): number {
		return [...bank.entries.values()].reduce((count, entry) => count + entry.changes.size, bank.parts.length);
	}

	function bankFor(sessionKey: string): SessionBank {
		let bank = sessions.get(sessionKey);
		if (!bank) {
			bank = { entries: new Map(), parts: [], firstSeen: clock(), leased: false };
			sessions.set(sessionKey, bank);
		}
		return bank;
	}

	function isUrgent(sessionKey: string, entry: Entry, change: Change<unknown>): boolean {
		return entry.subscriber.act(sessionKey, change.pre, change.post) === "act_now";
	}

	/** Pushes on a deadline: urgent, or a `no_act` change its subscriber pushes anyway. */
	function isDue(sessionKey: string, entry: Entry, change: Change<unknown>): boolean {
		return (
			isUrgent(sessionKey, entry, change) || entry.subscriber.push?.(sessionKey, change.pre, change.post) === true
		);
	}

	/** Where to cut `body` within `room`: a line break, else never inside a surrogate pair. */
	function cutAt(body: string, room: number): number {
		const line = body.lastIndexOf("\n", room);
		if (line > 0) return line;
		return /[\uD800-\uDBFF]/.test(body[room - 1] ?? "") ? room - 1 : room;
	}

	/** Splits a body too large for one push; each part names its place. */
	function split(from: string, body: string, act: ActAxis, firstRoom: number): Part[] {
		const pieces: string[] = [];
		let rest = body;
		let room = firstRoom;
		while (rest.length > room) {
			const cut = cutAt(rest, room);
			pieces.push(rest.slice(0, cut));
			rest = rest.slice(cut).replace(/^\n/, "");
			room = MAX_AWARENESS_BODY_CHARS - PART_NOTE_ROOM;
		}
		pieces.push(rest);
		return pieces.map((piece, index) => ({
			from,
			act,
			body:
				index + 1 < pieces.length
					? `${piece}\n\n(part ${index + 1} of ${pieces.length}, continued)`
					: `${piece}\n\n(part ${index + 1} of ${pieces.length}) ${LARGE_NOTICE_NOTE}`,
		}));
	}

	type Carried = Map<Entry, Map<string, Change<unknown>>>;

	/**
	 * Fills one push: a held part first, then banked changes whole while they fit; the rest wait for
	 * the next push. A change too large alone is split into parts, the first riding this push.
	 */
	function content(
		sessionKey: string,
		bank: SessionBank,
	): { awareness: RidingAwareness; carried: Carried; parts: Part[]; overflowed: boolean } | null {
		const rendered: Part[] = [];
		const carried: Carried = new Map();
		const room = () => MAX_AWARENESS_BODY_CHARS - rendered.reduce((n, item) => n + item.body.length + 2, 0);
		let parts: Part[] = [];
		const held = bank.parts[0];
		if (held) rendered.push(held);
		let overflowed = bank.parts.length > 1;
		for (const entry of bank.entries.values()) {
			if (overflowed) break;
			const taken = new Map<string, Change<unknown>>();
			let body = "";
			for (const [identity, change] of entry.changes) {
				const trial = new Map(taken).set(identity, change);
				const trialBody = entry.subscriber.render(sessionKey, [...trial.values()]);
				if (trialBody.length + (rendered.length > 0 ? 2 : 0) <= room()) {
					taken.set(identity, change);
					body = trialBody;
					continue;
				}
				overflowed = true;
				const alone = entry.subscriber.render(sessionKey, [change]);
				if (alone.length <= MAX_AWARENESS_BODY_CHARS - PART_NOTE_ROOM) break;
				// Too large for any push: its first part rides this one.
				if (body) rendered.push(partOf(sessionKey, entry, taken, body));
				const urgent = isUrgent(sessionKey, entry, change) ? "act_now" : "no_act";
				const firstRoom = room() - PART_NOTE_ROOM - (rendered.length > 0 ? 2 : 0);
				const pieces = split(
					entry.subscriber.source,
					alone,
					urgent,
					firstRoom > 0 ? firstRoom : MAX_AWARENESS_BODY_CHARS - PART_NOTE_ROOM,
				);
				if (firstRoom > 0) rendered.push(pieces.shift()!);
				parts = pieces;
				taken.set(identity, change);
				carried.set(entry, taken);
				break;
			}
			if (overflowed) {
				if (taken.size > 0 && !carried.has(entry)) {
					carried.set(entry, taken);
					if (body) rendered.push(partOf(sessionKey, entry, taken, body));
				}
				break;
			}
			if (taken.size === 0) continue;
			carried.set(entry, taken);
			if (body) rendered.push(partOf(sessionKey, entry, taken, body));
		}
		if (rendered.length === 0) return null;
		return {
			awareness: {
				from: [...new Set(rendered.map((item) => item.from))].join(", "),
				body: rendered.map((item) => item.body).join("\n\n"),
				act: rendered.some((item) => item.act === "act_now") ? "act_now" : "no_act",
			},
			carried,
			parts,
			overflowed: overflowed || parts.length > 0,
		};
	}

	function partOf(sessionKey: string, entry: Entry, taken: Map<string, Change<unknown>>, body: string): Part {
		const urgent = [...taken.values()].some((change) => isUrgent(sessionKey, entry, change));
		return { from: entry.subscriber.source, body, act: urgent ? "act_now" : "no_act" };
	}

	function drop(sessionKey: string, bank: SessionBank, why: string): void {
		console.error(`[awareness] dropped ${changeCount(bank)} change(s) for ${sessionKey}: ${why}`);
		sessions.delete(sessionKey);
		for (const entry of bank.entries.values()) {
			for (const change of entry.changes.values()) entry.subscriber.dropped?.(sessionKey, change);
		}
	}

	function rearm(sessionKey: string, bank: SessionBank): void {
		const due = [...bank.entries.values()].some((entry) =>
			[...entry.changes.values()].some((change) => isDue(sessionKey, entry, change)),
		);
		if (!due) {
			bank.heldSince = undefined;
			bank.dueAt = undefined;
		}
	}

	/** Removes what a carrier held. A change observed since keeps its delta from what was delivered. */
	function settle(
		sessionKey: string,
		bank: SessionBank,
		carried: Carried,
		sentPart: boolean,
		parts: Part[],
		overflowed: boolean,
	): void {
		bank.leased = false;
		if (sessions.get(sessionKey) !== bank) return;
		if (sentPart) bank.parts.shift();
		bank.parts.push(...parts);
		for (const [entry, changes] of carried) {
			for (const [identity, sent] of changes) {
				const current = entry.changes.get(identity);
				if (current === sent) entry.changes.delete(identity);
				else if (current) entry.changes.set(identity, { ...current, pre: sent.post });
			}
			if (entry.changes.size === 0) bank.entries.delete(entry.subscriber.source);
		}
		if (bank.entries.size === 0 && bank.parts.length === 0) {
			sessions.delete(sessionKey);
			return;
		}
		rearm(sessionKey, bank);
		// What did not fit follows at once.
		if (overflowed) {
			bank.heldSince ??= clock();
			bank.dueAt = clock();
		}
	}

	function prepareFor(sessionKey: string): AwarenessLease | null {
		const bank = sessions.get(sessionKey);
		if (!bank || bank.leased) return null;
		const filled = content(sessionKey, bank);
		if (!filled) {
			sessions.delete(sessionKey);
			return null;
		}
		const { awareness, carried, parts, overflowed } = filled;
		const sentPart = bank.parts.length > 0;
		bank.leased = true;
		let settled = false;
		return {
			awareness,
			overflowed,
			commit() {
				if (settled) return;
				settled = true;
				for (const [entry, changes] of carried) {
					if (!entry.subscriber.delivered) continue;
					if (!entry.subscriber.render(sessionKey, [...changes.values()])) continue;
					for (const change of changes.values()) {
						try {
							entry.subscriber.delivered(sessionKey, change);
						} catch {}
					}
				}
				settle(sessionKey, bank, carried, sentPart, parts, overflowed);
			},
			release() {
				if (settled) return;
				settled = true;
				bank.leased = false;
			},
		};
	}

	/** Pushes when a deadline is due, and removes only what was delivered. */
	function deadline(sessionKey: string, bank: SessionBank, now: number): void {
		const liveness = deps.liveness(sessionKey);
		if (liveness === "gone") {
			drop(sessionKey, bank, "no live session");
			return;
		}
		const expired = bank.heldSince !== undefined && now - bank.heldSince >= MAX_HOLD_MS;
		if (liveness === "waking") {
			if (expired) drop(sessionKey, bank, "wake never landed");
			else bank.dueAt = now + RETRY_MS;
			return;
		}
		// Null while a send carries it; that send settles it.
		const lease = prepareFor(sessionKey);
		if (!lease) return;
		const sent = deps.deliver(sessionKey, {
			type: "channel_push",
			from: lease.awareness.from,
			// Awareness, never a sender body.
			body: "",
			awareness: lease.awareness,
			session_id: mintNoAckSessionId(deps.ambient),
			no_ack: true,
			act: lease.awareness.act,
		});
		if (sent) {
			lease.commit();
			console.error(`[awareness] pushed content to ${sessionKey}`);
			// The rest of a burst goes now, not on the next tick.
			if (lease.overflowed && sessions.get(sessionKey) === bank) deadline(sessionKey, bank, now);
			return;
		}
		lease.release();
		if (expired) drop(sessionKey, bank, "every push failed");
		else bank.dueAt = now + RETRY_MS;
	}

	return {
		register<S>(subscriber: AwarenessSubscriber<S>) {
			const erased = subscriber as unknown as AwarenessSubscriber<unknown>;
			return (observations) => {
				for (const observation of observations) {
					const bank = bankFor(observation.sessionKey);
					let entry = bank.entries.get(erased.source);
					if (!entry) {
						entry = { subscriber: erased, changes: new Map() };
						bank.entries.set(erased.source, entry);
					}
					const previous = entry.changes.get(observation.identity);
					entry.changes.set(observation.identity, {
						identity: observation.identity,
						pre: previous?.pre ?? observation.pre,
						post: observation.post,
					});
					const pre = observation.pre as S;
					const post = observation.post as S;
					const urgent = subscriber.act(observation.sessionKey, pre, post) === "act_now";
					const pushed = subscriber.push?.(observation.sessionKey, pre, post) === true;
					if (urgent || pushed) {
						if (bank.heldSince === undefined) bank.heldSince = clock();
						bank.dueAt = urgent
							? bank.heldSince + ACT_NOW_HOLD_MS
							: clock() + (subscriber.pushAfterMs ?? ACT_NOW_HOLD_MS);
					}
				}
			};
		},
		prepareFor,
		dropFor(sessionKey) {
			sessions.delete(sessionKey);
		},
		withdraw(sessionKey, source, identity) {
			const bank = sessions.get(sessionKey);
			const entry = bank?.entries.get(source);
			if (!bank || !entry?.changes.delete(identity)) return;
			if (entry.changes.size === 0) bank.entries.delete(source);
			if (bank.leased) return;
			if (bank.entries.size === 0 && bank.parts.length === 0) sessions.delete(sessionKey);
			else rearm(sessionKey, bank);
		},
		tick(now = clock()) {
			for (const [sessionKey, bank] of [...sessions]) {
				if (bank.dueAt !== undefined) {
					if (bank.dueAt <= now) deadline(sessionKey, bank, now);
					continue;
				}
				// A bank that only rides a later message still ends with its session.
				if (!bank.leased && now - bank.firstSeen >= MAX_HOLD_MS && deps.liveness(sessionKey) === "gone") {
					drop(sessionKey, bank, "no live session");
				}
			}
		},
		stop() {
			sessions.clear();
		},
	};
}
