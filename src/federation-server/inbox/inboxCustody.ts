// Gateway row custody.

/** Holder settlement window. */
export const INBOX_HOLD_MS = 5 * 60_000;

export interface Hold {
	gatewayId: string;
	incarnation: number;
	until: number;
}

/** Mark for forgotten rows. */
export interface HeldOver {
	/** Original delivery epoch. */
	epoch: number;
	until: number;
}

export type HeldOverMap = Record<string, HeldOver>;

export function heldOverOf(clear: Record<string, unknown> | undefined): HeldOverMap {
	const raw = clear?.heldOver;
	if (!raw || typeof raw !== "object") return {};
	const marks: HeldOverMap = {};
	for (const [seq, mark] of Object.entries(raw as Record<string, unknown>)) {
		const { epoch, until } = (mark ?? {}) as Partial<HeldOver>;
		if (typeof epoch === "number" && typeof until === "number") marks[seq] = { epoch, until };
	}
	return marks;
}

export function withHeldOver(clear: Record<string, unknown> | undefined, marks: HeldOverMap): Record<string, unknown> {
	const { heldOver: _replaced, ...rest } = clear ?? {};
	return Object.keys(marks).length > 0 ? { ...rest, heldOver: marks } : rest;
}

/** Restarts clear custody. */
export class InboxCustody {
	private readonly holds = new Map<string, Hold>();

	private key(address: string, seq: number): string {
		return `${address}#${seq}`;
	}

	pushed(
		address: string,
		seqs: readonly number[],
		by: { gatewayId: string; incarnation: number },
		now: number,
	): void {
		for (const seq of seqs) this.holds.set(this.key(address, seq), { ...by, until: now + INBOX_HOLD_MS });
	}

	/** Current Gateway incarnation. */
	holder(address: string, seq: number, live: number | null, now: number): Hold | null {
		const key = this.key(address, seq);
		const hold = this.holds.get(key);
		if (!hold) return null;
		if (hold.incarnation === live && now <= hold.until) return hold;
		this.holds.delete(key);
		return null;
	}

	release(address: string, seq: number): void {
		this.holds.delete(this.key(address, seq));
	}

	prune(now: number): void {
		for (const [key, hold] of this.holds) if (now > hold.until) this.holds.delete(key);
	}
}
