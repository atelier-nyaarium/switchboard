import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CrossDomainShareTargetSchema } from "../../shared/schemas.js";
import type { ShareMirrorDelta, ShareMirrorSnapshot } from "../../shared/schemasShare.js";
import {
	all as allShares,
	isSharedTo as isShareSharedTo,
	type ShareRecord,
	type ShareState,
	sharesFor as sharesForRule,
	targetKey,
} from "../../shared/share-rules.js";

export type { ShareRecord } from "../../shared/share-rules.js";

const ShareRecordSchema = z.object({
	sessionTarget: z.string().min(1),
	target: CrossDomainShareTargetSchema,
	lastSeenAt: z.number().int(),
});
const CrossDomainShareFileSchema = z.object({
	revision: z.number().int().nonnegative(),
	shares: z.array(ShareRecordSchema),
});

export type ShareChangeReason = { kind: "domain"; domainId: string } | { kind: "sweep" };
/** What a snapshot or delta changed, once on disk. */
export type ShareMirrorChange = { reason: ShareChangeReason; removed: ShareRecord[] };

export const XDOMAIN_SHARE_FILE = "cross-domain-share-state.json";

const recordKey = (record: { sessionTarget: string; target: ShareRecord["target"] }): string =>
	`${record.sessionTarget}|${targetKey(record.target)}`;

/** The Router writes; this reads, and reads nothing until a snapshot of this registration lands. */
export class CrossDomainShareState {
	private file: string;
	private state: ShareState;
	private held: number;
	private ready = false;
	private readonly onChange?: (change: ShareMirrorChange) => void;

	constructor(dataDir: string, onChange?: (change: ShareMirrorChange) => void) {
		this.file = path.join(dataDir, XDOMAIN_SHARE_FILE);
		const read = this.read();
		this.state = { shares: read.shares };
		this.held = read.revision;
		this.onChange = onChange;
	}

	private read(): { revision: number; shares: ShareRecord[] } {
		try {
			const parsed = CrossDomainShareFileSchema.safeParse(JSON.parse(fs.readFileSync(this.file, "utf8")));
			if (parsed.success) return parsed.data;
		} catch {
			// Unreadable state starts empty.
		}
		return { revision: 0, shares: [] };
	}

	/** On disk before memory, so a failed write changes nothing. */
	private land(revision: number, shares: ShareRecord[]): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.writeFileSync(this.file, JSON.stringify({ revision, shares }), { mode: 0o600 });
		this.state = { shares };
		this.held = revision;
	}

	revision(): number {
		return this.held;
	}

	/** True once a snapshot of this registration landed. */
	isReady(): boolean {
		return this.ready;
	}

	/** Nothing is shared until the next snapshot. */
	unready(): void {
		this.ready = false;
	}

	/** The Router's answer stands, whatever was held. */
	replace(snapshot: ShareMirrorSnapshot): void {
		const before = this.state.shares;
		const next = new Set(snapshot.shares.map(recordKey));
		const removed = before.filter((record) => !next.has(recordKey(record)));
		const added = snapshot.shares.filter((record) => !before.some((held) => recordKey(held) === recordKey(record)));
		this.land(snapshot.revision, [...snapshot.shares]);
		const wasReady = this.ready;
		this.ready = true;
		if (removed.length || added.length || !wasReady)
			this.onChange?.({ reason: reasonOf([...removed, ...added]), removed });
	}

	/** Only the next revision applies; anything else is a gap. */
	apply(delta: ShareMirrorDelta): "applied" | "gap" {
		if (delta.revision !== this.held + 1) return "gap";
		const dropped = new Set(delta.del.map(recordKey));
		const put = new Map(delta.put.map((record) => [recordKey(record), record]));
		const removed = this.state.shares.filter((record) => dropped.has(recordKey(record)));
		const kept = this.state.shares.filter(
			(record) => !dropped.has(recordKey(record)) && !put.has(recordKey(record)),
		);
		this.land(delta.revision, [...kept, ...delta.put]);
		if (removed.length || delta.put.length)
			this.onChange?.({ reason: reasonOf([...removed, ...delta.put]), removed });
		return "applied";
	}

	/** An unlinked Domain is shared nothing, whatever the Router holds. */
	isSharedTo(sessionTarget: string, toDomainId: string, isLinked: (domainId: string) => boolean): boolean {
		return this.ready && isLinked(toDomainId) && isShareSharedTo(this.state, sessionTarget, toDomainId, isLinked);
	}

	sharesFor(toDomainId: string, isLinked: (domainId: string) => boolean): string[] {
		return this.ready && isLinked(toDomainId) ? sharesForRule(this.state, toDomainId, isLinked) : [];
	}

	all(): ShareRecord[] {
		return this.ready ? allShares(this.state) : [];
	}
}

/** One Domain when every record names it, else all. */
function reasonOf(records: ShareRecord[]): ShareChangeReason {
	const domains = new Set(records.map((record) => (record.target.kind === "domain" ? record.target.domainId : "*")));
	const [only] = [...domains];
	return domains.size === 1 && only !== "*" && only !== undefined
		? { kind: "domain", domainId: only }
		: { kind: "sweep" };
}
