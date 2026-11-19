// The automations' run log.

import { z } from "zod";

export const LOG_MAX = 64;
export const REPLACED = "a newer run replaced it";
export const CROWDED = "dropped for room";
export const TOO_MANY = "too many runs are waiting";
export const BEHIND = "too many of its runs are waiting";
/** Standing; logged again after an intervening run. */
const LOST_RUNS: ReadonlySet<string> = new Set([REPLACED, CROWDED, TOO_MANY, BEHIND]);

export const RUN_OUTCOMES = ["ran", "refused", "uncertain", "suppressed"] as const;

export const RunSchema = z.strictObject({
	automation: z.string(),
	seq: z.number().int(),
	at: z.number().int(),
	outcome: z.enum(RUN_OUTCOMES),
	reason: z.string().optional(),
	/** The action kind, for an effect. */
	action: z.string().optional(),
});
export type AutomationRun = z.infer<typeof RunSchema>;

/** Standing rows log once per automation and action. */
export const logged = (log: readonly AutomationRun[], run: AutomationRun): AutomationRun[] => {
	const isLost = (held: AutomationRun) => held.reason !== undefined && LOST_RUNS.has(held.reason);
	const lost = isLost(run);
	const last = log.findLast(
		(held) => held.automation === run.automation && (lost || (held.action === run.action && !isLost(held))),
	);
	const stands = run.outcome === "refused" || lost;
	const standing = stands && last?.outcome === run.outcome && last.reason === run.reason;
	return standing ? [...log] : [...log, run].slice(-LOG_MAX);
};

export const fireRun = (
	fire: { automation: string; seq: number; at: number },
	outcome: AutomationRun["outcome"],
	reason?: string,
	action?: string,
): AutomationRun => ({
	automation: fire.automation,
	seq: fire.seq,
	at: fire.at,
	outcome,
	...(reason ? { reason } : {}),
	...(action ? { action } : {}),
});
