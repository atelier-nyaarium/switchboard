import fs from "node:fs";
import path from "node:path";
import type { Clock } from "../../shared/ambient.js";
import { commitChecked, DurableStore } from "../../shared/durable-store.js";

const CLAIMS_DIR = "inbox-claims";
const CLAIM_PREFIX = "claim-";

export interface InboxClaim {
	deliveryId: string;
	seq: number;
	deliveryEpoch: number;
	offeredAt: number;
	outcome: "delivered" | "waking" | "failed";
}

interface ClaimFile {
	deliveryEpoch: number;
	claims: Record<string, InboxClaim>;
}

export class InboxClaims {
	private readonly files = new Map<string, DurableStore>();
	private readonly claims = new Map<string, ClaimFile>();

	constructor(
		private readonly dataDir: string,
		private readonly ambient: Clock,
	) {}

	claim(address: string, seq: number, deliveryEpoch: number): InboxClaim | null {
		this.file(address);
		const held = this.claims.get(address)!;
		const current = held.deliveryEpoch === deliveryEpoch ? held : { deliveryEpoch, claims: {} };
		const deliveryId = `${address}:${seq}:${deliveryEpoch}`;
		const existing = current.claims[deliveryId];
		if (existing) return existing;
		const claim = {
			deliveryId,
			seq,
			deliveryEpoch,
			offeredAt: this.ambient.now(),
			outcome: "waking" as const,
		};
		this.commit(address, { deliveryEpoch, claims: { ...current.claims, [deliveryId]: claim } });
		return null;
	}

	get(address: string, seq: number, deliveryEpoch: number): InboxClaim | null {
		this.file(address);
		const current = this.claims.get(address)!;
		if (current.deliveryEpoch !== deliveryEpoch) return null;
		return current.claims[`${address}:${seq}:${deliveryEpoch}`] ?? null;
	}

	setOutcome(address: string, seq: number, deliveryEpoch: number, outcome: InboxClaim["outcome"]): void {
		this.file(address);
		const current = this.claims.get(address)!;
		if (current.deliveryEpoch !== deliveryEpoch) return;
		const deliveryId = `${address}:${seq}:${deliveryEpoch}`;
		const claim = current.claims[deliveryId];
		if (!claim) return;
		this.commit(address, { deliveryEpoch, claims: { ...current.claims, [deliveryId]: { ...claim, outcome } } });
	}

	ack(address: string, seq: number, deliveryEpoch: number): void {
		this.file(address);
		const current = this.claims.get(address)!;
		if (current.deliveryEpoch !== deliveryEpoch) return;
		const deliveryId = `${address}:${seq}:${deliveryEpoch}`;
		// A forgotten address gets no file back.
		if (!(deliveryId in current.claims)) return;
		const { [deliveryId]: _acked, ...kept } = current.claims;
		this.commit(address, { deliveryEpoch, claims: kept });
	}

	/** Every address with a claim file. */
	addresses(): string[] {
		let names: string[];
		try {
			names = fs.readdirSync(path.join(this.dataDir, CLAIMS_DIR));
		} catch {
			return [];
		}
		return names
			.filter((name) => name.startsWith(CLAIM_PREFIX) && name.endsWith(".json"))
			.map((name) => Buffer.from(name.slice(CLAIM_PREFIX.length, -".json".length), "base64url").toString());
	}

	/** Deletes an address's file. A failure leaves it for the next try. */
	forget(address: string): boolean {
		try {
			this.file(address).remove();
		} catch {
			return false;
		}
		this.files.delete(address);
		this.claims.delete(address);
		return true;
	}

	/** Throws unless landed. */
	private commit(address: string, next: ClaimFile): void {
		const written = commitChecked(this.file(address), next, (landed) => this.claims.set(address, landed));
		if (!written.landed) throw written.error;
	}

	private file(address: string): DurableStore {
		const existing = this.files.get(address);
		if (existing) return existing;
		const name = `${CLAIM_PREFIX}${Buffer.from(address).toString("base64url")}`;
		const store = new DurableStore(path.join(this.dataDir, CLAIMS_DIR), name);
		const restored = store.load();
		const state: ClaimFile =
			restored && typeof restored === "object" && typeof (restored as ClaimFile).deliveryEpoch === "number"
				? (restored as ClaimFile)
				: { deliveryEpoch: 0, claims: {} };
		this.files.set(address, store);
		this.claims.set(address, state);
		return store;
	}
}

export function createInboxClaims(dataDir: string, ambient: Clock): InboxClaims {
	return new InboxClaims(dataDir, ambient);
}
