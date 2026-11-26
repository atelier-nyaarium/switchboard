import { REGISTER_MAX_SKEW_MS } from "../../shared/admission.js";
import {
	CONSUMER_IDLE_TTL_MS,
	formatInboxAddress,
	INBOX_REASON_SESSION_FORGOTTEN,
	INBOX_ROW_TTL_MS,
	type InboxAddress,
	type InboxRow,
	parseInboxAddress,
} from "../../shared/schemasInbox.js";
import type { ReferenceHeldStore } from "../blobs/referenceHeldStore.js";
import { OwnerQuarantined, type OwnerStateStore } from "../owner/ownerStateStore.js";
import { floorOf, ledgerTransaction, ownerAddress } from "./inboxCore.js";
import { type HeldOverMap, heldOverOf, withHeldOver } from "./inboxCustody.js";
import { type AppendedListener, type RetiredListener, retireRow } from "./inboxRetire.js";
import type { OwnerStoreRegistry } from "./ownerStoreRegistry.js";

const JOURNAL_COMPACT_BYTES = 4 * 1024 * 1024;
/** A ledger entry outlives its row by a week, for a late duplicate. */
export const OP_LEDGER_TTL_MS = INBOX_ROW_TTL_MS + 7 * 24 * 60 * 60 * 1000;
/** Ledger entries one pass drops. */
export const OP_LEDGER_SWEEP_BATCH = 2_000;

function sweepOwnerOpNonces(store: OwnerStateStore, now: number): void {
	for (const record of store.list("nonce"))
		if (now - Number(record.clear.at) > REGISTER_MAX_SKEW_MS) store.del("nonce", record.id, record.version);
}

function addresses(store: OwnerStateStore, domainId: string): string[] {
	return store
		.addresses()
		.filter(
			(address) =>
				address.startsWith(`owner:${domainId}/`) ||
				address.startsWith(`session:${domainId}/`) ||
				address.startsWith(`gateway:${domainId}/`),
		);
}

/**
 * The ledger is keyed by op, so it is swept by age. One pass is one write of at most a batch: every
 * write copies the whole store, and a write per entry held the Router for minutes. Answers how many went.
 * On no pass: nothing registers it.
 */
export function sweepOpLedger(registry: OwnerStoreRegistry, domainId: string, now: number): number {
	const store = registry.for(domainId);
	if (store.health().quarantined) return 0;
	const due = store.pick(
		"op",
		(record) => {
			const at = Number(record.clear.at);
			// An entry with no time is left.
			return Number.isFinite(at) && now - at > OP_LEDGER_TTL_MS
				? { id: record.id, version: record.version }
				: undefined;
		},
		OP_LEDGER_SWEEP_BATCH,
	);
	if (due.length === 0) return 0;
	const written = store.batch((tx) => {
		for (const entry of due) tx.del("op", entry.id, entry.version);
	});
	return written.kind === "ok" ? due.length : 0;
}

export function compactInbox(registry: OwnerStoreRegistry, domainId: string): void {
	const store = registry.for(domainId);
	const consumers = store.list("consumer");
	if (!consumers.length) return;
	const floor = Math.min(...consumers.map((r) => Number(r.clear.cursor)));
	const ownerAddressText = formatInboxAddress(ownerAddress(registry, domainId));
	if (floor + 1 <= floorOf(store, registry, domainId)) return;
	const retired = store.retire(ownerAddressText, floor);
	if (retired.kind !== "ok") return;
	const floorRecord = store.get("inbox.address", ownerAddressText);
	ledgerTransaction(store, (tx) => {
		tx.put("inbox.address", ownerAddressText, floorRecord?.version ?? null, {
			clear: { ...floorRecord?.clear, floor: floor + 1 },
		});
	});
}

export type HeldRow = (address: string, seq: number) => boolean;

/** Marks require extant rows. */
function pruneHeldOver(store: OwnerStateStore, address: string, marks: HeldOverMap, kept: HeldOverMap): void {
	if (Object.keys(kept).length === Object.keys(marks).length) return;
	const record = store.get("inbox.address", address);
	if (!record) return;
	store.put("inbox.address", address, record.version, { clear: withHeldOver(record.clear, kept) });
}

function sweepDomain(
	registry: OwnerStoreRegistry,
	routerIdentity: { signPub: string; signPriv: string },
	notifyRetired: RetiredListener,
	forgetConsumer: (domainId: string, signerSignPub: string) => void,
	domainId: string,
	now: number,
	refs?: Pick<ReferenceHeldStore, "publish">,
	notifyAppended?: AppendedListener,
	held: HeldRow = () => false,
): void {
	const store = registry.for(domainId);
	if (store.health().quarantined) return;
	sweepOwnerOpNonces(store, now);
	for (const record of store.list("consumer"))
		if (now - Number(record.clear.lastSeen) > CONSUMER_IDLE_TTL_MS)
			forgetConsumer(domainId, record.id.slice("consumer:".length));
	for (const address of addresses(store, domainId)) {
		const over = heldOverOf(store.get("inbox.address", address)?.clear);
		const kept: HeldOverMap = {};
		for (const item of store.rows(address, 1, Number.MAX_SAFE_INTEGER)) {
			const row = item.row as unknown as InboxRow;
			const key = String(item.seq);
			const mark = over[key];
			// Forgotten rows await holders.
			const due = mark ? now > mark.until : now - row.acceptedAt > INBOX_ROW_TTL_MS && !held(address, item.seq);
			const retired =
				due &&
				retireRow(
					registry,
					routerIdentity,
					store,
					domainId,
					parseInboxAddress(address) as InboxAddress,
					row,
					mark ? "failed" : "expired",
					mark ? INBOX_REASON_SESSION_FORGOTTEN : undefined,
					notifyRetired,
					refs,
					notifyAppended,
				) !== null;
			if (mark && !retired) kept[key] = mark;
		}
		pruneHeldOver(store, address, over, kept);
	}
	compactInbox(registry, domainId);
	if (store.health().journalBytes > JOURNAL_COMPACT_BYTES) store.compact();
}

export function sweepInbox(
	registry: OwnerStoreRegistry,
	routerIdentity: { signPub: string; signPriv: string },
	notifyRetired: RetiredListener,
	forgetConsumer: (domainId: string, signerSignPub: string) => void,
	now: number,
	refs?: Pick<ReferenceHeldStore, "publish">,
	notifyAppended?: AppendedListener,
	held?: HeldRow,
): void {
	for (const domainId of registry.domains()) {
		try {
			sweepDomain(
				registry,
				routerIdentity,
				notifyRetired,
				forgetConsumer,
				domainId,
				now,
				refs,
				notifyAppended,
				held,
			);
		} catch (error) {
			if (error instanceof OwnerQuarantined) continue;
			console.warn(`[inbox] sweep skipped ${domainId}: ${(error as Error).message}`);
		}
	}
}
