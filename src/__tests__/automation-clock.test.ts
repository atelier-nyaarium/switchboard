import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOutboxSource } from "../gateway/assistant/outboxSource.js";
import { CLOCK_GRACE_MS, clockIssue, clockSentence, nextSlot } from "../gateway/computed/automationClock.js";
import { createAutomations } from "../gateway/computed/automations.js";
import type { ComputedFields } from "../gateway/computed/computedFields.js";
import { openDurable } from "../shared/durable-store.js";
import type { Automation, ClockTrigger } from "../shared/schemasAutomation.js";
import { type FakeAmbient, fakeAmbient } from "../testing/fakeAmbient.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fresh = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "automation-clock-"));
	roots.push(root);
	return root;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A Sunday, 10:00 in Los Angeles. */
const T0 = Date.UTC(2026, 10, 15, 18, 0, 0);
const NO_FIELDS = {
	typeOf: () => null,
	invalidOf: () => null,
	get: () => null,
	stateOf: () => null,
	derivedChanged: () => {},
	check: () => null,
} as unknown as ComputedFields;

const tells = (trigger: ClockTrigger): Automation => ({
	enabled: true,
	trigger,
	actions: [{ kind: "tell_assistant", when: "quietly" }],
});
const hourly: ClockTrigger = { kind: "interval", everyMin: 60 };

function open(dir: string, ambient: FakeAmbient, disk = { failing: false, writes: 0 }) {
	const automations = openDurable(dir, "automations", (records) =>
		openDurable(dir, "automation-state", (state) => {
			const save = state.saveChecked.bind(state);
			state.saveChecked = (value: unknown) => {
				disk.writes += 1;
				if (disk.failing) throw new Error("disk full");
				save(value);
			};
			return createAutomations({
				records,
				state,
				fields: NO_FIELDS,
				newIncarnation: () => ambient.newId(),
				now: () => ambient.now(),
				isHome: () => true,
				timers: ambient,
			});
		}),
	);
	const told = async () => {
		const poll = await createOutboxSource(automations.outbox).poll(null, new AbortController().signal);
		return poll.kind === "events" ? poll.events.map((event) => [event.title, event.fields.time]) : [];
	};
	return { automations, told };
}

describe("an automation's clock", () => {
	it("names the next slot in the rule's own zone, on its weekdays, and an interval from where it last stood", () => {
		const daily: ClockTrigger = {
			kind: "time",
			time: "18:00",
			weekdays: [1, 2, 3, 4, 5, 6, 7],
			zone: "America/Los_Angeles",
		};
		const mondays: ClockTrigger = { ...daily, time: "07:30", weekdays: [1] };

		expect(nextSlot(daily, T0)).toBe(T0 + 8 * HOUR);
		expect(nextSlot(daily, T0 + 8 * HOUR)).toBe(T0 + 32 * HOUR);
		expect(nextSlot(mondays, T0)).toBe(T0 + 21 * HOUR + 30 * MINUTE);
		expect(nextSlot(hourly, T0)).toBe(T0 + HOUR);
		expect([clockSentence(daily), clockSentence(mondays), clockSentence(hourly)]).toEqual([
			"Every day at 18:00",
			"Mon at 07:30",
			"Every hour",
		]);
		expect(clockSentence({ kind: "interval", everyMin: 45 })).toBe("Every 45 minutes");
		expect(clockIssue({ ...daily, zone: "Mars/Olympus" })).not.toBeNull();
		expect(clockIssue({ ...daily, time: "25:00" })).not.toBeNull();
		expect(clockIssue({ ...daily, weekdays: [1, 1] })).not.toBeNull();
	});

	it("fires at each slot after it is saved and tells the time, and never for the moment it was saved", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const { automations, told } = open(fresh(), ambient);
		expect(automations.ownerPut("hourly", tells(hourly), 0).stored).toBe(true);
		const saved = await told();

		await ambient.advance(HOUR - 1);
		const early = await told();
		await ambient.advance(1);
		await ambient.advance(HOUR);
		automations.stop();
		await ambient.advance(3 * HOUR);

		expect([saved, early]).toEqual([[], []]);
		expect(await told()).toEqual([
			["Every hour", "19:00 UTC"],
			["Every hour", "20:00 UTC"],
		]);
		expect(automations.rows()[0]).toMatchObject({ lastRanAt: T0 + 2 * HOUR, nextRunAt: T0 + 3 * HOUR });
	});

	it("runs a slot it finds inside the grace after a restart, and only counts the ones before it", async () => {
		const dir = fresh();
		const before = fakeAmbient({ drive: "manual", now: () => T0 });
		open(dir, before).automations.ownerPut("hourly", tells(hourly), 0);
		const late = T0 + 3 * HOUR + CLOCK_GRACE_MS - 1;

		const after = open(dir, fakeAmbient({ drive: "manual", now: () => late }));

		expect(await after.told()).toEqual([["Every hour", "21:00 UTC"]]);
		expect(after.automations.runs().map((run) => [run.outcome, run.reason])).toEqual([
			["uncertain", "missed 2 slots"],
			["ran", undefined],
		]);
	});

	it("retries a walk whose write failed half a minute on, and writes nothing in between", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const disk = { failing: false, writes: 0 };
		const { automations, told } = open(fresh(), ambient, disk);
		automations.ownerPut("hourly", tells(hourly), 0);

		disk.failing = true;
		await ambient.advance(HOUR);
		const failed = disk.writes;
		await ambient.advance(29_000);
		const waited = disk.writes;
		disk.failing = false;
		await ambient.advance(1_000);
		await automations.stop();

		expect(waited).toBe(failed);
		expect(await told()).toEqual([["Every hour", "19:00 UTC"]]);
	});

	it("keeps an interval on its grid however far behind it finds itself, and counts every slot it missed", async () => {
		const dir = fresh();
		open(dir, fakeAmbient({ drive: "manual", now: () => T0 })).automations.ownerPut("hourly", tells(hourly), 0);
		const late = T0 + 3_000 * HOUR + 2 * MINUTE;

		const after = open(dir, fakeAmbient({ drive: "manual", now: () => late }));

		expect(after.automations.runs().map((run) => [run.outcome, run.reason])).toEqual([
			["uncertain", "missed 2999 slots"],
			["ran", undefined],
		]);
		expect(after.automations.rows()[0]?.nextRunAt).toBe(T0 + 3_001 * HOUR);
	});

	it("starts over from now when it is edited or switched back on, so an edit never fires", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const { automations, told } = open(fresh(), ambient);
		automations.ownerPut("hourly", tells(hourly), 0);

		await ambient.advance(50 * MINUTE);
		automations.ownerPut("hourly", { ...tells(hourly), enabled: false }, 1);
		await ambient.advance(HOUR);
		automations.ownerPut("hourly", tells(hourly), 2);
		await ambient.advance(59 * MINUTE);
		const before = await told();
		await ambient.advance(MINUTE);
		automations.stop();

		expect(before).toEqual([]);
		expect(await told()).toEqual([["Every hour", "20:50 UTC"]]);
	});
});
