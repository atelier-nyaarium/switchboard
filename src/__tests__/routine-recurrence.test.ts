import { describe, expect, it } from "vitest";
import { instantOf, isoWeekday, nextOccurrence, type RoutineRule } from "../shared/routine-recurrence.js";

const LA = "America/Los_Angeles";
const TOKYO = "Asia/Tokyo";
const LONDON = "Europe/London";

const utc = (text: string) => Date.parse(text);

const rule = (over: Partial<RoutineRule> = {}): RoutineRule => ({
	weekdays: [1, 3, 5],
	weekInterval: 1,
	startDate: "2026-01-01",
	time: "09:00",
	zone: LA,
	...over,
});

describe("a local time that is not simply a local time", () => {
	it("moves a spring gap forward to the moment the gap ends", () => {
		// Los Angeles has no 02:30 on 2026-03-08; 02:00 PST becomes 03:00 PDT.
		expect(instantOf(LA, { year: 2026, month: 3, day: 8 }, 2, 30)).toBe(utc("2026-03-08T10:00:00Z"));
	});

	it("takes the earlier of a fall overlap's two instants", () => {
		// 01:30 happens twice on 2026-11-01, once at -07:00 and again at -08:00.
		expect(instantOf(LA, { year: 2026, month: 11, day: 1 }, 1, 30)).toBe(utc("2026-11-01T08:30:00Z"));
	});

	it("takes the earlier one in a zone where the later instant is the easier to find", () => {
		// London's overlap straddles midnight UTC, so a probe at the wall time as UTC lands on the
		// GMT side and would answer 01:30Z. The BST instant half an hour earlier is the right one.
		expect(instantOf(LONDON, { year: 2026, month: 10, day: 25 }, 1, 30)).toBe(utc("2026-10-25T00:30:00Z"));
	});

	it("reads an ordinary time in the zone it was given", () => {
		expect(instantOf(LA, { year: 2026, month: 6, day: 15 }, 9, 0)).toBe(utc("2026-06-15T16:00:00Z"));
		expect(instantOf(TOKYO, { year: 2026, month: 6, day: 15 }, 9, 0)).toBe(utc("2026-06-15T00:00:00Z"));
	});
});

describe("which days a rule names", () => {
	it("counts Monday as 1, whatever a locale starts its week on", () => {
		expect(isoWeekday({ year: 2026, month: 9, day: 7 })).toBe(1);
		expect(isoWeekday({ year: 2026, month: 9, day: 13 })).toBe(7);
	});

	it("answers the next matching weekday, strictly after the floor", () => {
		const monday = utc("2026-09-07T16:00:00Z");
		// Standing exactly on an occurrence must not answer that occurrence again.
		expect(nextOccurrence(rule(), monday)).toBe(utc("2026-09-09T16:00:00Z"));
		expect(nextOccurrence(rule(), monday - 1)).toBe(monday);
	});

	it("counts a fortnight from the start date's week, not from the floor", () => {
		const every2 = rule({ weekdays: [1], weekInterval: 2, startDate: "2026-09-07" });
		const first = nextOccurrence(every2, utc("2026-09-01T00:00:00Z")) as number;
		expect(first).toBe(utc("2026-09-07T16:00:00Z"));
		expect(nextOccurrence(every2, first)).toBe(utc("2026-09-21T16:00:00Z"));
	});

	it("keeps a Sunday start date in the week a Monday-based count expects", () => {
		// 2026-09-06 is a Sunday, so its week is the one beginning Monday 2026-08-31.
		const sundays = rule({ weekdays: [7], weekInterval: 2, startDate: "2026-09-06" });
		const first = nextOccurrence(sundays, utc("2026-09-01T00:00:00Z")) as number;
		expect(first).toBe(utc("2026-09-06T16:00:00Z"));
		expect(nextOccurrence(sundays, first)).toBe(utc("2026-09-20T16:00:00Z"));
	});

	it("never answers before the start date", () => {
		const later = rule({ startDate: "2026-12-01" });
		expect(nextOccurrence(later, utc("2026-09-07T00:00:00Z"))).toBe(utc("2026-12-02T17:00:00Z"));
	});

	it("searches as far as its own interval reaches, not a fixed window", () => {
		// Wider than the schema offers, since the calculator is exported and does not read that.
		const yearly = rule({ weekdays: [1], weekInterval: 58, startDate: "2026-01-05" });
		expect(nextOccurrence(yearly, utc("2026-01-06T00:00:00Z"))).toBe(utc("2027-02-15T17:00:00Z"));
	});

	it("reaches a start date further off than the search window", () => {
		// Asked from now for a routine that begins in three years, the walk must not run out first.
		const distant = rule({ weekdays: [1], startDate: "2029-09-03" });
		expect(nextOccurrence(distant, utc("2026-09-07T00:00:00Z"))).toBe(utc("2029-09-03T16:00:00Z"));
	});

	it("answers nothing rather than searching forever when no day can match", () => {
		expect(nextOccurrence(rule({ weekdays: [] }), utc("2026-09-07T00:00:00Z"))).toBeNull();
		expect(nextOccurrence(rule({ weekInterval: 0 }), utc("2026-09-07T00:00:00Z"))).toBeNull();
	});
});

describe("the zone a rule was saved in", () => {
	it("is the one its weekday is read in, not the reader's", () => {
		// 09:00 Monday in Tokyo is still Sunday in Los Angeles, and the rule says Monday.
		const tokyo = rule({ weekdays: [1], zone: TOKYO, startDate: "2026-09-01" });
		expect(nextOccurrence(tokyo, utc("2026-09-06T00:00:00Z"))).toBe(utc("2026-09-07T00:00:00Z"));
	});

	it("holds one wall time across a transition, so the instants are not a fixed day apart", () => {
		const daily = rule({ weekdays: [1, 2, 3, 4, 5, 6, 7], time: "09:00" });
		const before = nextOccurrence(daily, utc("2026-03-07T00:00:00Z")) as number;
		const after = nextOccurrence(daily, before) as number;
		expect(before).toBe(utc("2026-03-07T17:00:00Z"));
		expect(after).toBe(utc("2026-03-08T16:00:00Z"));
		// Twenty three hours apart, and still two consecutive local mornings.
		expect(after - before).toBe(23 * 3_600_000);
	});
});
