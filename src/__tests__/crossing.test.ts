import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOutboxSource } from "../gateway/assistant/outboxSource.js";
import { previewAutomation } from "../gateway/computed/automationPreview.js";
import { type AutomationHoles, createAutomations } from "../gateway/computed/automations.js";
import { createComputedFields } from "../gateway/computed/computedFields.js";
import { fillHoles, holeIssue } from "../gateway/liveConsole/holes.js";
import { createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import { openDurable } from "../shared/durable-store.js";
import { known, refKey, type Value } from "../shared/expressions.js";
import type { Automation } from "../shared/schemasAutomation.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const FREEZER = "ce:1c:44:06:3c:5d";
const REGISTRY = createConsoleRegistry([]);
const HOLES: AutomationHoles = {
	issue: (text, names) => holeIssue(text, names, REGISTRY),
	fill: (text, names) => fillHoles(text, names, REGISTRY),
};
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
				holes: () => HOLES,
				reading: (device, measure) =>
					device === FREEZER && measure === "temperature"
						? {
								label: "Freezer temperature",
								device: "Freezer",
								measure: "Temperature",
								shown: (value) => `${value} C`,
								inUnit: (value) => value,
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
	const polled = async () => {
		const poll = await createOutboxSource(opened.outbox).poll(null, new AbortController().signal);
		return poll.kind === "events" ? poll.events : [];
	};
	const told = async () => (await polled()).map((event) => [event.title, event.fields.value]);
	const messages = async () => (await polled()).map((event) => [event.fields.message, event.tell]);
	return { automations: opened, fields, read, told, messages };
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

	it("tells its message with each hole filled from what fired, and a message with no hole in the firing's own write", async () => {
		const { automations, read, messages } = world();
		const filled = "It is {value} on {device}, past {threshold}: {round(value) < 0}";
		automations.ownerPut(
			"holes",
			above({ actions: [{ kind: "tell_assistant", when: "now", message: filled }] }),
			0,
		);
		automations.ownerPut(
			"plain",
			above({ actions: [{ kind: "tell_assistant", when: "quietly", message: "Check the freezer \\{door\\}" }] }),
			0,
		);

		read(-5);
		const atOnce = await messages();
		await automations.settled();

		expect(atOnce).toEqual([["Check the freezer {door}", "quietly"]]);
		expect(await messages()).toEqual([
			["Check the freezer {door}", "quietly"],
			["It is -5 C on Freezer, past -10 C: yes", "now"],
		]);
	});

	it("refuses at save a message whose hole names nothing here, with the span to mark", () => {
		const { automations } = world();
		const message = "It is {temperature} now";

		const refused = automations.ownerPut(
			"holes",
			above({ actions: [{ kind: "tell_assistant", when: "now", message }] }),
			0,
		);

		expect(refused).toMatchObject({ stored: false, hole: { action: 0, param: "message", start: 7, end: 18 } });
		expect(message.slice(7, 18)).toBe("temperature");
	});

	it("previews a text over the number as it stands, lists the names a hole may read, and marks a hole it cannot keep", async () => {
		const { automations } = world();
		const { trigger } = above();
		const deps = {
			event: async () => {
				throw new Error("no source here");
			},
			namesNow: automations.namesNow,
			holes: () => HOLES,
		};

		const shown = await previewAutomation(deps, trigger, "It is {value}, past {threshold}");
		const marked = await previewAutomation(deps, trigger, "It is {temp}");
		const elsewhere = previewAutomation(deps, {
			...trigger,
			kind: "crossing",
			device: "nowhere",
		} as typeof trigger);

		expect(shown).toMatchObject({
			names: [
				{ name: "value", shown: "-18 C" },
				{ name: "device", shown: "Freezer" },
				{ name: "measure", shown: "Temperature" },
				{ name: "threshold", shown: "-10 C" },
			],
			filled: "It is -18 C, past -10 C",
		});
		expect(marked).toMatchObject({ hole: { start: 7, end: 11 } });
		expect(marked.filled).toBeUndefined();
		await expect(elsewhere).rejects.toThrow();
	});

	it("refuses a number no sensor reads here, under any id its owner names", () => {
		const { automations } = world();
		const elsewhere = above();
		if (elsewhere.trigger.kind === "crossing") elsewhere.trigger.measure = "humidity";

		const unread = automations.ownerPut("damp", elsewhere, 0);
		const named = automations.ownerPut("threshold-ce1c-temperature-high", above(), 0);

		expect([unread.stored, named.stored]).toEqual([false, true]);
		expect(automations.rows().map((row) => row.id)).toEqual(["threshold-ce1c-temperature-high"]);
	});
});
