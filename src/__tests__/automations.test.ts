import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Automation, createAutomations } from "../gateway/computed/automations.js";
import { type ComputedField, createComputedFields } from "../gateway/computed/computedFields.js";
import { openDurable } from "../shared/durable-store.js";
import { type FieldRef, known, refKey, unknown, type Value } from "../shared/expressions.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fresh = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "automations-"));
	roots.push(root);
	return root;
};

const temperature: FieldRef = { source: "device", device: "ce:1c:44:06:3c:5d", key: "temperature" };
const TEMP = refKey(temperature);
const NUMBER = { type: "number", integral: false } as const;

const hotBand: ComputedField = {
	label: "Freezer band",
	nodes: [
		{ kind: "field", ref: temperature },
		{ kind: "band", input: 0, high: -10, deadZone: 1 },
	],
};

const iceBucket = (over: Partial<Automation> = {}): Automation => ({
	label: "Throw ice bucket!",
	enabled: true,
	trigger: { field: "band", becomes: "high" },
	action: { kind: "tell_assistant" },
	coolDownSec: 0,
	...over,
});

/** Reopenable Gateway fixture. */
function world(dir: string, home = true) {
	const readings = new Map<string, Value>([[TEMP, known(-18)]]);
	let clock = 1_000;
	let n = 0;
	let pokes = 0;
	let failing = 0;
	const open = () => {
		let automations: ReturnType<typeof createAutomations> | undefined;
		const fields = openDurable(dir, "computed-fields", (records) =>
			openDurable(dir, "computed-state", (state) =>
				createComputedFields({
					records,
					state,
					newIncarnation: () => `f${++n}`,
					now: () => clock,
					input: (ref) => ({ type: NUMBER, value: readings.get(refKey(ref)) ?? unknown("not heard") }),
					onCommit: () => automations?.drain(),
				}),
			),
		);
		const opened = openDurable(dir, "automations", (records) =>
			openDurable(dir, "automation-state", (state) => {
				const save = state.saveChecked.bind(state);
				state.saveChecked = (value: unknown) => {
					if (failing > 0) {
						failing--;
						throw new Error("disk full");
					}
					save(value);
				};
				return createAutomations({
					records,
					state,
					fields,
					newIncarnation: () => `a${++n}`,
					now: () => clock,
					isHome: () => home,
					onQueued: () => pokes++,
				});
			}),
		);
		automations = opened;
		fields.start();
		return { fields, automations: opened };
	};
	const read = (fields: ReturnType<typeof open>["fields"], value: number) => {
		clock += 1_000;
		readings.set(TEMP, known(value));
		fields.inputsChanged([TEMP]);
	};
	/** Changes without automation notification. */
	const unheard = (value: number) => {
		clock += 1_000;
		readings.set(TEMP, known(value));
		const fields = openDurable(dir, "computed-fields", (records) =>
			openDurable(dir, "computed-state", (state) =>
				createComputedFields({
					records,
					state,
					newIncarnation: () => `f${++n}`,
					now: () => clock,
					input: (ref) => ({ type: NUMBER, value: readings.get(refKey(ref)) ?? unknown("not heard") }),
				}),
			),
		);
		fields.start();
	};
	/** Reading during downtime. */
	const missed = (value: number) => {
		clock += 1_000;
		readings.set(TEMP, known(value));
	};
	/** The next automation-state writes fail. */
	const failWrites = (count: number) => {
		failing = count;
	};
	return { open, read, missed, unheard, failWrites, pokes: () => pokes };
}

const queued = async (automations: ReturnType<typeof createAutomations>) => {
	const answer = await automations.watcher.poll(null, new AbortController().signal);
	return answer.kind === "events" ? answer.events.map((event) => event.fields.value) : [];
};

describe("automations", () => {
	it("fires once per change into its value, queues for the sensors watcher, and pokes the lane", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.put("bucket", iceBucket(), 0);

		w.read(fields, -5);
		w.read(fields, -4);
		w.read(fields, -15);
		w.read(fields, -5);

		expect(await queued(automations)).toEqual(["high", "high"]);
		expect(automations.runs().map((run) => run.outcome)).toEqual(["ran", "ran"]);
		expect(w.pokes()).toBe(2);
		const first = await automations.watcher.poll(null, new AbortController().signal);
		const cursor = first.kind === "events" ? first.cursor : null;
		expect((await automations.watcher.poll(cursor, new AbortController().signal)).kind).toBe("unchanged");
	});

	it("takes the current value as its baseline when it or its field is edited, so an edit never fires", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		w.read(fields, -5);
		automations.put("bucket", iceBucket(), 0);
		automations.put("bucket", iceBucket({ label: "Renamed" }), 1);
		w.read(fields, -4);
		expect(await queued(automations)).toEqual([]);

		w.read(fields, -18);
		fields.put(
			"band",
			{ ...hotBand, nodes: [hotBand.nodes[0], { kind: "band", input: 0, high: -20, deadZone: 1 }] },
			1,
		);
		fields.put(
			"band",
			{ ...hotBand, nodes: [hotBand.nodes[0], { kind: "band", input: 0, high: -3, deadZone: 1 }] },
			2,
		);
		w.read(fields, -2);
		expect(await queued(automations)).toEqual(["high"]);
	});

	it("suppresses inside the cool-down and refuses on a Gateway that is not home, logging both", async () => {
		const cool = world(fresh());
		const a = cool.open();
		a.fields.put("band", hotBand, 0);
		a.automations.put("bucket", iceBucket({ coolDownSec: 60 }), 0);
		cool.read(a.fields, -5);
		a.automations.put("bucket", iceBucket({ coolDownSec: 60 }), 0);
		cool.read(a.fields, -15);
		cool.read(a.fields, -5);
		expect(a.automations.runs().map((run) => run.outcome)).toEqual(["ran", "suppressed"]);

		const away = world(fresh(), false);
		const b = away.open();
		b.fields.put("band", hotBand, 0);
		b.automations.put("bucket", iceBucket(), 0);
		away.read(b.fields, -5);
		expect(b.automations.runs()).toMatchObject([
			{ outcome: "refused", reason: expect.stringContaining("assistant") },
		]);
		expect(await queued(b.automations)).toEqual([]);
	});

	it("fires once at boot for a crossing while the Gateway was down, and clears what the watcher listed", async () => {
		const dir = fresh();
		const w = world(dir);
		const before = w.open();
		before.fields.put("band", hotBand, 0);
		before.automations.put("bucket", iceBucket(), 0);

		w.missed(-5);
		const after = w.open();
		w.read(after.fields, -5);
		expect(await queued(after.automations)).toEqual(["high"]);

		const page = await after.automations.watcher.list?.({ scope: "all" }, new AbortController().signal);
		expect(after.automations.clear((page?.events ?? []).map((event) => event.id))).toBe(true);
		expect(await queued(after.automations)).toEqual([]);
	});

	it("starts a field's count over when its state is lost, and still fires the next crossing", async () => {
		const dir = fresh();
		const w = world(dir);
		const before = w.open();
		before.fields.put("band", hotBand, 0);
		before.automations.put("bucket", iceBucket(), 0);
		w.read(before.fields, -5);
		w.read(before.fields, -15);
		fs.rmSync(path.join(dir, "computed-state.json"));

		const after = w.open();
		w.read(after.fields, -5);
		expect(await queued(after.automations)).toEqual(["high", "high"]);
	});

	const fullQueue = (dir: string) => {
		const old = Array.from({ length: 256 }, (_, i) => ({
			member: `old:${i}`,
			at: 500 + i,
			body: { title: "Old", fields: { value: "x" } },
		}));
		const state = { automations: {}, queue: { lastAt: 999, events: old }, log: [] };
		fs.writeFileSync(path.join(dir, "automation-state.json"), JSON.stringify(state));
		return old.map((event) => event.member);
	};

	it("holds a crossing a full queue refused past later changes, and fires it once a clear makes room", async () => {
		const dir = fresh();
		const old = fullQueue(dir);
		const w = world(dir);
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.put("bucket", iceBucket(), 0);
		w.read(fields, -5);
		w.read(fields, -15);
		expect(automations.runs().map((run) => run.outcome)).toEqual(["refused"]);

		automations.clear(old);
		expect(await queued(automations)).toEqual(["high"]);
		expect(automations.runs().map((run) => run.outcome)).toEqual(["refused", "ran"]);
	});

	it("fires a crossing a crash left between two changes exactly once, however often it is drained", async () => {
		const dir = fresh();
		const w = world(dir);
		const before = w.open();
		before.fields.put("band", hotBand, 0);
		before.automations.put("bucket", iceBucket(), 0);
		w.unheard(-5);
		w.unheard(-15);

		const after = w.open();
		after.automations.drain();
		w.open();
		expect(await queued(w.open().automations)).toEqual(["high"]);
	});

	it("logs changes it missed past the kept transitions as uncertain, and still fires the later ones", async () => {
		const dir = fresh();
		const old = fullQueue(dir);
		const w = world(dir);
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.put("bucket", iceBucket(), 0);
		for (let i = 0; i < 12; i++) {
			w.read(fields, -5);
			w.read(fields, -15);
		}
		automations.clear(old);

		const outcomes = automations.runs().map((run) => run.outcome);
		expect(outcomes).toContain("uncertain");
		expect(outcomes.at(-1)).toBe("ran");
		expect((await queued(automations)).length).toBeGreaterThan(0);
	});

	it("keeps a baseline whose write failed, and retries a drain whose write failed on the next clear", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		w.failWrites(1);
		automations.put("bucket", iceBucket(), 0);
		w.read(fields, -5);
		expect(await queued(automations)).toEqual(["high"]);

		w.read(fields, -15);
		w.failWrites(1);
		w.read(fields, -5);
		expect(await queued(automations)).toEqual(["high"]);
		expect(automations.clear([])).toBe(true);
		expect(await queued(automations)).toEqual(["high", "high"]);
	});

	it("names each queued event by its field epoch, so an edit never makes two crossings one", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.put("bucket", iceBucket(), 0);
		w.read(fields, -5);
		w.read(fields, -15);
		fields.put("band", { ...hotBand, decimals: 1 }, 1);
		w.read(fields, -5);

		const first = await automations.watcher.poll(null, new AbortController().signal);
		const ids = first.kind === "events" ? first.events.map((event) => event.id) : [];
		expect(new Set(ids).size).toBe(2);
		automations.clear([ids[0] as string]);
		expect(await queued(automations)).toEqual(["high"]);
	});

	it("holds a queue entry this build cannot read, and lists and clears the rest", async () => {
		const dir = fresh();
		const future = { member: "later:1", at: 500, body: { shape: "later" } };
		const state = { automations: {}, queue: { lastAt: 500, events: [future] }, log: [{ outcome: "later" }] };
		fs.writeFileSync(path.join(dir, "automation-state.json"), JSON.stringify(state));
		const w = world(dir);
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.put("bucket", iceBucket(), 0);
		w.read(fields, -5);

		expect(await queued(automations)).toEqual(["high"]);
		const page = await automations.watcher.list?.({ scope: "all" }, new AbortController().signal);
		automations.clear((page?.events ?? []).map((event) => event.id));
		const held = JSON.parse(fs.readFileSync(path.join(dir, "automation-state.json"), "utf8"));
		expect(held.queue.events).toEqual([future]);
	});

	it("refuses a trigger value the field cannot take, and reads a stored one invalid once its field changes", () => {
		const { fields, automations } = world(fresh()).open();
		fields.put("band", hotBand, 0);

		expect(automations.put("bucket", iceBucket({ trigger: { field: "band", becomes: "Hot!" } }), 0)).toMatchObject({
			stored: false,
		});
		expect(
			automations.put("bucket", iceBucket({ trigger: { field: "nowhere", becomes: "high" } }), 0),
		).toMatchObject({
			stored: false,
		});
		automations.put("bucket", iceBucket(), 0);
		expect(automations.invalidOf("bucket")).toBeNull();
		fields.put(
			"band",
			{
				label: "Cold",
				nodes: [
					{ kind: "field", ref: temperature },
					{ kind: "literal", type: "number", value: "-10" },
					{ kind: "compare", op: "lt", left: 0, right: 1 },
				],
			},
			1,
		);
		expect(automations.invalidOf("bucket")).not.toBeNull();
	});
});
