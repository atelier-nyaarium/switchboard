import type { Ambient } from "../shared/ambient.js";
import type { AwarenessObservation, AwarenessSubscriber, Change } from "../shared/awareness-types.js";
import type { ActAxis, ChannelPushPayload, RidingAwareness } from "../shared/types.js";

export type { ActAxis, RidingAwareness } from "../shared/types.js";

/** Waking sessions remain eligible for delivery. */
export type SessionLiveness = "live" | "waking" | "gone";

/** What one carrier holds, settled once. */
export interface AwarenessLease {
	readonly awareness: RidingAwareness;
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

type SessionBank = {
	entries: Map<string, Entry>;
	firstSeen: number;
	heldSince?: number;
	dueAt?: number;
	leased: boolean;
};

/** No-ack replies are absorbed by `respond()`. */
const NO_ACK_SESSION_PREFIX = "na-";

/** Hold window for riding an act-now message. */
export const ACT_NOW_HOLD_MS = 60_000;

/** Maximum wait for a waking session, a failing push, or a gone session's bank. */
export const MAX_HOLD_MS = 600_000;

/** Of one rendered notice, whatever the subscribers render. */
export const MAX_AWARENESS_BODY_CHARS = 16_000;

const TRUNCATED_NOTE = "(More changed than fits here.)";

/** Between pushes that failed. */
const RETRY_MS = 1_000;

export function isNoAckSessionId(sessionId: string): boolean {
	return sessionId.startsWith(NO_ACK_SESSION_PREFIX);
}

export function mintNoAckSessionId(ambient: Pick<Ambient, "randomBytes">): string {
	return `${NO_ACK_SESSION_PREFIX}${ambient.randomBytes(8).toString("hex")}`;
}

export function createAwarenessBank(deps: AwarenessBankDeps): AwarenessBank {
	const sessions = new Map<string, SessionBank>();
	const clock = () => deps.ambient.now();

	function changeCount(bank: SessionBank): number {
		return [...bank.entries.values()].reduce((count, entry) => count + entry.changes.size, 0);
	}

	function bankFor(sessionKey: string): SessionBank {
		let bank = sessions.get(sessionKey);
		if (!bank) {
			bank = { entries: new Map(), firstSeen: clock(), leased: false };
			sessions.set(sessionKey, bank);
		}
		return bank;
	}

	function isUrgent(sessionKey: string, entry: Entry, change: Change<unknown>): boolean {
		return entry.subscriber.act(sessionKey, change.pre, change.post) === "act_now";
	}

	function bounded(body: string): string {
		if (body.length <= MAX_AWARENESS_BODY_CHARS) return body;
		const room = MAX_AWARENESS_BODY_CHARS - TRUNCATED_NOTE.length - 2;
		const line = body.lastIndexOf("\n", room);
		// Never between the halves of a surrogate pair.
		const cut = line > 0 ? line : /[\uD800-\uDBFF]/.test(body[room - 1] ?? "") ? room - 1 : room;
		return `${body.slice(0, cut)}\n\n${TRUNCATED_NOTE}`;
	}

	/** Renders current net changes. */
	function content(sessionKey: string, bank: SessionBank): RidingAwareness | null {
		const rendered: { from: string; body: string; act: ActAxis }[] = [];
		for (const entry of bank.entries.values()) {
			const changes = [...entry.changes.values()];
			const body = entry.subscriber.render(sessionKey, changes);
			if (!body) continue;
			const urgent = changes.some((change) => isUrgent(sessionKey, entry, change));
			rendered.push({ from: entry.subscriber.source, body, act: urgent ? "act_now" : "no_act" });
		}
		if (rendered.length === 0) return null;
		return {
			from: rendered.length === 1 ? rendered[0].from : "awareness",
			body: bounded(rendered.map((item) => item.body).join("\n\n")),
			act: rendered.some((item) => item.act === "act_now") ? "act_now" : "no_act",
		};
	}

	function drop(sessionKey: string, bank: SessionBank, why: string): void {
		console.error(`[awareness] dropped ${changeCount(bank)} change(s) for ${sessionKey}: ${why}`);
		sessions.delete(sessionKey);
	}

	/** Removes what a carrier held. A change observed since keeps its delta from what was delivered. */
	function settle(sessionKey: string, bank: SessionBank, carried: Map<Entry, Map<string, Change<unknown>>>): void {
		bank.leased = false;
		if (sessions.get(sessionKey) !== bank) return;
		for (const [entry, changes] of carried) {
			for (const [identity, sent] of changes) {
				const current = entry.changes.get(identity);
				if (current === sent) entry.changes.delete(identity);
				else if (current) entry.changes.set(identity, { ...current, pre: sent.post });
			}
			if (entry.changes.size === 0) bank.entries.delete(entry.subscriber.source);
		}
		if (bank.entries.size === 0) {
			sessions.delete(sessionKey);
			return;
		}
		const urgent = [...bank.entries.values()].some((entry) =>
			[...entry.changes.values()].some((change) => isUrgent(sessionKey, entry, change)),
		);
		if (!urgent) {
			bank.heldSince = undefined;
			bank.dueAt = undefined;
		}
	}

	function prepareFor(sessionKey: string): AwarenessLease | null {
		const bank = sessions.get(sessionKey);
		if (!bank || bank.leased) return null;
		const awareness = content(sessionKey, bank);
		if (!awareness) {
			sessions.delete(sessionKey);
			return null;
		}
		const carried = new Map([...bank.entries.values()].map((entry) => [entry, new Map(entry.changes)]));
		bank.leased = true;
		let settled = false;
		return {
			awareness,
			commit() {
				if (settled) return;
				settled = true;
				settle(sessionKey, bank, carried);
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
			body: lease.awareness.body,
			session_id: mintNoAckSessionId(deps.ambient),
			no_ack: true,
			act: lease.awareness.act,
		});
		if (sent) {
			lease.commit();
			console.error(`[awareness] pushed content to ${sessionKey}`);
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
					if (
						subscriber.act(observation.sessionKey, observation.pre as S, observation.post as S) ===
						"act_now"
					) {
						if (bank.heldSince === undefined) bank.heldSince = clock();
						bank.dueAt = bank.heldSince + ACT_NOW_HOLD_MS;
					}
				}
			};
		},
		prepareFor,
		dropFor(sessionKey) {
			sessions.delete(sessionKey);
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
