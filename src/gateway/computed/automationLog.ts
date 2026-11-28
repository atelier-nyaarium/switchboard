// The automations' log: what ended, and what stands.

import { z } from "zod";
import { STEP_PATH_RE } from "../../shared/automation-walk.js";
import { RUN_OUTCOMES } from "../../shared/schemasAutomation.js";

export const LOG_MAX = 64;
export const REPLACED = "a newer run replaced it";
export const CROWDED = "dropped for room";
export const TOO_MANY = "too many runs are waiting";
export const BEHIND = "too many of its runs are waiting";
export const COOLING = "inside its cool-down";

export const ROW_OUTCOMES = RUN_OUTCOMES;
type Outcome = (typeof ROW_OUTCOMES)[number];

/** A run that never ran, and how it logs. */
const LOST: Readonly<Record<string, Outcome>> = {
	[REPLACED]: "skipped",
	[CROWDED]: "skipped",
	[TOO_MANY]: "failed",
	[BEHIND]: "skipped",
	[COOLING]: "skipped",
};
export type LostReason = typeof REPLACED | typeof CROWDED | typeof TOO_MANY | typeof BEHIND | typeof COOLING;

export const LOG_KINDS = ["step", "tell", "lost", "trigger"] as const;

export const LogRowSchema = z
	.strictObject({
		/** `step`: a step ended. `tell`: told for a whole run, or dropped for room. `lost`: never ran. `trigger`: the run or its trigger. */
		kind: z.enum(LOG_KINDS),
		automation: z.string(),
		seq: z.number().int(),
		at: z.number().int(),
		outcome: z.enum(ROW_OUTCOMES),
		reason: z.string().optional(),
		/** Its action or statement kind. */
		action: z.string().optional(),
		step: z.string().regex(STEP_PATH_RE).optional(),
		function: z.string().optional(),
	})
	.refine((row) => row.kind !== "step" || (row.step !== undefined && row.action !== undefined), {
		message: "a step row names its step",
	})
	.refine((row) => row.kind !== "lost" || (row.reason !== undefined && Object.hasOwn(LOST, row.reason)), {
		message: "a lost row says why",
	});
export type LogRow = z.infer<typeof LogRowSchema>;

type Fired = { automation: string; seq: number; at: number };
const head = ({ automation, seq, at }: Fired) => ({ automation, seq, at });

export const stepRow = (
	fire: Fired,
	at: { step: string; action: string; function?: string | undefined },
	outcome: Outcome,
	reason: string | undefined,
): LogRow => ({
	kind: "step",
	...head(fire),
	outcome,
	...(reason ? { reason } : {}),
	action: at.action,
	step: at.step,
	...(at.function ? { function: at.function } : {}),
});

export const lostRow = (fire: Fired, reason: LostReason): LogRow => ({
	kind: "lost",
	...head(fire),
	outcome: LOST[reason] as Outcome,
	reason,
});

export const triggerRow = (fire: Fired, outcome: Outcome, reason: string): LogRow => ({
	kind: "trigger",
	...head(fire),
	outcome,
	reason,
});

const TELL = "tell_assistant";

export const tellRow = (fire: Fired, outcome: Outcome, reason: string | undefined): LogRow => ({
	kind: "tell",
	...head(fire),
	outcome,
	...(reason ? { reason } : {}),
	action: TELL,
});

/** Within its automation. */
const KEYS: Readonly<Record<LogRow["kind"], (row: LogRow) => string>> = {
	step: (row) => `step:${row.function ?? ""}:${row.step ?? ""}:${row.action ?? ""}`,
	tell: () => "tell",
	lost: () => "lost",
	trigger: () => "trigger",
};

/** A failure stands, and so does every lost run. */
const stands = (row: LogRow): boolean => row.kind === "lost" || row.outcome === "failed";

export interface Log {
	rows: readonly LogRow[];
	/** By automation, then row key: the reason standing there. */
	standing: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
export const EMPTY_LOG: Log = { rows: [], standing: {} };

/** What stands once a row lands. */
export function standingAfter(standing: Log["standing"], row: LogRow): Log["standing"] {
	const held = { ...(Object.hasOwn(standing, row.automation) ? standing[row.automation] : {}) };
	// Any other row re-arms a lost run.
	if (row.kind !== "lost") delete held[KEYS.lost(row)];
	const key = KEYS[row.kind](row);
	if (stands(row)) held[key] = row.reason ?? "";
	else delete held[key];
	const { [row.automation]: _gone, ...rest } = standing;
	return Object.keys(held).length === 0 ? rest : { ...rest, [row.automation]: held };
}

const standsAlready = (log: Log, row: LogRow): boolean =>
	stands(row) &&
	Object.hasOwn(log.standing, row.automation) &&
	log.standing[row.automation]?.[KEYS[row.kind](row)] === (row.reason ?? "");

/** The largest holder loses its oldest. */
export const capped = (rows: readonly LogRow[]): LogRow[] => {
	const held = new Map<string, number>();
	for (const row of rows) held.set(row.automation, (held.get(row.automation) ?? 0) + 1);
	const losing = new Map<string, number>();
	for (let over = rows.length - LOG_MAX; over > 0; over--) {
		const [most, count] = [...held].reduce((a, b) => (b[1] > a[1] ? b : a));
		held.set(most, count - 1);
		losing.set(most, (losing.get(most) ?? 0) + 1);
	}
	return rows.filter((row) => {
		const left = losing.get(row.automation) ?? 0;
		if (left > 0) losing.set(row.automation, left - 1);
		return left === 0;
	});
};

/** A standing row logs once, until another row of its key, or for a lost run any row of its automation, lands. */
export const logged = (log: Log, row: LogRow): Log =>
	standsAlready(log, row) ? log : { rows: capped([...log.rows, row]), standing: standingAfter(log.standing, row) };

/** Only what the held automations own. */
export const loggedFor = (log: Log, live: ReadonlySet<string>): Log => {
	const rows = log.rows.filter((row) => live.has(row.automation));
	const standing = Object.fromEntries(Object.entries(log.standing).filter(([id]) => live.has(id)));
	return rows.length === log.rows.length && Object.keys(standing).length === Object.keys(log.standing).length
		? log
		: { rows, standing };
};

/** A row as stored: its kind is read back from its fields, so 8.14.87 reads it too. */
const StoredRowSchema = z.strictObject({
	automation: z.string(),
	seq: z.number().int(),
	at: z.number().int(),
	outcome: z.enum(ROW_OUTCOMES),
	reason: z.string().optional(),
	action: z.string().optional(),
	step: z.string().regex(STEP_PATH_RE).optional(),
	function: z.string().optional(),
});
type StoredRow = z.infer<typeof StoredRowSchema>;

/** The kind its builder gave it. */
const kindOf = (row: StoredRow): LogRow["kind"] =>
	row.step !== undefined && row.action !== undefined
		? "step"
		: row.reason !== undefined && Object.hasOwn(LOST, row.reason)
			? "lost"
			: row.action === TELL
				? "tell"
				: "trigger";

export const storedRows = (log: Log): StoredRow[] => log.rows.map(({ kind: _kind, ...row }) => row);

/** Each row and each standing reason read alone; standing absent is read back from the rows. */
export function readLog(rows: unknown, standing: unknown): Log {
	const read = (Array.isArray(rows) ? rows : []).flatMap((row): LogRow[] => {
		const parsed = StoredRowSchema.safeParse(row);
		return parsed.success ? [{ kind: kindOf(parsed.data), ...parsed.data }] : [];
	});
	const within = capped(read);
	if (typeof standing !== "object" || standing === null || Array.isArray(standing))
		return { rows: within, standing: within.reduce(standingAfter, {}) };
	// Each reason alone; an automation with none read back from its rows.
	const fromRows: Log["standing"] = within.reduce(standingAfter, {});
	const held = Object.fromEntries(
		Object.entries(standing).flatMap(([id, keys]) => {
			if (typeof keys !== "object" || keys === null) return [];
			const reasons = Object.entries(keys).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			);
			const each = reasons.length > 0 ? Object.fromEntries(reasons) : fromRows[id];
			return each ? [[id, each]] : [];
		}),
	);
	return { rows: within, standing: held };
}
