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
});
export type RunRow = z.infer<typeof RunRowSchema>;

/** Standing rows log once per automation and action. */
export const logged = (log: readonly RunRow[], row: RunRow): RunRow[] => {
	const isLost = (held: RunRow) => held.reason !== undefined && LOST_RUNS.has(held.reason);
	const lost = isLost(row);
	const last = log.findLast(
		(held) => held.automation === row.automation && (lost || (held.action === row.action && !isLost(held))),
	);
	const stands = row.outcome === "refused" || lost;
	const standing = stands && last?.outcome === row.outcome && last.reason === row.reason;
	return standing ? [...log] : [...log, row].slice(-LOG_MAX);
};

export const fireRow = (
	fire: { automation: string; seq: number; at: number },
	outcome: RunRow["outcome"],
	reason?: string,
	action?: string,
): RunRow => ({
	automation: fire.automation,
	seq: fire.seq,
	at: fire.at,
	outcome,
	...(reason ? { reason } : {}),
	...(action ? { action } : {}),
});
