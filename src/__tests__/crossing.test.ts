import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOutboxSource } from "../gateway/assistant/outboxSource.js";
import { openAutomationPair } from "../gateway/compose/composeAutomations.js";
import { previewAutomation } from "../gateway/computed/automationPreview.js";
import type { AutomationPlaceholders } from "../gateway/computed/automations.js";
import { placeholdersOver } from "../gateway/liveConsole/placeholders.js";
import { createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import { createRestoreRepairs } from "../shared/durable-store.js";
import { known, refKey, type Value } from "../shared/expressions.js";
import {
	AUTOMATION_SERVES,
	AUTOMATION_TRIGGER_NAMES,
	AUTOMATION_TRIGGERS,
	type AutomationInput,
	AutomationSchema,
	AutomationTriggerSchema,
	ConsoleAutomationListResultSchema,
} from "../shared/schemasAutomation.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const FREEZER = "ce:1c:44:06:3c:5d";
const REGISTRY = createConsoleRegistry([]);
const PLACEHOLDERS: AutomationPlaceholders = placeholdersOver(REGISTRY);
const TEMP = refKey({ source: "device", device: FREEZER, key: "temperature" });
const noEvent = async () => {
	throw new Error("no source here");
};

function world() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thresholds-"));
	roots.push(dir);
	const readings = new Map<string, Value>([[TEMP, known(-18)]]);
	let clock = 1_000;
	let n = 0;
	const { fields, automations: opened } = openAutomationPair({
		repairs: createRestoreRepairs(),
		dataDir: dir,
		newIncarnation: () => `a${++n}`,
		now: () => clock,
		input: (ref) =>
			refKey(ref) === TEMP
				? { type: { type: "number", integral: false }, value: readings.get(TEMP) ?? known(0) }
				: null,
		automations: {
			isHome: () => true,
			placeholders: () => PLACEHOLDERS,
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
		},
	});
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

const above = (over: Partial<AutomationInput> = {}, threshold = -10): AutomationInput => ({
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

	it("tells its message with each placeholder filled from what fired, and a message with no placeholder in the firing's own write", async () => {
		const { automations, read, messages } = world();
		const filled = "It is {reading} on {device}, past {threshold}: {round(reading) < 0}";
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

	it("saves a message whose placeholder names nothing here as its error, with the span to mark", () => {
		const { automations } = world();
		const message = "It is {temperature} now";

		const saved = automations.saveOp({
			automationId: "holes",
			automation: AutomationSchema.parse(above({ actions: [{ kind: "tell_assistant", when: "now", message }] })),
			automationBase: 0,
			confirmed: true,
		});

		expect(saved).toMatchObject({
			stored: true,
			automation: { errors: 1 },
			issues: [{ level: "error", record: "automation", step: "0", param: "message", start: 7, end: 18 }],
		});
		expect(message.slice(7, 18)).toBe("temperature");
	});

	it("previews a text over the number as it stands, lists the names a placeholder may read, and marks a placeholder it cannot keep", async () => {
		const { automations } = world();
		const { trigger } = above();
		const deps = {
			event: noEvent,
			namesNow: automations.namesNow,
			placeholders: () => PLACEHOLDERS,
		};

		const shown = await previewAutomation(deps, { trigger, text: "It is {reading}, past {threshold}" });
		const marked = await previewAutomation(deps, { trigger, text: "It is {temp}" });
		const elsewhere = previewAutomation(deps, {
			trigger: { ...trigger, kind: "crossing", device: "nowhere" } as typeof trigger,
		});

		expect(shown).toEqual({
			matched: 0,
			of: 0,
			matches: [],
			names: [
				{ name: "reading", shown: "-18 C" },
				{ name: "device", shown: "Freezer" },
				{ name: "measure", shown: "Temperature" },
				{ name: "threshold", shown: "-10 C" },
			],
			filled: "It is -18 C, past -10 C",
		});
		expect(marked).toMatchObject({ placeholder: { start: 7, end: 11 } });
		expect(marked.filled).toBeUndefined();
		await expect(elsewhere).rejects.toThrow();
	});

	it("fills declared text values", async () => {
		const { automations } = world();
		const { trigger } = above();
		const deps = { event: noEvent, namesNow: automations.namesNow, placeholders: () => PLACEHOLDERS };
		const preview = await previewAutomation(deps, {
			trigger,
			text: "Set {degrees} degrees",
			params: [{ name: "degrees", type: "text" }],
			args: { degrees: "21" },
		});

		expect(preview.names?.at(-1)).toEqual({ name: "degrees", shown: "21" });
		expect(preview.filled).toBe("Set 21 degrees");
		const unset = await previewAutomation(deps, {
			trigger,
			text: "Set {degrees}",
			params: [{ name: "degrees", type: "text" }],
		});
		expect(unset.names?.at(-1)).toEqual({ name: "degrees", shown: "not set" });
		expect(unset.filled).toBe((await PLACEHOLDERS.fill("Set {degrees}", {})).text);
	});

	it("fills device values with switch names", async () => {
		const { automations } = world();
		const { trigger } = above();
		const deps = {
			event: noEvent,
			namesNow: automations.namesNow,
			placeholders: () => PLACEHOLDERS,
			deviceName: (device: string) => (device === FREEZER ? "Freezer" : null),
		};
		const preview = await previewAutomation(deps, {
			trigger,
			text: "Warm {room}",
			params: [{ name: "room", type: "device" }],
			args: { room: FREEZER },
		});

		expect(preview.names?.at(-1)).toEqual({ name: "room", shown: "Freezer" });
		expect(preview.filled).toBe("Warm Freezer");
	});

	it("marks an unknown name with its span", async () => {
		const { automations } = world();
		const { trigger } = above();
		const preview = await previewAutomation(
			{ event: noEvent, namesNow: automations.namesNow, placeholders: () => PLACEHOLDERS },
			{ trigger, text: "Use {unknown}", params: [{ name: "degrees", type: "number" }], args: { degrees: 21 } },
		);

		expect(preview.placeholder).toMatchObject({ start: 5, end: 12 });
		expect(preview.filled).toBeUndefined();
	});

	it("lets a trigger name win over a function value", async () => {
		const { automations } = world();
		const { trigger } = above();
		const preview = await previewAutomation(
			{ event: noEvent, namesNow: automations.namesNow, placeholders: () => PLACEHOLDERS },
			{
				trigger,
				text: "At {reading}",
				params: [{ name: "reading", type: "text" }],
				args: { reading: "function value" },
			},
		);

		expect(preview.names?.[0]).toEqual({ name: "reading", shown: "-18 C" });
		expect(preview.names?.at(-1)).toEqual({ name: "reading", shown: "function value" });
		expect(preview.filled).toBe("At -18 C");
	});

	it("answers a condition with its issue alone, and nothing for a readable one", async () => {
		const { automations } = world();
		const { trigger } = above();
		const deps = { event: noEvent, namesNow: automations.namesNow, placeholders: () => PLACEHOLDERS };
		const read = async (condition: string, variables: string[] = []) =>
			(
				await previewAutomation(deps, {
					trigger,
					condition,
					variables,
					params: [{ name: "level", type: "number" }],
					args: { level: 3 },
				})
			).condition;

		expect(await read("reading < threshold")).toEqual({});
		expect(await read("level + 1")).toEqual({});
		expect(await read("count > 1", ["count"])).toEqual({});
		expect(await read("nobody > 1")).toMatchObject({ issue: { start: 0, end: 6 } });
		expect(await read("level = 1")).toMatchObject({ issue: { start: 0 } });
	});

	it("answers no warning for an event condition with nothing to read", async () => {
		const { automations } = world();
		const preview = await previewAutomation(
			{
				event: async () => ({ names: null, preview: { matched: 0, of: 0, matches: [] } }),
				namesNow: automations.namesNow,
				placeholders: () => PLACEHOLDERS,
			},
			{ trigger: { kind: "event", source: "github", conditions: [] }, condition: 'event.reason == "mention"' },
		);

		expect(preview.condition).toEqual({});
	});

	it("keeps the names and the fill beside a condition", async () => {
		const { automations } = world();
		const { trigger } = above();
		const preview = await previewAutomation(
			{ event: noEvent, namesNow: automations.namesNow, placeholders: () => PLACEHOLDERS },
			{ trigger, text: "At {reading}", condition: "true" },
		);

		expect(preview.condition).toEqual({});
		expect(preview.filled).toBe("At -18 C");
	});

	it("saves a number no sensor reads here as invalid, under any id its owner names", () => {
		const { automations } = world();
		const elsewhere = above();
		if (elsewhere.trigger.kind === "crossing") elsewhere.trigger.measure = "humidity";

		const unread = automations.ownerPut("damp", elsewhere, 0);
		const named = automations.ownerPut("threshold-ce1c-temperature-high", above(), 0);

		expect([unread.stored, named.stored]).toEqual([true, true]);
		expect(automations.rows().map((row) => [row.id, typeof row.invalid])).toEqual([
			["damp", "string"],
			["threshold-ce1c-temperature-high", "undefined"],
		]);
	});
});

describe("the trigger catalogue", () => {
	it("names one row per trigger kind, in the union's order, and serves them whole", () => {
		const kinds = AutomationTriggerSchema.options.map((option) => option.shape.kind.value);
		const listed = ConsoleAutomationListResultSchema.parse({
			automations: [],
			serves: { ...AUTOMATION_SERVES, numbers: [], devices: [] },
		});

		expect(Object.keys(AUTOMATION_TRIGGERS)).toEqual(kinds);
		expect(listed.serves.triggers.map((row) => [row.kind, row.names.map((held) => held.name)])).toEqual(
			kinds.map((kind) => [kind, [...AUTOMATION_TRIGGER_NAMES[kind]]]),
		);
	});

	it("lists exactly the names a fire of each kind fills", () => {
		const { automations, fields } = world();
		fields.put(
			"band",
			{
				label: "Freezer band",
				nodes: [
					{ kind: "field", ref: { source: "device", device: FREEZER, key: "temperature" } },
					{ kind: "band", input: 0, high: -10, deadZone: 1 },
				],
			},
			0,
		);
		const zone = "UTC";
		const triggers = [
			{ kind: "value", field: "band", becomes: "high", coolDownSec: 0 },
			above().trigger,
			{ kind: "time", time: "09:00", weekdays: [1], zone },
			{ kind: "interval", everyMin: 60 },
		] as const;

		const filled = triggers.map((trigger) => [
			trigger.kind,
			Object.keys(automations.namesNow(trigger as Parameters<typeof automations.namesNow>[0])),
		]);

		expect(filled).toEqual(triggers.map((trigger) => [trigger.kind, [...AUTOMATION_TRIGGER_NAMES[trigger.kind]]]));
	});
});
