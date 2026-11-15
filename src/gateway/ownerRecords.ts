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
	newIncarnation: () => string;
	/** Put/read validation. */
	refusal?: (candidate: OwnerRecord<T>, others: readonly OwnerRecord<T>[]) => OwnerIssue | string | null;
	/** After each landed write. */
	onChanged?: (id: string) => void;
	/** A body its schema rewrites is stored as read. */
	settle?: boolean;
	label: string;
}

export type OwnerPutResult<T> =
	| { stored: true; record: OwnerRecord<T> }
	| { stored: false; reason: string; issue?: OwnerIssue; record?: OwnerRecord<T> };

export type OwnerRemoveResult = { removed: true } | { removed: false; reason: string };

export type OwnerWrite =
	| { op: "put"; kind: string; id: string; body: unknown; base: number; revive?: boolean }
	| { op: "remove"; id: string; base: number };

/** `records` holds null for a remove. */
export type OwnerBatchResult<T> =
	| { stored: true; records: (OwnerRecord<T> | null)[] }
	| { stored: false; at: number; reason: string; issue?: OwnerIssue; record?: OwnerRecord<T> };

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

	type Planned =
		| { ok: true; record: OwnerRecord<T> | null }
		| { ok: false; reason: string; issue?: OwnerIssue; record?: OwnerRecord<T> };

	const draftOf = (): Draft => ({ rows: held, bury: new Map(), changed: new Set() });

	const buriedAt = (draft: Draft, id: string): number | undefined => draft.bury.get(id) ?? buried.get(id);

	/** Zero base creates. */
	const planPut = (draft: Draft, write: Extract<OwnerWrite, { op: "put" }>): Planned => {
		const { kind, id, body, base } = write;
		// Avoid prototype-key semantics.
		if (!RULE_ID_RE.test(id) || id === "__proto__") return { ok: false, reason: "not a record id" };
		const schema = deps.kinds[kind];
		if (!schema) return { ok: false, reason: `unknown kind ${kind}` };
		const parsed = schema.safeParse(body);
		if (!parsed.success) {
			const first = parsed.error.issues[0];
			const issue: OwnerIssue = {
				path: (first?.path ?? []).filter((part): part is string | number => typeof part !== "symbol"),
				message: first?.message ?? "not valid",
				code: first?.code ?? "invalid_value",
			};
			return { ok: false, reason: issue.message, issue };
		}
		const row = draft.rows.find((candidate) => candidate.id === id);
		const current = row ? read(row) : null;
		if (row && !current) return { ok: false, reason: "held by a newer build; update this Gateway" };
		if (current) {
			// Lost replies allow retries.
			// Matching create retries echo.
			const echoes = base === current.revision || base === current.revision - 1 || base === 0;
			if (echoes && current.kind === kind && sameBody(current.body, parsed.data))
				return { ok: true, record: current };
			if (base !== current.revision) {
				return { ok: false, reason: `revision ${current.revision} is stored`, record: current };
			}
			if (current.revision >= REVISION_CEILING) return { ok: false, reason: "revision ceiling", record: current };
		} else {
			if (base !== 0) return { ok: false, reason: "not stored; it may have been removed" };
			if (buriedAt(draft, id) !== undefined && !write.revive) return { ok: false, reason: "removed" };
			if (draft.rows.length >= deps.max) return { ok: false, reason: `this Gateway holds ${deps.max} already` };
		}
		const record: OwnerRecord<T> = {
			id,
			kind,
			// Revival preserves revisions.
			revision: (current?.revision ?? (write.revive ? (buriedAt(draft, id) ?? 0) : 0)) + 1,
			incarnation: current?.incarnation ?? deps.newIncarnation(),
			body: parsed.data,
		};
		const refused = issueOf(record, draft.rows);
		if (refused) {
			const issue = typeof refused === "string" ? {} : { issue: refused };
			const reason = typeof refused === "string" ? refused : refused.message;
			return { ok: false, reason, ...issue, ...(current ? { record: current } : {}) };
		}
		draft.rows = row
			? draft.rows.map((candidate) => (candidate.id === id ? record : candidate))
			: [...draft.rows, record];
		draft.changed.add(id);
		return { ok: true, record };
	};

	const planRemove = (draft: Draft, { id, base }: Extract<OwnerWrite, { op: "remove" }>): Planned => {
		const row = draft.rows.find((candidate) => candidate.id === id);
		if (!row)
			return buriedAt(draft, id) === base ? { ok: true, record: null } : { ok: false, reason: "not stored" };
		if (read(row) === null) return { ok: false, reason: "held by a newer build; update this Gateway" };
		if (row.revision !== base) return { ok: false, reason: `revision ${row.revision} is stored` };
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

		/** `revive` allows a removed id. */
		put(
			kind: string,
			id: string,
			body: unknown,
			base: number,
			options: { revive?: boolean } = {},
		): OwnerPutResult<T> {
			const draft = draftOf();
			const planned = planPut(draft, { op: "put", kind, id, body, base, ...options });
			if (!planned.ok) {
				const { ok: _ok, ...refusal } = planned;
				return { stored: false, ...refusal };
			}
			if (planned.record === null) return { stored: false, reason: NOT_SAVED };
			return land(draft) ? { stored: true, record: planned.record } : { stored: false, reason: NOT_SAVED };
		},

		remove(id: string, base: number): OwnerRemoveResult {
			const draft = draftOf();
			const planned = planRemove(draft, { op: "remove", id, base });
			if (!planned.ok) return { removed: false, reason: planned.reason };
			return land(draft) ? { removed: true } : { removed: false, reason: NOT_SAVED };
		},

		/** Every write lands, or none. */
		batch(writes: readonly OwnerWrite[]): OwnerBatchResult<T> {
			const draft = draftOf();
			const records: (OwnerRecord<T> | null)[] = [];
			for (const [at, write] of writes.entries()) {
				const planned = write.op === "put" ? planPut(draft, write) : planRemove(draft, write);
				if (!planned.ok) {
					const { ok: _ok, ...refusal } = planned;
					return { stored: false, at, ...refusal };
				}
				records.push(planned.record);
			}
			return land(draft) ? { stored: true, records } : { stored: false, at: 0, reason: NOT_SAVED };
		},
	};
}

export type OwnerRecords<T> = ReturnType<typeof createOwnerRecords<T>>;
