// A fired trigger's progress, effect by effect.

import { z } from "zod";
import { type AutomationAction, TELL_WHEN } from "../../shared/schemasAutomation.js";
import { CROWDED, REPLACED } from "./automationLog.js";
import { isEffect } from "./automationRunner.js";

/** Runs waiting on their effects. */
export const FIRES_MAX = 64;
/** An effect that sent nothing waits this long, from when this process first saw it. */
export const EFFECT_WAIT_MS = 120_000;
/** Between attempts of an effect that sent nothing. */
export const EFFECT_RETRY_MS = 5_000;

/** An effect seen unable to start. */
export interface Sighting {
	since: number;
	reason: string;
	retryAt: number;
}

/** A clock stepped back restarts the wait. */
export const sighted = (held: Sighting | undefined, now: number, reason: string, retryAt = now): Sighting => ({
	since: Math.min(held?.since ?? now, now),
	reason,
	retryAt,
});

export const mayWait = (seen: Sighting, now: number): boolean => now - seen.since < EFFECT_WAIT_MS;

export const EFFECT_STATES = ["pending", "claimed", "done"] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

/** A fired trigger awaiting its run. */
export const FireSchema = z.strictObject({
	member: z.string(),
	automation: z.string(),
	incarnation: z.string(),
	/** The record as it fired; an edit retires the fire. */
	revision: z.number().int().positive(),
	/** The transition it answers; zero for a slot or an event. */
	seq: z.number().int().nonnegative(),
	at: z.number().int(),
	/** What the trigger read, for its texts' holes. */
	names: z.record(z.string(), z.object({ value: z.unknown(), shown: z.string().optional() })).optional(),
	/** By action index. A claim is written before its effect runs and never runs again. */
	effects: z.record(z.string().regex(/^\d+$/), z.enum(EFFECT_STATES)),
	tell: z
		.strictObject({
			when: z.enum(TELL_WHEN),
			fields: z.record(z.string(), z.string()),
			/** Its messages' holes are unread. */
			fill: z.literal(true).optional(),
		})
		.optional(),
	/** The outbox had no room. */
	waiting: z.literal(true).optional(),
});
export type Fire = z.infer<typeof FireSchema>;
export type FireNames = NonNullable<Fire["names"]>;

export interface EffectRef {
	member: string;
	action: number;
}

export const effectKey = (ref: EffectRef): string => `${ref.member}#${ref.action}`;

/** Action indices in that state, in order. */
export const effectsIn = (fire: Fire, state: EffectState): number[] =>
	Object.entries(fire.effects)
		.filter(([, held]) => held === state)
		.map(([action]) => Number(action))
		.sort((a, b) => a - b);

export const pendingEffects = (actions: readonly AutomationAction[]): Fire["effects"] =>
	Object.fromEntries(actions.flatMap((action, at) => (isEffect(action) ? [[String(at), "pending"]] : [])));

export const withEffect = (fire: Fire, action: number, state: EffectState): Fire => ({
	...fire,
	effects: { ...fire.effects, [String(action)]: state },
});

export const finished = (fire: Fire): boolean =>
	!fire.tell && effectsIn(fire, "done").length === Object.keys(fire.effects).length;

export const holdsClaim = (fire: Fire): boolean => effectsIn(fire, "claimed").length > 0;

/** Has effects, none of them started. */
export const unstarted = (fire: Fire): boolean => {
	const held = Object.keys(fire.effects).length;
	return held > 0 && effectsIn(fire, "pending").length === held;
};

export type Work = { kind: "fill"; member: string } | { kind: "effect"; ref: EffectRef };

/** Fills first, then effects; oldest fire first. */
export function nextWork(fires: readonly Fire[], goes: (ref: EffectRef) => boolean): Work | null {
	const filling = fires.find((fire) => fire.tell?.fill);
	if (filling) return { kind: "fill", member: filling.member };
	for (const fire of fires) {
		for (const action of effectsIn(fire, "pending")) {
			const ref = { member: fire.member, action };
			if (goes(ref)) return { kind: "effect", ref };
		}
	}
	return null;
}

const TOO_MANY = "too many runs are waiting";

export interface Admitted {
	fires: Fire[];
	admitted: boolean;
	runs: { fire: Fire; outcome: "suppressed" | "refused"; reason: string }[];
}

/** Holds no claim and only waits to tell. */
const onlyTelling = (fire: Fire): boolean =>
	fire.waiting === true && effectsIn(fire, "done").length === Object.keys(fire.effects).length;

/** Its least advanced unclaimed fire, oldest first. */
const victimOf = (held: readonly Fire[]): Fire | undefined => {
	const free = held.filter((fire) => !holdsClaim(fire));
	return free.find(onlyTelling) ?? free.find(unstarted) ?? free[0];
};

/**
 * `supersede` replaces an unstarted fire of the same automation that an earlier pass stored. Past
 * the bound, the automation holding the most fires gives one up; a claimed effect is never touched.
 */
export function admit(
	fires: readonly Fire[],
	incoming: Fire,
	rule: { supersede: boolean; earlier: (member: string) => boolean },
): Admitted {
	const held = [...fires];
	const runs: Admitted["runs"] = [];
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
		runs.push({ fire: replaced, outcome: "suppressed", reason: REPLACED });
		const spent = effectsIn(replaced, "pending").reduce(
			(fire, action) => withEffect(fire, action, "done"),
			replaced,
		);
		if (replaced.tell) held[older] = spent;
		else held.splice(older, 1);
	}
	if (held.length < FIRES_MAX) return { fires: [...held, incoming], admitted: true, runs };
	const holders = new Map<string, Fire[]>();
	for (const fire of [...held, incoming])
		holders.set(fire.automation, [...(holders.get(fire.automation) ?? []), fire]);
	// A tie refuses the newcomer.
	const own = (group: Fire[]) => (group.includes(incoming) ? 1 : 0);
	const largest = [...holders.values()].sort((a, b) => b.length - a.length || own(b) - own(a));
	const victim = largest.map(victimOf).find((fire) => fire !== undefined);
	if (!victim || victim === incoming) {
		runs.push({ fire: incoming, outcome: "refused", reason: TOO_MANY });
		return { fires: held, admitted: false, runs };
	}
	runs.push({ fire: victim, outcome: "suppressed", reason: CROWDED });
	return { fires: [...held.filter((fire) => fire !== victim), incoming], admitted: true, runs };
}

export const claim = (fires: readonly Fire[], ref: EffectRef): Fire[] =>
	fires.map((fire) => (fire.member === ref.member ? withEffect(fire, ref.action, "claimed") : fire));
