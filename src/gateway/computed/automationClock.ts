// When a time or interval trigger next comes round.

import { nextOccurrence, parseLocalTime, partsIn } from "../../shared/routine-recurrence.js";
import type { AutomationTrigger, ClockTrigger } from "../../shared/schemasAutomation.js";

/** A slot later than this is not run. */
export const CLOCK_GRACE_MS = 5 * 60_000;

const MINUTE_MS = 60_000;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const isClock = (trigger: AutomationTrigger): trigger is ClockTrigger =>
	trigger.kind === "time" || trigger.kind === "interval";

const pad = (value: number) => String(value).padStart(2, "0");

/** The first slot strictly after `after`. */
export function nextSlot(trigger: ClockTrigger, after: number): number | null {
	if (trigger.kind === "interval") return after + trigger.everyMin * MINUTE_MS;
	const from = partsIn(trigger.zone, after);
	return nextOccurrence(
		{
			weekdays: trigger.weekdays,
			weekInterval: 1,
			startDate: `${from.year}-${pad(from.month)}-${pad(from.day)}`,
			time: trigger.time,
			zone: trigger.zone,
		},
		after,
	);
}

const WALK_MAX = 2_000;

export interface SlotWalk {
	/** The last slot at or before `now`; `from` when none came round. */
	at: number;
	due: number[];
	missed: number;
}

/** An interval is counted, never stepped, to stay on its grid. */
export function walkSlots(trigger: ClockTrigger, from: number, now: number): SlotWalk {
	if (trigger.kind === "interval") {
		const step = trigger.everyMin * MINUTE_MS;
		const count = Math.max(0, Math.floor((now - from) / step));
		const first = Math.max(1, Math.ceil((now - CLOCK_GRACE_MS - from) / step));
		const due = Array.from({ length: Math.max(0, count - first + 1) }, (_, at) => from + (first + at) * step);
		return { at: from + count * step, due, missed: count - due.length };
	}
	const walk: SlotWalk = { at: from, due: [], missed: 0 };
	let steps = 0;
	for (
		let next = nextSlot(trigger, from);
		next !== null && next <= now && steps < WALK_MAX;
		next = nextSlot(trigger, next)
	) {
		walk.at = next;
		steps += 1;
		if (now - next > CLOCK_GRACE_MS) walk.missed += 1;
		else walk.due.push(next);
	}
	return walk;
}

const knownZone = (zone: string): boolean => {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
};

/** Why it can never come round. */
export function clockIssue(trigger: ClockTrigger): string | null {
	if (trigger.kind === "interval") return null;
	if (new Set(trigger.weekdays).size !== trigger.weekdays.length) return "a weekday is named twice";
	if (!parseLocalTime(trigger.time)) return `${trigger.time} is not a time`;
	if (!knownZone(trigger.zone)) return `${trigger.zone} is not a zone this Gateway knows`;
	return nextSlot(trigger, 0) === null ? "this time never comes round" : null;
}

const every = (count: number, unit: string) => (count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`);

export function clockSentence(trigger: ClockTrigger): string {
	if (trigger.kind === "interval") {
		const { everyMin } = trigger;
		if (everyMin % 1_440 === 0) return every(everyMin / 1_440, "day");
		return everyMin % 60 === 0 ? every(everyMin / 60, "hour") : every(everyMin, "minute");
	}
	const days = [...trigger.weekdays].sort((a, b) => a - b);
	const named = days.length === 7 ? "Every day" : days.map((day) => DAYS[day - 1]).join(", ");
	return `${named} at ${trigger.time}`;
}

/** The slot as a clock time, in the trigger's zone or UTC. */
export function clockShown(trigger: ClockTrigger, at: number): string {
	const zone = trigger.kind === "time" ? trigger.zone : "UTC";
	const { hour, minute } = partsIn(zone, at);
	return `${pad(hour)}:${pad(minute)}${trigger.kind === "time" ? "" : " UTC"}`;
}
