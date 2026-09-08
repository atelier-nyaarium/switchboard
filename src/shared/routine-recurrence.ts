// Every field of a rule is read in its own zone. Nothing here reads a clock.

export interface RoutineRule {
	/** ISO weekdays. Monday is 1. */
	weekdays: number[];
	/** 1 is every week, 2 every other. */
	weekInterval: number;
	/** Local date the weeks are counted from, as YYYY-MM-DD. */
	startDate: string;
	/** Local time, as HH:MM. */
	time: string;
	/** IANA zone every field above is read in. */
	zone: string;
}

export interface LocalDate {
	year: number;
	month: number;
	day: number;
}

/** A rule with no day, or an unreachable interval, would search forever. */
const SEARCH_DAYS = 400;

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
	const held = formatters.get(zone);
	if (held) return held;
	const made = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	formatters.set(zone, made);
	return made;
}

/** Wall-clock fields an instant carries in a zone. */
export function partsIn(zone: string, at: number): LocalDate & { hour: number; minute: number } {
	const read: Record<string, number> = {};
	for (const part of formatterFor(zone).formatToParts(at)) {
		if (part.type !== "literal") read[part.type] = Number(part.value);
	}
	return {
		year: read.year as number,
		month: read.month as number,
		day: read.day as number,
		hour: read.hour as number,
		minute: read.minute as number,
	};
}

/** The wall time as if it were UTC, which is what makes offsets subtractable. */
function wallOf(zone: string, at: number): number {
	const p = partsIn(zone, at);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

function offsetAt(zone: string, at: number): number {
	return wallOf(zone, at) - Math.floor(at / 60_000) * 60_000;
}

/** The first instant past a gap, found by the offset it changes to. */
function gapEnd(zone: string, before: number, after: number): number {
	const leading = offsetAt(zone, before);
	let low = before;
	let high = after;
	while (high - low > 1) {
		const mid = low + Math.floor((high - low) / 2);
		if (offsetAt(zone, mid) === leading) low = mid;
		else high = mid;
	}
	return high;
}

/**
 * The instant a local wall time names. A spring gap answers the moment the gap ends; a fall overlap
 * answers the earlier of its two instants.
 */
export function instantOf(zone: string, date: LocalDate, hour: number, minute: number): number {
	const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
	// Both sides of any transition within a day, since probing only at `wall` finds whichever side
	// that probe happens to land on and an overlap has to answer the earlier one.
	const offsets = new Set([offsetAt(zone, wall - DAY_MS), offsetAt(zone, wall), offsetAt(zone, wall + DAY_MS)]);
	const candidates = [...offsets].map((offset) => wall - offset);
	const real = candidates.filter((at) => wallOf(zone, at) === wall);
	if (real.length > 0) return Math.min(...real);
	return gapEnd(zone, Math.min(...candidates), Math.max(...candidates));
}

/** Monday is 1, whatever a locale says its week starts on. */
export function isoWeekday(date: LocalDate): number {
	const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
	return day === 0 ? 7 : day;
}

function asUtcMidnight(date: LocalDate): number {
	return Date.UTC(date.year, date.month - 1, date.day);
}

function mondayOf(date: LocalDate): number {
	return asUtcMidnight(date) - (isoWeekday(date) - 1) * DAY_MS;
}

/** Whole weeks between two dates, counted from the Monday each falls in. */
export function weeksBetween(from: LocalDate, to: LocalDate): number {
	return Math.round((mondayOf(to) - mondayOf(from)) / (7 * DAY_MS));
}

function dayAfter(date: LocalDate): LocalDate {
	const at = new Date(asUtcMidnight(date) + DAY_MS);
	return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

export function parseLocalDate(text: string): LocalDate | null {
	const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	if (!found) return null;
	const date = {
		year: Number(found[1]),
		month: Number(found[2]),
		day: Number(found[3]),
	};
	const back = new Date(asUtcMidnight(date));
	const same =
		back.getUTCFullYear() === date.year && back.getUTCMonth() + 1 === date.month && back.getUTCDate() === date.day;
	return same ? date : null;
}

export function parseLocalTime(text: string): { hour: number; minute: number } | null {
	const found = /^(\d{2}):(\d{2})$/.exec(text);
	if (!found) return null;
	const hour = Number(found[1]);
	const minute = Number(found[2]);
	if (hour > 23 || minute > 59) return null;
	return { hour, minute };
}

/** Whether a rule fires on a date at all, ignoring the time of day. */
function fallsOn(rule: RoutineRule, start: LocalDate, date: LocalDate): boolean {
	if (asUtcMidnight(date) < asUtcMidnight(start)) return false;
	if (!rule.weekdays.includes(isoWeekday(date))) return false;
	return weeksBetween(start, date) % rule.weekInterval === 0;
}

/**
 * The first instant the rule names strictly after `after`, or null within the search window. An
 * inclusive search would rematerialize the occurrence it was called from.
 */
export function nextOccurrence(rule: RoutineRule, after: number): number | null {
	const start = parseLocalDate(rule.startDate);
	const time = parseLocalTime(rule.time);
	if (!start || !time || rule.weekdays.length === 0 || rule.weekInterval < 1) return null;

	const from = partsIn(rule.zone, after);
	const floor: LocalDate = { year: from.year, month: from.month, day: from.day };
	// A start date past the window would otherwise exhaust the walk before reaching it.
	let cursor = asUtcMidnight(floor) < asUtcMidnight(start) ? start : floor;
	for (let walked = 0; walked < SEARCH_DAYS; walked++) {
		if (fallsOn(rule, start, cursor)) {
			const at = instantOf(rule.zone, cursor, time.hour, time.minute);
			if (at > after) return at;
		}
		cursor = dayAfter(cursor);
	}
	return null;
}
