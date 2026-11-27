import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAutomations } from "../gateway/computed/automations.js";
import type { ComputedFields } from "../gateway/computed/computedFields.js";
import { type HeardSensor, SILENCE_HOLD_MS } from "../gateway/computed/sensorSilence.js";
import { createRestoreRepairs, openDurable } from "../shared/durable-store.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fresh = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-silence-"));
	roots.push(root);
	return root;
};

const MINUTE = 60_000;
/** The page's gateway radio limit. */
const STALE = 15 * MINUTE;
const T0 = Date.UTC(2026, 10, 15, 12, 46);
const NO_FIELDS = {
	typeOf: () => null,
	invalidOf: () => null,
	get: () => null,
	stateOf: () => null,
	derivedChanged: () => {},
	check: () => null,
} as unknown as ComputedFields;

/** Heard at `at`, as its page judges it. */
const heard = (id: string, at: number, radio: HeardSensor["radio"] = "gateway"): HeardSensor => ({
	id,
	name: `Sensor ${id}`,
	radio,
	heardAt: at,
	staleAt: at + (radio === "gateway" ? STALE : 2 * STALE),
});
/** Past the page's limit and the hold. */
const silentAfter = (at: number) => at + STALE + SILENCE_HOLD_MS + 1;

function world(dir: string) {
	const held = { now: T0, sensors: [] as HeardSensor[], home: true, pokes: 0 };
	let n = 0;
	const open = () =>
		openDurable(dir, "automations", (records) =>
			openDurable(dir, "automation-state", (state) =>
				createAutomations({
					repairs: createRestoreRepairs(),
					records,
					state,
					fields: NO_FIELDS,
					newIncarnation: () => `a${++n}`,
					now: () => held.now,
					isHome: () => held.home,
					onQueued: () => held.pokes++,
					sensorsHeard: () => held.sensors,
					gatewayName: "sakura",
				}),
			),
		);
	const told = (automations: ReturnType<typeof open>) =>
		automations.outbox.events().map((event) => [event.when, event.fields.sensor ?? event.fields.sensors]);
	return { held, open, told };
}

describe("a sensor's silence", () => {
	it("tells one silent sensor among live ones once, after the hold, and only at the assistant's home", () => {
		const { held, open, told } = world(fresh());
		const automations = open();
		const at = (now: number) => {
			held.now = now;
			held.sensors = [heard("a", T0), heard("b", now)];
			automations.watchSensors();
			return told(automations);
		};

		const inHold = at(silentAfter(T0) - 1);
		held.home = false;
		const away = at(silentAfter(T0));
		held.home = true;
		const once = at(silentAfter(T0));
		const again = at(silentAfter(T0) + MINUTE);

		expect([inHold, away]).toEqual([[], []]);
		expect(once).toEqual([["now", "Sensor a"]]);
		expect(again).toEqual(once);
		expect(held.pokes).toBe(1);
	});

	it("tells the sensors of one radio that went silent together as one event, naming how many and since when", () => {
		const { held, open } = world(fresh());
		const automations = open();
		held.sensors = [heard("a", T0), heard("b", T0 + MINUTE), heard("c", T0 + 2 * MINUTE)];

		held.now = silentAfter(T0 + 2 * MINUTE);
		automations.watchSensors();
		const events = automations.outbox.events();

		expect(events.map((event) => [event.when, event.fields.sensors, event.fields.radio])).toEqual([
			["now", "3", "gateway"],
		]);
		expect(events[0]?.fields.since).toBe(new Date(T0 + 2 * MINUTE).toISOString());
	});

	it("tells nothing for a sensor never heard since pairing", () => {
		const { held, open, told } = world(fresh());
		const automations = open();
		held.sensors = [{ id: "a", name: "Sensor a", radio: "phones" }];

		held.now = T0 + 24 * 60 * MINUTE;
		automations.watchSensors();

		expect(told(automations)).toEqual([]);
	});

	it("tells one quiet event when a told silence is heard again, and holds back a radio's stragglers for the hold", () => {
		const { held, open, told } = world(fresh());
		const automations = open();
		held.sensors = [heard("a", T0), heard("b", T0), heard("c", T0)];
		held.now = silentAfter(T0);
		automations.watchSensors();

		held.now += MINUTE;
		held.sensors = [heard("a", held.now), heard("b", T0), heard("c", T0)];
		automations.watchSensors();
		automations.watchSensors();
		const back = told(automations);
		held.now += SILENCE_HOLD_MS + 1;
		held.sensors = [heard("a", held.now), heard("b", T0), heard("c", T0)];
		automations.watchSensors();

		expect(back).toEqual([
			["now", "3"],
			["quietly", "3"],
		]);
		expect(told(automations).slice(2)).toEqual([
			["now", "Sensor b"],
			["now", "Sensor c"],
		]);
	});

	it("tells a silence that began before a restart once it has listened long enough, and its end once, across restarts", () => {
		const dir = fresh();
		const { held, open, told } = world(dir);
		open();
		held.sensors = [heard("a", T0)];

		held.now = T0 + 60 * MINUTE;
		const first = open();
		first.watchSensors();
		const unlistened = told(first);
		held.now = silentAfter(held.now);
		first.watchSensors();
		const second = open();
		second.watchSensors();
		const silent = told(second);
		held.now += MINUTE;
		held.sensors = [heard("a", held.now)];
		second.watchSensors();
		const third = open();
		third.watchSensors();

		expect(unlistened).toEqual([]);
		expect(silent).toEqual([["now", "Sensor a"]]);
		expect(told(third)).toEqual([
			["now", "Sensor a"],
			["quietly", "Sensor a"],
		]);
	});

	it("tells nothing on a start after long downtime until it has listened for the limit and the hold", () => {
		const watch = (heardAgain: boolean) => {
			const { held, open, told } = world(fresh());
			held.sensors = [heard("a", T0), heard("b", T0), heard("c", T0)];
			held.now = T0 + 8 * 60 * MINUTE;
			const started = held.now;
			const automations = open();
			const seen: unknown[] = [];
			for (const at of [0, MINUTE, 5 * MINUTE, STALE + SILENCE_HOLD_MS]) {
				held.now = started + at;
				if (heardAgain && at > 0) held.sensors = held.sensors.map((sensor) => heard(sensor.id, held.now));
				automations.watchSensors();
				seen.push(told(automations).length);
			}
			held.now = silentAfter(started);
			automations.watchSensors();
			automations.watchSensors();
			return [seen, told(automations)];
		};

		expect(watch(true)).toEqual([[0, 0, 0, 0], []]);
		expect(watch(false)).toEqual([[0, 0, 0, 0], [["now", "3"]]]);
	});

	it("waits while the outbox holds only urgent events, and tells once a clear makes room", () => {
		const dir = fresh();
		const urgent = Array.from({ length: 256 }, (_, i) => ({
			member: `old:${i}`,
			at: T0 + i,
			body: { title: "Old", fields: {}, when: "now" },
		}));
		const state = { queue: { lastAt: T0 + 256, events: urgent } };
		fs.writeFileSync(path.join(dir, "automation-state.json"), JSON.stringify(state));
		const { held, open, told } = world(dir);
		const automations = open();
		held.sensors = [heard("a", T0)];

		held.now = silentAfter(T0);
		automations.watchSensors();
		const full = told(automations).filter(([, subject]) => subject !== undefined);
		automations.clear(urgent.slice(0, 1).map((event) => event.member));
		automations.watchSensors();

		expect(full).toEqual([]);
		expect(told(automations).filter(([, subject]) => subject !== undefined)).toEqual([["now", "Sensor a"]]);
	});
});
