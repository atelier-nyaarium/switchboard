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
	label: string;
}

export type OwnerPutResult<T> =
	| { stored: true; record: OwnerRecord<T> }
	| { stored: false; reason: string; issue?: OwnerIssue; record?: OwnerRecord<T> };

export type OwnerRemoveResult = { removed: true } | { removed: false; reason: string };

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

	const read = (row: Row): OwnerRecord<T> | null => {
		const schema = deps.kinds[row.kind];
		const body = schema?.safeParse(row.body);
		return body?.success ? { ...row, body: body.data } : null;
	};

	const readable = (): OwnerRecord<T>[] => held.map(read).filter((record) => record !== null);

	const commit = (next: Row[], id: string): boolean =>
		commitChecked(
			deps.store,
			next,
			(landed) => {
				held = landed;
			},
			{ label: deps.label, onLanded: () => deps.onChanged?.(id) },
		).landed;

	const sameBody = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

	const get = (id: string): OwnerRecord<T> | null => {
		const row = held.find((candidate) => candidate.id === id);
		return row ? read(row) : null;
	};

	const issueOf = (record: OwnerRecord<T>): OwnerIssue | string | null =>
		deps.refusal?.(
			record,
			readable().filter((other) => other.id !== record.id),
		) ?? null;

	return {
		list: readable,

		get,

		/** Validity is read-time only. */
		invalidOf(id: string): string | null {
			const record = get(id);
			const issue = record ? issueOf(record) : null;
			return typeof issue === "string" || issue === null ? issue : issue.message;
		},

		unread: (): number => held.filter((row) => read(row) === null).length,

		/** Zero base creates. */
		/** Allows id revival. */
		put(
			kind: string,
			id: string,
			body: unknown,
			base: number,
			options: { revive?: boolean } = {},
		): OwnerPutResult<T> {
			// Avoid prototype-key semantics.
			if (!RULE_ID_RE.test(id) || id === "__proto__") return { stored: false, reason: "not a record id" };
			const schema = deps.kinds[kind];
			if (!schema) return { stored: false, reason: `unknown kind ${kind}` };
			const parsed = schema.safeParse(body);
			if (!parsed.success) {
				const first = parsed.error.issues[0];
				const issue: OwnerIssue = {
					path: (first?.path ?? []).filter((part): part is string | number => typeof part !== "symbol"),
					message: first?.message ?? "not valid",
					code: first?.code ?? "invalid_value",
				};
				return { stored: false, reason: issue.message, issue };
			}
			const row = held.find((candidate) => candidate.id === id);
			const current = row ? read(row) : null;
			if (row && !current) return { stored: false, reason: "held by a newer build; update this Gateway" };
			if (current) {
				// Lost replies allow retries.
				// Matching create retries echo.
				const echoes = base === current.revision || base === current.revision - 1 || base === 0;
				if (echoes && current.kind === kind && sameBody(current.body, parsed.data))
					return { stored: true, record: current };
				if (base !== current.revision) {
					return { stored: false, reason: `revision ${current.revision} is stored`, record: current };
				}
				if (current.revision >= REVISION_CEILING)
					return { stored: false, reason: "revision ceiling", record: current };
			} else {
				if (base !== 0) return { stored: false, reason: "not stored; it may have been removed" };
				if (buried.has(id) && !options.revive) return { stored: false, reason: "removed" };
				if (held.length >= deps.max) return { stored: false, reason: `this Gateway holds ${deps.max} already` };
			}
			const record: OwnerRecord<T> = {
				id,
				kind,
				// Revival preserves revisions.
				revision: (current?.revision ?? (options.revive ? (buried.get(id) ?? 0) : 0)) + 1,
				incarnation: current?.incarnation ?? deps.newIncarnation(),
				body: parsed.data,
			};
			const refused = issueOf(record);
			if (refused) {
				const issue = typeof refused === "string" ? {} : { issue: refused };
				const reason = typeof refused === "string" ? refused : refused.message;
				return { stored: false, reason, ...issue, ...(current ? { record: current } : {}) };
			}
			const next = row ? held.map((candidate) => (candidate.id === id ? record : candidate)) : [...held, record];
			return commit(next, id) ? { stored: true, record } : { stored: false, reason: "not saved; try again" };
		},

		remove(id: string, base: number): OwnerRemoveResult {
			const row = held.find((candidate) => candidate.id === id);
			if (!row) return buried.get(id) === base ? { removed: true } : { removed: false, reason: "not stored" };
			if (read(row) === null) return { removed: false, reason: "held by a newer build; update this Gateway" };
			if (row.revision !== base) return { removed: false, reason: `revision ${row.revision} is stored` };
			if (
				!commit(
					held.filter((candidate) => candidate.id !== id),
					id,
				)
			)
				return { removed: false, reason: "not saved; try again" };
			buried.set(id, base);
			while (buried.size > MAX_BURIED) buried.delete(buried.keys().next().value as string);
			return { removed: true };
		},
	};
}

export type OwnerRecords<T> = ReturnType<typeof createOwnerRecords<T>>;
