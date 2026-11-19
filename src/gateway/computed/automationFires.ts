// A fired trigger's step progress.

import { z } from "zod";
import { reached } from "../../shared/automation-walk.js";
import {
	type Automation,
	type AutomationAction,
	AutomationActionSchema,
	TELL_WHEN,
} from "../../shared/schemasAutomation.js";
import { BEHIND, CROWDED, REPLACED, TOO_MANY } from "./automationLog.js";
import { type AutomationEffect, isEffect, natureOf } from "./automationRunner.js";
import { claimed, FRESH_STEP, isEnded, type Nature, type Step, StepPathSchema, StepSchema } from "./automationSteps.js";

/** Runs waiting on their steps. */
export const FIRES_MAX = 64;
/** Event fires of one automation not yet started. */
export const WAITING_EVENTS_MAX = 8;

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
	tell: TellSchema.optional(),
	/** The outbox had no room. */
	waiting: z.literal(true).optional(),
};

export const FrameSchema = z.strictObject({
	function: z.string(),
	incarnation: z.string(),
	revision: z.number().int().positive(),
	/** Pinned at start. */
	resolved: z.record(StepPathSchema, AutomationActionSchema).optional(),
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
	})
	.refine((fire) => fire.active.every((path) => Object.hasOwn(fire.steps, path)));
export type Fire = z.infer<typeof FireSchema>;
export type FireNames = NonNullable<Fire["names"]>;

/** Call site; null at top. */
export const callSiteOf = (path: string): string | null => {
	const at = path.lastIndexOf(".");
	return at < 0 ? null : path.slice(0, at);
};
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

/** A step whose attempt may go, and when it fell due. */
export interface Runnable {
	ref: StepRef;
	dueAt: number;
}

const byPath = (a: string, b: string): number => {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let at = 0; at < Math.min(left.length, right.length); at++) {
		const order = (left[at] as number) - (right[at] as number);
		if (order !== 0) return order;
	}
	return left.length - right.length;
};

/** Step paths in the order written. */
export const pathsOf = (fire: Fire): string[] => Object.keys(fire.steps).sort(byPath);

export const isStep = (action: AutomationAction): boolean => isEffect(action) || action.kind === "run_function";

export const stepsOf = (automation: Pick<Automation, "actions">): Fire["steps"] =>
	Object.fromEntries(reached(automation).flatMap(({ path, action }) => (isStep(action) ? [[path, FRESH_STEP]] : [])));

/** The first step not ended. */
export const turnOf = (fire: Fire): string | null =>
	pathsOf(fire).find((path) => !isEnded(fire.steps[path] as Step)) ?? null;

export const withStep = (fire: Fire, path: string, step: Step): Fire => ({
	...fire,
	steps: { ...fire.steps, [path]: step },
});

export const claimedPaths = (fire: Fire): string[] => pathsOf(fire).filter((path) => fire.steps[path]?.claimed);

const hasOpenSteps = (fire: Fire): boolean => turnOf(fire) !== null;

export const finished = (fire: Fire): boolean => !fire.tell && !hasOpenSteps(fire);

export const holdsClaim = (fire: Fire): boolean => claimedPaths(fire).length > 0;

/** A step's turn came. */
export const started = (fire: Fire): boolean => fire.active.length > 0;

/** Started with steps left; never evicted. */
export const live = (fire: Fire): boolean => started(fire) && hasOpenSteps(fire);

/** Steps left, no turn begun. */
export const unstarted = (fire: Fire): boolean => hasOpenSteps(fire) && !started(fire);

/** Oldest fire first. */
export const nextFill = (fires: readonly Fire[]): string | null =>
	fires.find((fire) => fire.tell?.fill)?.member ?? null;

/** Its automation's oldest fire with steps left. */
export function mayRun(fires: readonly Fire[]): Set<string> {
	const seen = new Set<string>();
	const runs = new Set<string>();
	for (const fire of fires) {
		if (!hasOpenSteps(fire) || seen.has(fire.automation)) continue;
		seen.add(fire.automation);
		runs.add(fire.member);
	}
	return runs;
}

/** Due longest ago; fire order breaks a tie. */
export const nextEffect = (runnable: readonly Runnable[]): StepRef | null =>
	runnable.reduce<Runnable | null>((best, next) => (best === null || next.dueAt < best.dueAt ? next : best), null)
		?.ref ?? null;

/** A switch step that landed: its device, its nature, and when its fire fired. */
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
					set.at > fire.at &&
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

/** Only waits to tell. */
const onlyTelling = (fire: Fire): boolean => fire.waiting === true && !hasOpenSteps(fire);

/** Its least advanced idle fire. */
const victimOf = (held: readonly Fire[]): Fire | undefined => {
	const free = held.filter((fire) => !live(fire));
	return free.find(onlyTelling) ?? free.find(unstarted) ?? free[0];
};

/** Past the bound, the heaviest automation drops one. */
export function admit(
	fires: readonly Fire[],
	incoming: Fire,
	rule: { supersede: boolean; earlier: (member: string) => boolean; waitingMax?: number },
): Admitted {
	const held = [...fires];
	const rows: Admitted["rows"] = [];
	const older = rule.supersede
		? held.findIndex(
				(fire) =>
					fire.automation === incoming.automation &&
					fire.member !== incoming.member &&
					unstarted(fire) &&
					rule.earlier(fire.member),
			)
		: -1;
	const replaced = held[older];
	if (replaced) {
		rows.push({ fire: replaced, outcome: "suppressed", reason: REPLACED });
		if (replaced.tell) held[older] = { ...replaced, steps: {}, active: [] };
		else held.splice(older, 1);
	}
	let admitted = incoming;
	if (rule.waitingMax !== undefined && hasOpenSteps(incoming)) {
		const waiting = held.filter((fire) => fire.automation === incoming.automation && unstarted(fire));
		if (waiting.length >= rule.waitingMax) {
			rows.push({ fire: incoming, outcome: "suppressed", reason: BEHIND });
			// Its tell goes while there is room.
			if (!incoming.tell || held.length >= FIRES_MAX) return { fires: held, admitted: false, rows };
			admitted = { ...incoming, steps: {}, active: [] };
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
