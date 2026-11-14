import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAutomations } from "../gateway/computed/automations.js";
import { createComputedFields } from "../gateway/computed/computedFields.js";
import { thresholdAutomations, thresholdField, thresholdIds } from "../gateway/computed/thresholds.js";
import { openDurable } from "../shared/durable-store.js";
import { known, refKey, type Value } from "../shared/expressions.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const FREEZER = "ce:1c:44:06:3c:5d";
const TEMP = refKey({ source: "device", device: FREEZER, key: "temperature" });

describe("threshold template", () => {
	it("alerts on the side the owner set, and stays quiet on the side left blank", async () => {
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
					input: (ref) => ({
						type: { type: "number", integral: false },
						value: readings.get(refKey(ref)) ?? known(0),
					}),
					onCommit: () => automations?.drain(),
				}),
			),
		);
		automations = openDurable(dir, "automations", (records) =>
			openDurable(dir, "automation-state", (state) =>
				createAutomations({
					records,
					state,
					fields,
					newIncarnation: () => `a${++n}`,
					now: () => clock,
					isHome: () => true,
				}),
			),
		);
		fields.start();
		const threshold = {
			device: FREEZER,
			measure: "temperature",
			label: "Freezer",
			high: -10,
			deadZone: 1,
			coolDownSec: 0,
		};
		const ids = thresholdIds(FREEZER, "temperature");
		const field = thresholdField(threshold);
		expect(field && fields.put(ids.field, field, 0)).toMatchObject({ stored: true });
		const sides = thresholdAutomations(threshold);
		automations.put(ids.high, sides.high, 0);
		automations.put(ids.low, sides.low, 0);
		const read = (value: number) => {
			clock += 1_000;
			readings.set(TEMP, known(value));
			fields.inputsChanged([TEMP]);
		};

		read(-5);
		read(-40);
		const poll = await automations.watcher.poll(null, new AbortController().signal);
		expect(poll.kind === "events" ? poll.events.map((event) => event.title) : []).toEqual(["Freezer above -10"]);
		expect(thresholdField({ ...threshold, high: undefined })).toBeNull();
	});
});
