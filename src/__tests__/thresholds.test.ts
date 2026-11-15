import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOutboxSource } from "../gateway/assistant/outboxSource.js";
import { createAutomations } from "../gateway/computed/automations.js";
import { createComputedFields } from "../gateway/computed/computedFields.js";
import { thresholdAutomations, thresholdIds } from "../gateway/computed/thresholds.js";
import { openDurable } from "../shared/durable-store.js";
import { known, refKey, type Value } from "../shared/expressions.js";
import type { Automation } from "../shared/schemasAutomation.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const FREEZER = "ce:1c:44:06:3c:5d";
const TEMP = refKey({ source: "device", device: FREEZER, key: "temperature" });

function world() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thresholds-"));
	roots.push(dir);
	const readings = new Map<string, Value>([[TEMP, known(-18)]]);
	let clock = 1_000;
	let n = 0;
	let automations: ReturnType<typeof createAutomations> | undefined;
	const fields = openDurable(dir, "fields", (records) =>
		openDurable(dir, "field-state", (state) =>
			createComputedFields({
				records,
				state,
				newIncarnation: () => `f${++n}`,
				now: () => clock,
				input: (ref) =>
					refKey(ref) === TEMP
						? { type: { type: "number", integral: false }, value: readings.get(TEMP) ?? known(0) }
						: null,
				derived: () => automations?.derivedFields() ?? [],
				onCommit: () => automations?.drain(),
			}),
		),
	);
	const opened = openDurable(dir, "automations", (records) =>
		openDurable(dir, "automation-state", (state) =>
			createAutomations({
				records,
				state,
				fields,
				newIncarnation: () => `a${++n}`,
				now: () => clock,
				isHome: () => true,
				reading: (device, measure) =>
					device === FREEZER && measure === "temperature"
						? {
								label: "Freezer temperature",
								shown: (value) => `${value} C`,
								now: () => {
									const held = readings.get(TEMP);
									return held?.known && typeof held.value === "number" ? held.value : null;
								},
							}
						: null,
			}),
		),
	);
	automations = opened;
	fields.start();
	const read = (value: number) => {
		clock += 1_000;
		readings.set(TEMP, known(value));
		fields.inputsChanged([TEMP]);
	};
	const told = async () => {
		const poll = await createOutboxSource(opened.outbox).poll(null, new AbortController().signal);
		return poll.kind === "events" ? poll.events.map((event) => [event.title, event.fields.value]) : [];
	};
	return { automations: opened, fields, read, told };
}

const above = (over: Partial<Automation> = {}, threshold = -10): Automation => ({
	enabled: true,
	trigger: {
		kind: "crossing",
		device: FREEZER,
		measure: "temperature",
		direction: "above",
		threshold,
		deadZone: 1,
		coolDownSec: 0,
	},
	actions: [{ kind: "tell_assistant", when: "quietly" }],
	...over,
});

describe("a crossing", () => {
	it("fires once past its threshold, holds inside the dead zone, and tells the number it fired on", async () => {
		const { automations, fields, read, told } = world();
		expect(automations.ownerPut("warm", above(), 0).stored).toBe(true);
		expect(fields.list()).toEqual([]);

		read(-5);
		read(-10.5);
		read(-5);
		read(-40);
		read(-9);

		expect(await told()).toEqual([
			["Freezer temperature goes above -10 C", "-5 C"],
			["Freezer temperature goes above -10 C", "-9 C"],
		]);
	});

	it("takes the number it is saved over as its baseline, and again when its threshold is edited", async () => {
		const { automations, read, told } = world();
		read(-5);
		automations.ownerPut("warm", above(), 0);
		read(-4);
		automations.ownerPut("warm", above({}, -20), 1);
		read(-3);

		expect(await told()).toEqual([]);
	});

	it("refuses a number no sensor reads here, and names its sensor only under an alert's id", () => {
		const { automations } = world();
		const elsewhere = above();
		if (elsewhere.trigger.kind === "crossing") elsewhere.trigger.measure = "humidity";
		const ids = thresholdIds(FREEZER, "temperature");
		const sides = thresholdAutomations({
			device: FREEZER,
			measure: "temperature",
			high: -10,
			deadZone: 1,
			coolDownSec: 0,
		});

		const unread = automations.ownerPut("damp", elsewhere, 0);
		automations.ownerPut("warm", above(), 0);
		automations.write({
			kind: "projection",
			device: FREEZER,
			rows: new Map(Object.entries({ [ids.high]: above() })),
		});

		expect(unread.stored).toBe(false);
		expect(Object.keys(sides)).toEqual(["high"]);
		expect(automations.rows().map((row) => [row.id, row.device])).toEqual([
			["warm", undefined],
			[ids.high, FREEZER],
		]);
	});
});
