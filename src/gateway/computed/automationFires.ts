// A fired trigger's step progress.

import { z } from "zod";
import { byPath, reached, siteAmong } from "../../shared/automation-walk.js";
import {
	AUTOMATION_ACTIONS_MAX,
	type Automation,
	AutomationActionSchema,
	TELL_WHEN,
} from "../../shared/schemasAutomation.js";
import { FUNCTION_STEPS_MAX } from "../../shared/schemasFunction.js";
import { FAILURE_CODES, FAILURE_MESSAGE_MAX } from "./automationFrames.js";
import { BEHIND, CROWDED, REPLACED, TOO_MANY } from "./automationLog.js";
import { type AutomationEffect, natureOf } from "./automationRunner.js";
import { claimed, FRESH_STEP, isEnded, type Nature, type Step, StepPathSchema, StepSchema } from "./automationSteps.js";

/** Runs waiting on their steps. */
export const FIRES_MAX = 64;
/** Event fires of one automation not yet started. */
export const WAITING_EVENTS_MAX = 8;
/** An automation's own list, then its function's first one. */
const LANE_TELLS_MAX = AUTOMATION_ACTIONS_MAX + FUNCTION_STEPS_MAX;

const NamesSchema = z.record(z.string(), z.object({ value: z.unknown(), shown: z.string().optional() }));

const TellSchema = z.strictObject({
	when: z.enum(TELL_WHEN),
	fields: z.record(z.string(), z.string()),
	/** Its messages' holes are unread. */
	fill: z.literal(true).optional(),
});

const FireBase = {
	member: z.string(),
	automation: z.string(),
	incarnation: z.string(),
	/** Version key; an edit retires the fire. */
	revision: z.number().int().positive(),
	/** The transition it answers; zero for a slot or an event. */
	seq: z.number().int().nonnegative(),
	at: z.number().int(),
	/** What the trigger read, for its texts' holes. */
	names: NamesSchema.optional(),
	// Remove 2026-12-16: one tell for the whole fire, as 8.14.87 stored it.
	tell: TellSchema.optional(),
	// Remove 2026-12-16 with `tell`.
	waiting: z.literal(true).optional(),
};

export const FailureSchema = z.strictObject({
	code: z.enum(FAILURE_CODES),
	message: z.string().max(FAILURE_MESSAGE_MAX),
});

/** Variables a run keeps. */
export const FRAME_VARS_MAX = 16;
/** One variable's JSON. */
export const FRAME_VAR_BYTES_MAX = 1_024;

export const FrameSchema = z.strictObject({
	function: z.string(),
	incarnation: z.string(),
	revision: z.number().int().positive(),
	/** Pinned at start. */
	resolved: z.record(StepPathSchema, AutomationActionSchema).optional(),
	/** The first failure nothing caught. */
	failed: FailureSchema.optional(),
	/** By its try's path: what `e` reads in that catch. */
	caught: z.record(StepPathSchema, FailureSchema).optional(),
	/** By name. */
	vars: z.record(z.string(), z.json()).optional(),
});
export type Frame = z.infer<typeof FrameSchema>;

export const frameKey = (frame: Pick<Frame, "function" | "incarnation" | "revision">): string =>
	`${frame.function}:${frame.incarnation}:${frame.revision}`;

/** A fired trigger awaiting its run. */
export const FireSchema = z
	.strictObject({
		...FireBase,
		/** By step path. */
		steps: z.record(StepPathSchema, StepSchema),
		/** The step whose turn it is; set by `advance` alone. */
		active: z.array(StepPathSchema).max(1),
		/** By call path. */
		frames: z.record(StepPathSchema, FrameSchema).optional(),
		/** Tell fields. */
		fields: z.record(z.string(), z.string()).optional(),
		/** Its own tells, as read at their turn. */
		resolved: z.record(StepPathSchema, AutomationActionSchema).optional(),
		/** Every step is its own tell. */
		light: z.literal(true).optional(),
		/** The tells the lane told, by path. */
		lane: z.array(StepPathSchema).max(LANE_TELLS_MAX).optional(),
	})
	.refine((fire) => fire.active.every((path) => Object.hasOwn(fire.steps, path)));
export type Fire = z.infer<typeof FireSchema>;
export type FireNames = NonNullable<Fire["names"]>;

// Remove 2026-12-16: a fire stored by 8.14.84.
const LegacyFireSchema = z.strictObject({
	...FireBase,
	effects: z.record(StepPathSchema, z.enum(["pending", "claimed", "done"])),
});

const LEGACY_STEPS: Readonly<Record<"pending" | "claimed" | "done", (at: number) => Step>> = {
	pending: () => FRESH_STEP,
	claimed: (at) => ({ attempts: 1, startedAt: at, lastAt: at, claimed: true }),
	done: () => ({ attempts: 0, verdict: "ended" }),
};

/** This shape, or the one before it; null otherwise. */
export function readFire(row: unknown): Fire | null {
	const parsed = FireSchema.safeParse(row);
	if (parsed.success) return parsed.data;
	const legacy = LegacyFireSchema.safeParse(row);
	if (!legacy.success) return null;
	const { effects, ...rest } = legacy.data;
	const steps = Object.fromEntries(
		Object.entries(effects).map(([path, held]) => [path, LEGACY_STEPS[held](rest.at)]),
	);
	const fire: Fire = { ...rest, steps, active: [] };
	// An all-pending fire never began.
	const begun = Object.values(effects).some((held) => held !== "pending");
	const turn = Object.entries(effects).find(([, held]) => held === "claimed")?.[0] ?? turnOf(fire);
	return { ...fire, active: begun && turn !== null ? [turn] : [] };
}

export interface StepRef {
	member: string;
	path: string;
}

export const stepKey = (ref: StepRef): string => `${ref.member}#${ref.path}`;

/** The call a step runs under; null for the automation's own step. */
export const siteIn = (fire: Pick<Fire, "frames">, path: string): string | null =>
	siteAmong(path, Object.keys(fire.frames ?? {}));

/** A step whose attempt may go, and when it fell due. */
export interface Runnable {
	ref: StepRef;
	dueAt: number;
}

/** Step paths in the order written. */
export const pathsOf = (fire: Fire): string[] => Object.keys(fire.steps).sort(byPath);

/** Every action it lists. */
export const stepsOf = (automation: Pick<Automation, "actions">): Fire["steps"] =>
	Object.fromEntries(reached(automation).map((at) => [at.path, FRESH_STEP]));

/** The first step not ended. */
export const turnOf = (fire: Fire): string | null =>
	pathsOf(fire).find((path) => !isEnded(fire.steps[path] as Step)) ?? null;

export const withStep = (fire: Fire, path: string, step: Step): Fire => ({
	...fire,
	steps: { ...fire.steps, [path]: step },
});

export const claimedPaths = (fire: Fire): string[] => pathsOf(fire).filter((path) => fire.steps[path]?.claimed);

/** A call's record stays open while its function runs. */
const hasOpenSteps = (fire: Fire): boolean => Object.values(fire.steps).some((step) => !isEnded(step));

export const finished = (fire: Fire): boolean => !fire.tell && !hasOpenSteps(fire);

export const holdsClaim = (fire: Fire): boolean => claimedPaths(fire).length > 0;

/** A step's turn came. */
export const started = (fire: Fire): boolean => fire.active.length > 0;

/** Started with steps left; never evicted. */
export const live = (fire: Fire): boolean => started(fire) && hasOpenSteps(fire);

/** Steps left, no turn begun. */
export const unstarted = (fire: Fire): boolean => hasOpenSteps(fire) && !started(fire);

/** Its automation's oldest fire with steps left, and every light one. */
export function mayRun(fires: readonly Fire[]): Set<string> {
	const seen = new Set<string>();
	const runs = new Set<string>();
	for (const fire of fires) {
		if (!hasOpenSteps(fire)) continue;
		if (fire.light) {
			runs.add(fire.member);
			continue;
		}
		if (seen.has(fire.automation)) continue;
		seen.add(fire.automation);
		runs.add(fire.member);
	}
	return runs;
}

/** Due longest ago; fire order breaks a tie. */
export const nextEffect = (runnable: readonly Runnable[]): StepRef | null =>
	runnable.reduce<Runnable | null>((best, next) => (best === null || next.dueAt < best.dueAt ? next : best), null)
		?.ref ?? null;

/** Fire time, or its last wait's end. */
export const intentAt = (fire: Pick<Fire, "at" | "steps">): number =>
	Object.values(fire.steps).reduce(
		(latest, step) => (isEnded(step) && step.until !== undefined ? Math.max(latest, step.until) : latest),
		fire.at,
	);

/** One admission, never its successor. */
export const sameRun = (a: Fire, b: Fire): boolean =>
	a.member === b.member &&
	a.incarnation === b.incarnation &&
	a.revision === b.revision &&
	a.seq === b.seq &&
	a.at === b.at;

/** A landed switch step, dated by `intentAt`. */
export interface LandedSet {
	member: string;
	device: string;
	nature: Nature;
	at: number;
}

/** The switch an effect acts on, and how. */
export const switchOf = (effect: AutomationEffect | null): { device: string; nature: Nature } | null =>
	effect?.kind === "device_set" ? { device: effect.device, nature: natureOf(effect) } : null;

/** Open, unclaimed steps on the same switch in older fires; a toggle never outdates a toggle. */
export function outdatedSets(
	fires: readonly Fire[],
	landed: readonly LandedSet[],
	stepAt: (fire: Fire, path: string) => AutomationEffect | null,
): { member: string; path: string }[] {
	return fires.flatMap((fire) =>
		pathsOf(fire).flatMap((path) => {
			const step = fire.steps[path] as Step;
			if (isEnded(step) || step.claimed) return [];
			const target = switchOf(stepAt(fire, path));
			if (target === null) return [];
			const newer = landed.some(
				(set) =>
					set.member !== fire.member &&
					set.device === target.device &&
					set.at > intentAt(fire) &&
					!(set.nature === "nudges" && target.nature === "nudges"),
			);
			return newer ? [{ member: fire.member, path }] : [];
		}),
	);
}

export interface Admitted {
	fires: Fire[];
	admitted: boolean;
	rows: { fire: Fire; outcome: "suppressed" | "refused"; reason: string }[];
}

/** Only tells are left to it. */
const onlyTelling = (fire: Fire): boolean => fire.light === true || (fire.waiting === true && !hasOpenSteps(fire));

/** Its least advanced idle fire; one that only tells goes first. */
const victimOf = (held: readonly Fire[]): Fire | undefined => {
	const free = held.filter((fire) => onlyTelling(fire) || !live(fire));
	return free.find(onlyTelling) ?? free.find(unstarted) ?? free[0];
};

export interface AdmitRule {
	supersede: boolean;
	earlier: (member: string) => boolean;
	waitingMax?: number;
	/** The fire holding its own tells alone; null when it has none. */
	tells: (fire: Fire) => Fire | null;
}

/** Past the bound, the heaviest automation drops one. A light fire is never replaced or counted waiting. */
export function admit(fires: readonly Fire[], incoming: Fire, rule: AdmitRule): Admitted {
	const held = [...fires];
	const rows: Admitted["rows"] = [];
	const waits = (fire: Fire): boolean => fire.automation === incoming.automation && !fire.light && unstarted(fire);
	const older = rule.supersede
		? held.findIndex((fire) => fire.member !== incoming.member && waits(fire) && rule.earlier(fire.member))
		: -1;
	const replaced = held[older];
	if (replaced) {
		rows.push({ fire: replaced, outcome: "suppressed", reason: REPLACED });
		const kept = rule.tells(replaced);
		if (kept) held[older] = kept;
		else held.splice(older, 1);
	}
	let admitted = incoming;
	if (rule.waitingMax !== undefined && !incoming.light && hasOpenSteps(incoming)) {
		if (held.filter(waits).length >= rule.waitingMax) {
			rows.push({ fire: incoming, outcome: "suppressed", reason: BEHIND });
			const kept = rule.tells(incoming);
			// Its tells go while there is room.
			if (!kept || held.length >= FIRES_MAX) return { fires: held, admitted: false, rows };
			admitted = kept;
		}
	}
	return room(held, admitted, rows);
}

/** Past the bound, the largest holder gives one up. */
function room(held: readonly Fire[], incoming: Fire, rows: Admitted["rows"]): Admitted {
	if (held.length < FIRES_MAX) return { fires: [...held, incoming], admitted: true, rows };
	const holders = new Map<string, Fire[]>();
	for (const fire of [...held, incoming])
		holders.set(fire.automation, [...(holders.get(fire.automation) ?? []), fire]);
	// On a tie, the newcomer's pays.
	const own = (group: Fire[]) => (group.includes(incoming) ? 1 : 0);
	const largest = [...holders.values()].sort((a, b) => b.length - a.length || own(b) - own(a));
	const victim = largest.map(victimOf).find((fire) => fire !== undefined);
	if (!victim || victim === incoming) {
		rows.push({ fire: incoming, outcome: "refused", reason: TOO_MANY });
		return { fires: [...held], admitted: false, rows };
	}
	rows.push({ fire: victim, outcome: "suppressed", reason: CROWDED });
	return { fires: [...held.filter((fire) => fire !== victim), incoming], admitted: true, rows };
}

export const claim = (fires: readonly Fire[], ref: StepRef, now: number): Fire[] =>
	fires.map((fire) => {
		const step = fire.steps[ref.path];
		return fire.member === ref.member && step ? withStep(fire, ref.path, claimed(step, now)) : fire;
	});
