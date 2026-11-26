// The automations' run log.

import { z } from "zod";

export const LOG_MAX = 64;
export const REPLACED = "a newer run replaced it";
export const CROWDED = "dropped for room";
export const TOO_MANY = "too many runs are waiting";
export const BEHIND = "too many of its runs are waiting";
export const COOLING = "inside its cool-down";
/** Standing; logged again after an intervening run. */
const LOST_RUNS: ReadonlySet<string> = new Set([REPLACED, CROWDED, TOO_MANY, BEHIND, COOLING]);

export const ROW_OUTCOMES = ["ran", "refused", "uncertain", "suppressed"] as const;

export const RunRowSchema = z.strictObject({
	automation: z.string(),
	seq: z.number().int(),
	at: z.number().int(),
	outcome: z.enum(ROW_OUTCOMES),
	reason: z.string().optional(),
	/** The action kind, for an effect. */
	action: z.string().optional(),
	step: z.string().optional(),
	function: z.string().optional(),
});
export type RunRow = z.infer<typeof RunRowSchema>;
export type RowWhere = Pick<RunRow, "step" | "function">;

/** The largest holder loses its oldest. */
export const capped = (log: RunRow[]): RunRow[] => {
	const held = new Map<string, number>();
	for (const row of log) held.set(row.automation, (held.get(row.automation) ?? 0) + 1);
	const losing = new Map<string, number>();
	for (let over = log.length - LOG_MAX; over > 0; over--) {
		const [most, rows] = [...held].reduce((a, b) => (b[1] > a[1] ? b : a));
		held.set(most, rows - 1);
		losing.set(most, (losing.get(most) ?? 0) + 1);
	}
	return log.filter((row) => {
		const left = losing.get(row.automation) ?? 0;
		if (left > 0) losing.set(row.automation, left - 1);
		return left === 0;
	});
};

/** Standing rows log once per automation, action and step. */
export const logged = (log: readonly RunRow[], row: RunRow): RunRow[] => {
	const isLost = (held: RunRow) => held.reason !== undefined && LOST_RUNS.has(held.reason);
	const lost = isLost(row);
	const same = (held: RunRow) => held.action === row.action && held.step === row.step && !isLost(held);
	const last = log.findLast((held) => held.automation === row.automation && (lost || same(held)));
	const stands = row.outcome === "refused" || lost;
	const standing = stands && last?.outcome === row.outcome && last.reason === row.reason;
	return standing ? [...log] : capped([...log, row]);
};

export const fireRow = (
	fire: { automation: string; seq: number; at: number },
	outcome: RunRow["outcome"],
	reason?: string,
	action?: string,
	where: RowWhere = {},
): RunRow => ({
	automation: fire.automation,
	seq: fire.seq,
	at: fire.at,
	outcome,
	...(reason ? { reason } : {}),
	...(action ? { action } : {}),
	...(where.step ? { step: where.step } : {}),
	...(where.function ? { function: where.function } : {}),
});
