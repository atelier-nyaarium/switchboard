// What an automation's last run reached, as its row serves it.

import { z } from "zod";
import { byPath } from "../../shared/automation-walk.js";
import {
	AutomationLastRunSchema,
	type AutomationLastStep,
	LAST_STEP_REASON_MAX,
} from "../../shared/schemasAutomation.js";
import type { Fire } from "./automationFires.js";
import { endedOutcome, isEnded, type Step } from "./automationSteps.js";

/** What a run ran: its body but for `enabled`, and each frame's function as `id@incarnation:revision`. */
export const RunStampSchema = z.strictObject({ body: z.string(), functions: z.array(z.string()) });
export type RunStamp = z.infer<typeof RunStampSchema>;

/** The run, the fire it was read from, and what that ran. */
export const HeldLastRunSchema = z.strictObject({
	member: z.string(),
	incarnation: z.string(),
	/** Its fire's place as admitted. */
	order: z.number().int().nonnegative(),
	stamp: RunStampSchema,
	run: AutomationLastRunSchema,
});
export type HeldLastRun = z.infer<typeof HeldLastRunSchema>;
export type LastRuns = Record<string, HeldLastRun>;

export interface LastRunPorts {
	kindAt(fire: Fire, path: string): string;
	functionAt(fire: Fire, path: string): string | undefined;
	stampOf(fire: Fire): RunStamp;
	/** Its place as admitted. */
	orderOf(member: string): number;
}

/** Its turn came. */
const reached = (step: Step, path: string, fire: Fire): boolean =>
	isEnded(step) || step.startedAt !== undefined || step.attempts > 0 || fire.active.includes(path);

const stepOf = (fire: Fire, path: string, step: Step, ports: LastRunPorts): AutomationLastStep => {
	// No word: closed by an older build.
	const ended = !isEnded(step)
		? null
		: step.verdict === "ended" && step.word === undefined
			? { outcome: "uncertain" as const }
			: endedOutcome(step.word);
	const reason = ended ? (step.message ?? ended.reason) : undefined;
	const fn = ports.functionAt(fire, path);
	return {
		path,
		kind: ports.kindAt(fire, path).slice(0, 32),
		...(ended ? { outcome: ended.outcome } : {}),
		...(reason ? { reason: reason.slice(0, LAST_STEP_REASON_MAX) } : {}),
		...(step.side ? { side: step.side } : {}),
		...(fn ? { function: fn } : {}),
	};
};

/** Null before its first step's turn. */
export function lastRunOf(fire: Fire, running: boolean, ports: LastRunPorts): HeldLastRun | null {
	const steps = Object.entries(fire.steps)
		.filter(([path, step]) => reached(step, path, fire))
		.sort(([a], [b]) => byPath(a, b))
		.map(([path, step]) => stepOf(fire, path, step, ports));
	if (steps.length === 0) return null;
	const active = running ? fire.active[0] : undefined;
	return {
		member: fire.member,
		incarnation: fire.incarnation,
		order: ports.orderOf(fire.member),
		stamp: ports.stampOf(fire),
		run: { at: fire.at, revision: fire.revision, steps, ...(active ? { active } : {}), running },
	};
}

/** A later admission replaces an earlier one, never the reverse. */
export function recorded(held: LastRuns, fire: Fire, running: boolean, ports: LastRunPorts): LastRuns {
	const run = lastRunOf(fire, running, ports);
	if (!run) return held;
	const before = Object.hasOwn(held, fire.automation) ? held[fire.automation] : undefined;
	if (before && before.member !== fire.member && run.order <= before.order) return held;
	return { ...held, [fire.automation]: run };
}

/** A run no fire holds has ended. */
export const settledRuns = (held: LastRuns, live: ReadonlySet<string>): LastRuns =>
	Object.fromEntries(
		Object.entries(held).map(([id, last]) => {
			if (!last.run.running || live.has(last.member)) return [id, last];
			const { active: _active, ...run } = last.run;
			return [id, { ...last, run: { ...run, running: false } }];
		}),
	);
