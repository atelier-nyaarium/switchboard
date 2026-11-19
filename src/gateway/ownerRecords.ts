// Phone IDs; Gateway revisions.
// Writes preserve unread rows.

import { z } from "zod";
import { canonicalJson } from "../shared/canonical-json.js";
import { commitChecked, type DurableStore } from "../shared/durable-store.js";
import { RULE_ID_RE } from "../shared/schemasAssistantRules.js";
import { REVISION_CEILING } from "../shared/schemasRunbook.js";

export interface OwnerRecord<T> {
	id: string;
	revision: number;
	/** Stable until recreation. */
	incarnation: string;
	kind: string;
	body: T;
}

export interface OwnerIssue {
	path: (string | number)[];
	message: string;
	code: string;
}

export interface OwnerRecordsDeps<T> {
	store: DurableStore;
	/** Invalid bodies remain unread. */
	kinds: Readonly<Record<string, z.ZodType<T>>>;
	max: number;
	maxByKind?: Readonly<Record<string, number>>;
	newIncarnation: () => string;
	/** Put/read validation. */
	refusal?: (candidate: OwnerRecord<T>, others: readonly OwnerRecord<T>[]) => OwnerIssue | string | null;
	/** After each landed write. */
	onChanged?: (id: string) => void;
	/** A body its schema rewrites is stored as read. */
	settle?: boolean;
	label: string;
}

/** Why a write was refused; `cap` names "total" or a kind. */
export type OwnerCause =
	| "bad_id"
	| "invalid"
	| "newer_build"
	| "moved"
	| "spent"
	| "absent"
	| "removed"
	| "unsaved"
	| { cap: string; max: number };

type OwnerRefusal<T> = { reason: string; cause: OwnerCause; issue?: OwnerIssue; record?: OwnerRecord<T> };

export type OwnerPutResult<T> = { stored: true; record: OwnerRecord<T> } | ({ stored: false } & OwnerRefusal<T>);

export type OwnerRemoveResult = { removed: true } | { removed: false; reason: string };

export type OwnerWrite =
	/** `unfit` lands a body `refusal` turns down; its validity is then read. */
	| { op: "put"; kind: string; id: string; body: unknown; base: number; revive?: boolean; unfit?: boolean }
	| { op: "remove"; id: string; base: number };

/** `records` holds null for a remove. */
export type OwnerBatchResult<T> =
	| { stored: true; records: (OwnerRecord<T> | null)[] }
	| ({ stored: false; at: number } & OwnerRefusal<T>);

/** Total cap. */
export const TOTAL_CAP = "total";

const EnvelopeSchema = z.strictObject({
	id: z.string().regex(RULE_ID_RE),
	revision: z.number().int().positive().max(REVISION_CEILING),
	incarnation: z.string().min(1).max(64),
	kind: z.string().min(1).max(64),
	body: z.unknown(),
});

type Row = z.infer<typeof EnvelopeSchema>;

const MAX_BURIED = 256;

export function createOwnerRecords<T>(deps: OwnerRecordsDeps<T>) {
	const rows = z.array(EnvelopeSchema).parse(deps.store.load() ?? []);
	if (new Set(rows.map((row) => row.id)).size !== rows.length)
		throw new Error(`${deps.label}: an id is stored twice`);
	let held: Row[] = rows;
	/** Memory-only deleted-ID retries. */
	const buried = new Map<string, number>();

	if (deps.settle) {
		const settled = rows.map((row) => {
			const body = deps.kinds[row.kind]?.safeParse(row.body);
			return body?.success && canonicalJson(body.data) !== canonicalJson(row.body)
				? { ...row, body: body.data }
				: row;
		});
		if (settled.some((row, at) => row !== rows[at])) {
			held = settled;
			deps.store.save(settled);
		}
	}

	const read = (row: Row): OwnerRecord<T> | null => {
		const schema = deps.kinds[row.kind];
		const body = schema?.safeParse(row.body);
		return body?.success ? { ...row, body: body.data } : null;
	};

	const readableOf = (rows: readonly Row[]): OwnerRecord<T>[] => rows.map(read).filter((record) => record !== null);

	const readable = (): OwnerRecord<T>[] => readableOf(held);

	const sameBody = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

	const get = (id: string): OwnerRecord<T> | null => {
		const row = held.find((candidate) => candidate.id === id);
		return row ? read(row) : null;
	};

	const issueOf = (record: OwnerRecord<T>, rows: readonly Row[] = held): OwnerIssue | string | null =>
		deps.refusal?.(
			record,
			readableOf(rows).filter((other) => other.id !== record.id),
		) ?? null;

	/** Writes not yet landed. */
	interface Draft {
		rows: Row[];
		bury: Map<string, number>;
		changed: Set<string>;
	}

	type Planned = { ok: true; record: OwnerRecord<T> | null; created?: true } | ({ ok: false } & OwnerRefusal<T>);

	const draftOf = (): Draft => ({ rows: held, bury: new Map(), changed: new Set() });

	const buriedAt = (draft: Draft, id: string): number | undefined => draft.bury.get(id) ?? buried.get(id);

	/** Zero base creates. */
	const planPut = (draft: Draft, write: Extract<OwnerWrite, { op: "put" }>): Planned => {
		const { kind, id, body, base } = write;
		// Avoid prototype-key semantics.
		if (!RULE_ID_RE.test(id) || id === "__proto__")
			return { ok: false, reason: "not a record id", cause: "bad_id" };
		const schema = deps.kinds[kind];
		if (!schema) return { ok: false, reason: `unknown kind ${kind}`, cause: "invalid" };
		const parsed = schema.safeParse(body);
		if (!parsed.success) {
			const first = parsed.error.issues[0];
			const issue: OwnerIssue = {
				path: (first?.path ?? []).filter((part): part is string | number => typeof part !== "symbol"),
				message: first?.message ?? "not valid",
				code: first?.code ?? "invalid_value",
			};
			return { ok: false, reason: issue.message, cause: "invalid", issue };
		}
		const row = draft.rows.find((candidate) => candidate.id === id);
		const current = row ? read(row) : null;
		if (row && !current)
			return { ok: false, reason: "held by a newer build; update this Gateway", cause: "newer_build" };
		if (current) {
			// Lost replies allow retries.
			// Matching create retries echo.
			const echoes = base === current.revision || base === current.revision - 1 || base === 0;
			if (echoes && current.kind === kind && sameBody(current.body, parsed.data))
				return { ok: true, record: current };
			if (base !== current.revision) {
				return { ok: false, reason: `revision ${current.revision} is stored`, cause: "moved", record: current };
			}
			if (current.revision >= REVISION_CEILING)
				return { ok: false, reason: "revision ceiling", cause: "spent", record: current };
		} else {
			if (base !== 0) return { ok: false, reason: "not stored; it may have been removed", cause: "absent" };
			if (buriedAt(draft, id) !== undefined && !write.revive)
				return { ok: false, reason: "removed", cause: "removed" };
		}
		const record: OwnerRecord<T> = {
			id,
			kind,
			// Revival preserves revisions.
			revision: (current?.revision ?? (write.revive ? (buriedAt(draft, id) ?? 0) : 0)) + 1,
			incarnation: current?.incarnation ?? deps.newIncarnation(),
			body: parsed.data,
		};
		const refused = write.unfit ? null : issueOf(record, draft.rows);
		if (refused) {
			const issue = typeof refused === "string" ? {} : { issue: refused };
			const reason = typeof refused === "string" ? refused : refused.message;
			return { ok: false, reason, cause: "invalid", ...issue, ...(current ? { record: current } : {}) };
		}
		draft.rows = row
			? draft.rows.map((candidate) => (candidate.id === id ? record : candidate))
			: [...draft.rows, record];
		draft.changed.add(id);
		return row ? { ok: true, record } : { ok: true, record, created: true };
	};

	const planRemove = (draft: Draft, { id, base }: Extract<OwnerWrite, { op: "remove" }>): Planned => {
		const row = draft.rows.find((candidate) => candidate.id === id);
		if (!row)
			return buriedAt(draft, id) === base
				? { ok: true, record: null }
				: { ok: false, reason: "not stored", cause: "absent" };
		if (read(row) === null)
			return { ok: false, reason: "held by a newer build; update this Gateway", cause: "newer_build" };
		if (row.revision !== base) return { ok: false, reason: `revision ${row.revision} is stored`, cause: "moved" };
		draft.rows = draft.rows.filter((candidate) => candidate.id !== id);
		draft.bury.set(id, base);
		draft.changed.add(id);
		return { ok: true, record: null };
	};

	/** One write, or none. */
	const land = (draft: Draft): boolean => {
		if (draft.changed.size === 0) return true;
		const landed = commitChecked(
			deps.store,
			draft.rows,
			(next) => {
				held = next;
			},
			{
				label: deps.label,
				onLanded: () => {
					for (const id of draft.changed) deps.onChanged?.(id);
				},
			},
		).landed;
		if (!landed) return false;
		for (const [id, base] of draft.bury) {
			buried.delete(id);
			buried.set(id, base);
		}
		while (buried.size > MAX_BURIED) buried.delete(buried.keys().next().value as string);
		return true;
	};

	const NOT_SAVED = "not saved; try again";

	const plan = (
		writes: readonly OwnerWrite[],
	):
		| { stored: true; draft: Draft; records: (OwnerRecord<T> | null)[] }
		| Extract<OwnerBatchResult<T>, { stored: false }> => {
		const draft = draftOf();
		const records: (OwnerRecord<T> | null)[] = [];
		const created: { at: number; kind: string }[] = [];
		for (const [at, write] of writes.entries()) {
			const planned = write.op === "put" ? planPut(draft, write) : planRemove(draft, write);
			if (!planned.ok) {
				const { ok: _ok, ...refusal } = planned;
				return { stored: false, at, ...refusal };
			}
			if (planned.created && write.op === "put") created.push({ at, kind: write.kind });
			records.push(planned.record);
		}
		const full = capOf(draft.rows);
		if (full) {
			const at = created.find((row) => full.cap === TOTAL_CAP || row.kind === full.cap)?.at ?? 0;
			const reason =
				full.cap === TOTAL_CAP
					? `this Gateway holds ${full.max} already`
					: `this Gateway holds ${full.max} of these already`;
			return { stored: false, at, reason, cause: full };
		}
		return { stored: true, draft, records };
	};

	/** Only a batch that grows past a cap; a kind's first. */
	const capOf = (after: readonly Row[]): { cap: string; max: number } | null => {
		const count = (rows: readonly Row[], kind: string) => rows.filter((row) => row.kind === kind).length;
		for (const [kind, max] of Object.entries(deps.maxByKind ?? {})) {
			const now = count(after, kind);
			if (now > max && now > count(held, kind)) return { cap: kind, max };
		}
		return after.length > deps.max && after.length > held.length ? { cap: TOTAL_CAP, max: deps.max } : null;
	};

	return {
		list: readable,

		get,

		/** Unread rows included. */
		count: (): number => held.length,

		/** Validity is read-time only. */
		invalidOf(id: string): string | null {
			const record = get(id);
			const issue = record ? issueOf(record) : null;
			return typeof issue === "string" || issue === null ? issue : issue.message;
		},

		unread: (): number => held.filter((row) => read(row) === null).length,

		unreadOf: (id: string, kind: string): boolean =>
			held.some((row) => row.id === id && row.kind === kind && read(row) === null),

		/** Rows of a kind this build cannot read. */
		unreadCount: (kind: string): number => held.filter((row) => row.kind === kind && read(row) === null).length,

		/** `revive` allows a removed id. */
		put(
			kind: string,
			id: string,
			body: unknown,
			base: number,
			options: { revive?: boolean } = {},
		): OwnerPutResult<T> {
			const planned = plan([{ op: "put", kind, id, body, base, ...options }]);
			if (!planned.stored) {
				const { stored: _stored, at: _at, ...refusal } = planned;
				return { stored: false, ...refusal };
			}
			const [record] = planned.records;
			if (!record) return { stored: false, reason: NOT_SAVED, cause: "unsaved" };
			return land(planned.draft)
				? { stored: true, record }
				: { stored: false, reason: NOT_SAVED, cause: "unsaved" };
		},

		remove(id: string, base: number): OwnerRemoveResult {
			const draft = draftOf();
			const planned = planRemove(draft, { op: "remove", id, base });
			if (!planned.ok) return { removed: false, reason: planned.reason };
			return land(draft) ? { removed: true } : { removed: false, reason: NOT_SAVED };
		},

		/** Every write lands, or none. */
		batch(writes: readonly OwnerWrite[]): OwnerBatchResult<T> {
			const planned = plan(writes);
			if (!planned.stored) return planned;
			return land(planned.draft)
				? { stored: true, records: planned.records }
				: { stored: false, at: 0, reason: NOT_SAVED, cause: "unsaved" };
		},

		/** What `batch` would refuse; writes nothing. */
		refusalOf(writes: readonly OwnerWrite[]): Extract<OwnerBatchResult<T>, { stored: false }> | null {
			const planned = plan(writes);
			return planned.stored ? null : planned;
		},
	};
}

export type OwnerRecords<T> = ReturnType<typeof createOwnerRecords<T>>;
