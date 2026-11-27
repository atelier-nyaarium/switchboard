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

/** Times stamped by the pass that saw it. */
interface Stamp {
	now: number;
	/** The run's latest stamp so far; a clock set back stamps nothing earlier. */
	floor: number;
	/** Its earlier record; none for a run held untimed. */
	before: AutomationLastStep | undefined;
	timed: boolean;
}

const stepOf = (fire: Fire, path: string, step: Step, ports: LastRunPorts, stamp: Stamp): AutomationLastStep => {
	// No word: closed by an older build.
	const ended = !isEnded(step)
		? null
		: step.verdict === "ended" && step.word === undefined
			? { outcome: "uncertain" as const }
			: endedOutcome(step.word);
	const reason = ended ? (step.message ?? ended.reason) : undefined;
	const fn = ports.functionAt(fire, path);
	const { before, now, timed, floor } = stamp;
	const since = (at: number) => Math.max(floor, at - fire.at);
	const startMs = timed ? (before ? before.startMs : since(step.startedAt ?? now)) : undefined;
	// A clock set back never ends a step before it began.
	const endMs = timed && ended ? (before?.endMs ?? Math.max(since(now), startMs ?? 0)) : undefined;
	const retrying = !ended && step.word !== undefined && step.word !== "done";
	const retriedMs = timed
		? (before?.retriedMs ?? (retrying ? Math.max(since(now), startMs ?? 0) : undefined))
		: undefined;
	return {
		path,
		kind: ports.kindAt(fire, path).slice(0, 32),
		...(ended ? { outcome: ended.outcome } : {}),
		...(reason ? { reason: reason.slice(0, LAST_STEP_REASON_MAX) } : {}),
		...(step.side ? { side: step.side } : {}),
		...(fn ? { function: fn } : {}),
		...(startMs !== undefined ? { startMs } : {}),
		...(endMs !== undefined ? { endMs } : {}),
		...(retrying ? { retrying } : {}),
		...(retriedMs !== undefined ? { retriedMs } : {}),
	};
};

/** Null before its first step's turn; `before` is this run's earlier record. */
export function lastRunOf(
	fire: Fire,
	running: boolean,
	ports: LastRunPorts,
	now: number,
	before?: HeldLastRun,
): HeldLastRun | null {
	const earlier = before?.member === fire.member ? before.run.steps : undefined;
	// Recorded untimed: stays so.
	const timed = earlier === undefined || earlier[0]?.startMs !== undefined;
	const floor = Math.max(
		0,
		...(earlier ?? []).flatMap((step) => [step.startMs ?? 0, step.endMs ?? 0, step.retriedMs ?? 0]),
	);
	const steps = Object.entries(fire.steps)
		.filter(([path, step]) => reached(step, path, fire))
		.sort(([a], [b]) => byPath(a, b))
		.map(([path, step]) =>
			stepOf(fire, path, step, ports, { now, floor, timed, before: earlier?.find((held) => held.path === path) }),
		);
	if (steps.length === 0) return null;
	const active = running ? fire.active[0] : undefined;
	const beside = running && fire.active.length > 1 ? { beside: fire.active } : {};
	return {
		member: fire.member,
		incarnation: fire.incarnation,
		order: ports.orderOf(fire.member),
		stamp: ports.stampOf(fire),
		run: { at: fire.at, revision: fire.revision, steps, ...(active ? { active } : {}), ...beside, running },
	};
}

/** A later admission replaces an earlier one, never the reverse. */
export function recorded(held: LastRuns, fire: Fire, running: boolean, ports: LastRunPorts, now: number): LastRuns {
	const before = Object.hasOwn(held, fire.automation) ? held[fire.automation] : undefined;
	const run = lastRunOf(fire, running, ports, now, before);
	if (!run) return held;
	if (before && before.member !== fire.member && run.order <= before.order) return held;
	return { ...held, [fire.automation]: run };
}

/** A run no fire holds has ended. */
export const settledRuns = (held: LastRuns, live: ReadonlySet<string>): LastRuns =>
	Object.fromEntries(
		Object.entries(held).map(([id, last]) => {
			if (!last.run.running || live.has(last.member)) return [id, last];
			const { active: _active, beside: _beside, ...run } = last.run;
			return [id, { ...last, run: { ...run, running: false } }];
		}),
	);
