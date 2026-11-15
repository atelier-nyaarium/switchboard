import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInboxListing } from "../gateway/assistant/inboxListing.js";
import { createOutboxSource } from "../gateway/assistant/outboxSource.js";
import { PollAnswerSchema, told } from "../gateway/assistant/source.js";
import { memberKey } from "../gateway/assistant/sourceLane.js";
import { FRESH_STATE, type SourceState } from "../gateway/assistant/sourceState.js";
import type { ActionOutcome } from "../gateway/computed/automationRunner.js";
import { createAutomations, EFFECT_RETRY_MS, EFFECT_WAIT_MS } from "../gateway/computed/automations.js";
import { type ComputedField, createComputedFields } from "../gateway/computed/computedFields.js";
import { fillHoles, holeIssue } from "../gateway/liveConsole/holes.js";
import { createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import { openDurable } from "../shared/durable-store.js";
import { type FieldRef, known, refKey, unknown, type Value } from "../shared/expressions.js";
import { AUTOMATIONS_MAX, type Automation, type ValueTrigger } from "../shared/schemasAutomation.js";

const REGISTRY = createConsoleRegistry([]);
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

const iceBucket = (over: Partial<Automation> & Partial<ValueTrigger> = {}): Automation => {
	const { field = "band", becomes = "high", coolDownSec = 0, kind: _kind, ...rest } = over;
	return {
		label: "Throw ice bucket!",
		enabled: true,
		trigger: { kind: "value", field, becomes, coolDownSec },
		actions: [{ kind: "tell_assistant", when: "quietly" }],
		...rest,
	};
};

/** Reopenable Gateway fixture. */
function world(dir: string, home = true) {
	const readings = new Map<string, Value>([[TEMP, known(-18)]]);
	let clock = 1_000;
	let n = 0;
	let pokes = 0;
	let failing = 0;
	const effects: string[] = [];
	let switches = ["plug"];
	let readable = true;
	let iftttReady = true;
	let iftttAnswer: ActionOutcome = { outcome: "refused", reason: "not_granted" };
	/** Effects wait on it. */
	let gate: Promise<void> = Promise.resolve();
	/** Only this effect waits; null: all. */
	let gated: string | null = null;
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
					eventIssue: (trigger) => (trigger.source === "github" ? null : "no such source"),
					holes: () =>
						readable
							? {
									issue: (text, names) => holeIssue(text, names, REGISTRY),
									fill: (text, names) => fillHoles(text, names, REGISTRY),
								}
							: undefined,
					actions: {
						ready: (action) => action.kind !== "ifttt_trigger" || iftttReady,
						switchName: (device) => (switches.includes(device) ? "Heater" : null),
						deviceSet: async (device, verb) => {
							effects.push(`${device}:${verb}`);
							if (gated === null || gated === `${device}:${verb}`) await gate;
							return { outcome: "ran" };
						},
						iftttTrigger: async ({ event }) => {
							effects.push(`ifttt:${event}`);
							return iftttAnswer;
						},
					},
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
	/** Effects wait until released. */
	const holdEffects = (only: string | null = null) => {
		gated = only;
		let release = () => {};
		gate = new Promise((resolve) => {
			release = resolve;
		});
		return () => release();
	};
	const unplug = () => {
		switches = [];
	};
	/** No hole reader. */
	const unreadable = () => {
		readable = false;
	};
	const setIftttReady = (ready: boolean) => {
		iftttReady = ready;
	};
	const answerIfttt = (answer: ActionOutcome) => {
		iftttAnswer = answer;
	};
	const advance = (ms: number) => {
		clock += ms;
	};
	return {
		advance,
		open,
		read,
		missed,
		unheard,
		failWrites,
		pokes: () => pokes,
		effects,
		holdEffects,
		unplug,
		unreadable,
		setIftttReady,
		answerIfttt,
	};
}

/** Through the lane's own parse. */
const polled = async (automations: ReturnType<typeof createAutomations>) =>
	PollAnswerSchema.parse(await createOutboxSource(automations.outbox).poll(null, new AbortController().signal));

const queued = async (automations: ReturnType<typeof createAutomations>) => {
	const answer = await polled(automations);
	return answer.kind === "events" ? answer.events.map((event) => event.fields.value) : [];
};

describe("automations", () => {
	it("reads a body stored before triggers had kinds as a value trigger that tells quietly", () => {
		const { fields, automations } = world(fresh()).open();
		fields.put("band", hotBand, 0);
		const earlier = {
			label: "Throw ice bucket!",
			enabled: true,
			trigger: { field: "band", becomes: "high" },
			action: { kind: "tell_assistant" },
			coolDownSec: 30,
		};

		expect(automations.ownerPut("bucket", earlier, 0).stored).toBe(true);
		expect(automations.list()[0]?.body).toEqual(iceBucket({ coolDownSec: 30 }));
	});

	it("rewrites a stored body from before triggers had kinds when the store opens", () => {
		const dir = fresh();
		const file = path.join(dir, "automations.json");
		const earlier = {
			label: "Throw ice bucket!",
			enabled: true,
			trigger: { field: "band", becomes: "high" },
			action: { kind: "tell_assistant" },
			coolDownSec: 0,
		};
		fs.writeFileSync(
			file,
			JSON.stringify([{ id: "bucket", revision: 3, incarnation: "a0", kind: "automation", body: earlier }]),
		);

		const { automations } = world(dir).open();
		expect(automations.list().map(({ revision, body }) => [revision, body])).toEqual([[3, iceBucket()]]);
		expect(JSON.parse(fs.readFileSync(file, "utf8"))[0].body).toEqual(iceBucket());
	});

	it("holds a source's event automations for its lane, armed ones only, and tells a crossing as its action says", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		const review = (over: Partial<Automation> = {}): Automation => ({
			enabled: true,
			trigger: {
				kind: "event",
				source: "github",
				conditions: [{ field: "reason", test: "is", value: "mention" }],
			},
			actions: [{ kind: "tell_assistant", when: "now" }],
			...over,
		});
		automations.ownerPut("review", review(), 0);
		automations.ownerPut("off", review({ enabled: false }), 0);
		const elsewhere = review({ trigger: { kind: "event", source: "gmail", conditions: [] } });
		expect(automations.ownerPut("elsewhere", elsewhere, 0).stored).toBe(false);
		automations.ownerPut("bucket", { ...iceBucket(), actions: [{ kind: "tell_assistant", when: "now" }] }, 0);

		expect(automations.eventsOf("github").map(({ id, when }) => [id, when])).toEqual([["review", "now"]]);
		expect(automations.eventsOf("sensors")).toEqual([]);

		w.read(fields, -5);
		expect(automations.outbox.events().map(({ title, when }) => [title, when])).toEqual([
			["Throw ice bucket!", "now"],
		]);
		const answer = await polled(automations);
		const events = answer.kind === "events" ? answer.events : [];
		expect(events.map((event) => told(event))).toEqual(["wake"]);
		expect(told({ tell: "quietly" })).toBe("inbox");
		expect(told({})).toBeNull();
	});

	it("fires once per change into its value, queues for the sensors watcher, and pokes the lane", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut("bucket", iceBucket(), 0);

		w.read(fields, -5);
		w.read(fields, -4);
		w.read(fields, -15);
		w.read(fields, -5);

		expect(await queued(automations)).toEqual(["high", "high"]);
		expect(automations.runs().map((run) => run.outcome)).toEqual(["ran", "ran"]);
		expect(w.pokes()).toBe(2);
		const first = await createOutboxSource(automations.outbox).poll(null, new AbortController().signal);
		const cursor = first.kind === "events" ? first.cursor : null;
		expect((await createOutboxSource(automations.outbox).poll(cursor, new AbortController().signal)).kind).toBe(
			"unchanged",
		);
	});

	it("takes the current value as its baseline when it or its field is edited, so an edit never fires", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		w.read(fields, -5);
		automations.ownerPut("bucket", iceBucket(), 0);
		automations.ownerPut("bucket", iceBucket({ label: "Renamed" }), 1);
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

	it("suppresses inside the cool-down and refuses on a Gateway that is not home, logging a standing refusal once", async () => {
		const cool = world(fresh());
		const a = cool.open();
		a.fields.put("band", hotBand, 0);
		a.automations.ownerPut("bucket", iceBucket({ coolDownSec: 60 }), 0);
		cool.read(a.fields, -5);
		a.automations.ownerPut("bucket", iceBucket({ coolDownSec: 60 }), 0);
		cool.read(a.fields, -15);
		cool.read(a.fields, -5);
		expect(a.automations.runs().map((run) => run.outcome)).toEqual(["ran", "suppressed"]);

		const away = world(fresh(), false);
		const b = away.open();
		b.fields.put("band", hotBand, 0);
		b.automations.ownerPut("bucket", iceBucket(), 0);
		away.read(b.fields, -5);
		away.read(b.fields, -15);
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
		before.automations.ownerPut("bucket", iceBucket(), 0);

		w.missed(-5);
		const after = w.open();
		w.read(after.fields, -5);
		expect(await queued(after.automations)).toEqual(["high"]);

		const page = await createOutboxSource(after.automations.outbox).list?.(
			{ scope: "all" },
			new AbortController().signal,
		);
		expect(after.automations.clear((page?.events ?? []).map((event) => event.id))).toBe(true);
		expect(await queued(after.automations)).toEqual([]);
	});

	it("starts a field's count over when its state is lost, and still fires the next crossing", async () => {
		const dir = fresh();
		const w = world(dir);
		const before = w.open();
		before.fields.put("band", hotBand, 0);
		before.automations.ownerPut("bucket", iceBucket(), 0);
		w.read(before.fields, -5);
		w.read(before.fields, -15);
		fs.rmSync(path.join(dir, "computed-state.json"));

		const after = w.open();
		w.read(after.fields, -5);
		expect(await queued(after.automations)).toEqual(["high", "high"]);
	});

	const fullQueue = (dir: string, when: "now" | "quietly") => {
		const old = Array.from({ length: 256 }, (_, i) => ({
			member: `old:${i}`,
			at: 500 + i,
			body: { title: "Old", fields: { value: "x" }, ...(when === "now" ? { when } : {}) },
		}));
		const state = { automations: {}, queue: { lastAt: 999, events: old }, log: [] };
		fs.writeFileSync(path.join(dir, "automation-state.json"), JSON.stringify(state));
		return old.map((event) => event.member);
	};

	it("holds a crossing an outbox full of urgent events refused past later changes, and fires it once a clear makes room", async () => {
		const dir = fresh();
		const old = fullQueue(dir, "now");
		const w = world(dir);
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut("bucket", iceBucket(), 0);
		w.read(fields, -5);
		w.read(fields, -15);
		expect(automations.runs().map((run) => run.outcome)).toEqual(["refused"]);

		automations.clear(old);
		expect(await queued(automations)).toEqual(["high"]);
		expect(automations.runs().map((run) => run.outcome)).toEqual(["refused", "ran"]);
	});

	it("drops the oldest quiet events to tell an urgent one at once", async () => {
		const dir = fresh();
		const old = fullQueue(dir, "quietly");
		const w = world(dir);
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut("bucket", { ...iceBucket(), actions: [{ kind: "tell_assistant", when: "now" }] }, 0);
		w.read(fields, -5);

		const ids = automations.outbox.events().map((event) => event.id);
		expect(ids).not.toContain(old[0]);
		expect(ids).toContain(old.at(-1));
		expect(automations.outbox.events().at(-1)).toMatchObject({ title: "Throw ice bucket!", when: "now" });
		expect(w.pokes()).toBe(1);
		expect(automations.runs().map((run) => run.outcome)).toEqual(["ran", "suppressed"]);
	});

	it("drops quiet events from the automation holding the most, and names each automation that lost one", () => {
		const dir = fresh();
		const quiet = (owner: string, at: number) => ({
			member: `automation:${owner}:a0:${at}`,
			at: 500 + at,
			body: { title: owner, fields: { value: "x" } },
		});
		const old = [
			...Array.from({ length: 128 }, (_, i) => quiet("alpha", i)),
			...Array.from({ length: 128 }, (_, i) => quiet("beta", 128 + i)),
		];
		const state = { automations: {}, queue: { lastAt: 999, events: old }, log: [] };
		fs.writeFileSync(path.join(dir, "automation-state.json"), JSON.stringify(state));
		const w = world(dir);
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		const urgent = { ...iceBucket(), actions: [{ kind: "tell_assistant", when: "now" }] } as Automation;
		automations.ownerPut("bucket", urgent, 0);
		automations.ownerPut("pail", { ...urgent, label: "Pail" }, 0);
		w.read(fields, -5);

		const ids = automations.outbox.events().map((event) => event.id);
		expect([old[0]?.member, old[128]?.member].map((member) => ids.includes(member as string))).toEqual([
			false,
			false,
		]);
		expect(ids).toHaveLength(256);
		expect(
			automations
				.runs()
				.filter((run) => run.outcome === "suppressed")
				.map((run) => run.automation),
		).toEqual(["alpha", "beta"]);
	});

	it("runs a fire's effects whatever the outbox holds, and tells it within the lane's bounds once there is room", async () => {
		const dir = fresh();
		const old = fullQueue(dir, "now");
		const w = world(dir);
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		const long = "x".repeat(600);
		const heat: Automation = {
			...iceBucket(),
			actions: [
				{ kind: "device_set", device: "plug", verb: "on" },
				{ kind: "tell_assistant", when: "now", message: `${long} {value}` },
				{ kind: "tell_assistant", when: "quietly", message: long },
			],
		};
		automations.ownerPut("heat", heat, 0);

		w.read(fields, -5);
		await automations.settled();
		const waiting = automations.runs().map((run) => [run.action, run.outcome]);
		automations.clear(old);
		await automations.settled();
		const answer = await polled(automations);
		const told = answer.kind === "events" ? answer.events : [];

		expect(w.effects).toEqual(["plug:on"]);
		expect(waiting).toEqual([
			["tell_assistant", "refused"],
			["device_set", "ran"],
		]);
		expect(told.map((event) => [event.fields.value, event.fields.message?.length, event.tell])).toEqual([
			["high", 1_000, "now"],
		]);
	});

	it("drops a waiting fire once its automation is edited, and starts no run after a stop", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		const heat = { ...iceBucket(), actions: [{ kind: "device_set", device: "plug", verb: "on" }] };
		automations.ownerPut("heat", heat, 0);
		w.holdEffects();
		w.read(fields, -5);
		w.read(fields, -15);
		w.read(fields, -5);
		automations.ownerPut("heat", { ...heat, enabled: false }, 1);
		const edited = automations.runs().map((run) => [run.outcome, run.reason]);

		const stopped = world(fresh());
		const later = stopped.open();
		later.fields.put("band", hotBand, 0);
		later.automations.ownerPut("heat", heat, 0);
		await later.automations.stop();
		stopped.read(later.fields, -5);
		const idle = [...stopped.effects];
		await stopped.open().automations.settled();

		expect(w.effects).toEqual(["plug:on"]);
		expect(edited).toEqual([["suppressed", "the automation changed"]]);
		expect([idle, stopped.effects]).toEqual([[], ["plug:on"]]);
	});

	it("fires a crossing a crash left between two changes exactly once, however often it is drained", async () => {
		const dir = fresh();
		const w = world(dir);
		const before = w.open();
		before.fields.put("band", hotBand, 0);
		before.automations.ownerPut("bucket", iceBucket(), 0);
		w.unheard(-5);
		w.unheard(-15);

		const after = w.open();
		after.automations.drain();
		w.open();
		expect(await queued(w.open().automations)).toEqual(["high"]);
	});

	it("logs changes it missed past the kept transitions as uncertain, and still fires the later ones", async () => {
		const w = world(fresh());
		const before = w.open();
		before.fields.put("band", hotBand, 0);
		before.automations.ownerPut("bucket", iceBucket(), 0);
		for (let i = 0; i < 12; i++) {
			w.unheard(-5);
			w.unheard(-15);
		}

		const { automations } = w.open();

		const outcomes = automations.runs().map((run) => run.outcome);
		expect(outcomes).toContain("uncertain");
		expect(outcomes.at(-1)).toBe("ran");
		expect((await queued(automations)).length).toBeGreaterThan(0);
	});

	it("keeps a baseline whose write failed until it lands, and retries a drain whose write failed on the next clear", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		w.failWrites(1);
		automations.ownerPut("bucket", iceBucket(), 0);
		w.read(fields, -5);
		expect(await queued(automations)).toEqual(["high"]);

		w.read(fields, -15);
		w.failWrites(1);
		w.read(fields, -5);
		expect(await queued(automations)).toEqual(["high"]);
		expect(automations.clear([])).toBe(true);
		expect(await queued(automations)).toEqual(["high", "high"]);

		w.read(fields, -15);
		w.failWrites(2);
		automations.ownerPut("bucket", iceBucket({ label: "Renamed" }), 1);
		w.read(fields, -5);
		expect(automations.clear([])).toBe(true);
		expect(await queued(automations)).toEqual(["high", "high", "high"]);
	});

	it("names each queued event by its field epoch, so an edit never makes two crossings one", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut("bucket", iceBucket(), 0);
		w.read(fields, -5);
		w.read(fields, -15);
		fields.put("band", { ...hotBand, decimals: 1 }, 1);
		w.read(fields, -5);

		const first = await createOutboxSource(automations.outbox).poll(null, new AbortController().signal);
		const ids = first.kind === "events" ? first.events.map((event) => event.id) : [];
		expect(new Set(ids).size).toBe(2);
		automations.clear([ids[0] as string]);
		expect(await queued(automations)).toEqual(["high"]);
	});

	it("continues a cut listing after the last event it showed, skipping none a clear removed meanwhile, and marks only what it listed", async () => {
		const dir = fresh();
		const old = Array.from({ length: 200 }, (_, i) => ({
			member: `automation:alpha:a0:${i}`,
			at: 500 + i,
			body: { title: "Old", fields: { value: "x".repeat(600) } },
		}));
		const state = { automations: {}, queue: { lastAt: 999, events: old }, log: [] };
		fs.writeFileSync(path.join(dir, "automation-state.json"), JSON.stringify(state));
		const w = world(dir);
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut("bucket", iceBucket(), 0);
		const source = createOutboxSource(automations.outbox);
		let held: SourceState = { ...FRESH_STATE, mark: 0 };
		const listing = createInboxListing({
			sources: [source],
			enabled: () => true,
			state: {
				get: () => held,
				put: (_id, next) => {
					held = next;
					return true;
				},
			},
			decide: () => "inbox",
			ambient: { randomBytes: (size) => Buffer.alloc(size, 7) },
			livePage: async (_id, query, _ms, settle) => {
				const read = await source.list?.(query(), new AbortController().signal);
				if (!read) throw new Error("the outbox lists nothing");
				return settle(read);
			},
		});
		const shown: string[] = [];
		let cleared: string[] = [];
		let page: string | undefined;
		do {
			const [list] = await listing.list("new", page);
			shown.push(...(list?.items ?? []).map((item) => item.id));
			page = list?.next;
			if (cleared.length === 0) {
				cleared = [...shown];
				automations.clear(cleared);
				// Tell drops old events.
				w.read(fields, -5);
			}
		} while (page);
		const kept = automations.outbox
			.events()
			.filter((event) => event.title === "Old")
			.map((event) => event.id);
		const [after] = await listing.list("new");

		expect([cleared.length, kept.length].every((count) => count > 0)).toBe(true);
		expect(shown.toSorted()).toEqual([...cleared, ...kept].toSorted());
		expect(after?.items.map((item) => item.fields.value)).toEqual(["high"]);
	});

	it("holds a queue entry this build cannot read, and lists and clears the rest", async () => {
		const dir = fresh();
		const future = { member: "later:1", at: 500, body: { shape: "later" } };
		const state = { automations: {}, queue: { lastAt: 500, events: [future] }, log: [{ outcome: "later" }] };
		fs.writeFileSync(path.join(dir, "automation-state.json"), JSON.stringify(state));
		const w = world(dir);
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut("bucket", iceBucket(), 0);
		w.read(fields, -5);

		expect(await queued(automations)).toEqual(["high"]);
		const page = await createOutboxSource(automations.outbox).list?.(
			{ scope: "all" },
			new AbortController().signal,
		);
		automations.clear((page?.events ?? []).map((event) => event.id));
		const held = JSON.parse(fs.readFileSync(path.join(dir, "automation-state.json"), "utf8"));
		expect(held.queue.events).toEqual([future]);
	});

	it("moves the home's event automations as one set: refused whole when it does not fit or takes a held id, keeping one it cannot run as invalid", () => {
		const { fields, automations } = world(fresh()).open();
		fields.put("band", hotBand, 0);
		const event = (source = "github"): Automation => ({
			enabled: true,
			trigger: { kind: "event", source, conditions: [] },
			actions: [{ kind: "tell_assistant", when: "now" }],
		});
		const ids = () => automations.list().map((record) => record.id);
		automations.ownerPut("bucket", iceBucket(), 0);
		automations.write({ kind: "carry", rows: [{ id: "old", automation: event() }] });
		const many = Array.from({ length: AUTOMATIONS_MAX }, (_, at) => ({ id: `e${at}`, automation: event() }));

		const over = automations.write({ kind: "carry", rows: many });
		const taken = automations.write({ kind: "carry", rows: [{ id: "bucket", automation: event() }] });
		const kept = ids();
		const fits = automations.write({
			kind: "carry",
			rows: [
				...many.slice(2),
				{ id: "elsewhere", automation: event("gmail") },
				{ id: "local", automation: iceBucket() },
			],
		});

		expect([over.written, taken.written]).toEqual([false, false]);
		expect(kept).toEqual(["bucket", "old"]);
		expect(fits).toMatchObject({ written: true, dropped: [{ id: "local" }] });
		expect(ids()).toEqual(["bucket", ...many.slice(2).map((row) => row.id), "elsewhere"]);
		expect(automations.invalidOf("elsewhere")).not.toBeNull();
		expect(automations.eventsOf("gmail")).toEqual([]);
	});

	it("converts only a sensor's own stored alerts, creating none, and keeps an event automation to the home", () => {
		const home = world(fresh()).open();
		home.fields.put("band", hotBand, 0);
		const away = world(fresh(), false).open();
		away.fields.put("band", hotBand, 0);
		const event: Automation = {
			enabled: true,
			trigger: { kind: "event", source: "github", conditions: [] },
			actions: [{ kind: "tell_assistant", when: "now" }],
		};
		const alert = (...ids: string[]) => new Map(ids.map((id) => [id, iceBucket()]));
		const convert = (prefix: string, rows: Map<string, Automation>) =>
			home.automations.write({ kind: "conversion", prefix, rows });
		home.fields.put("threshold-aa-t", hotBand, 0);
		home.automations.ownerPut("threshold-aa-t-high", iceBucket({ field: "threshold-aa-t" }), 0);

		const mine = convert("threshold-aa-", alert("threshold-aa-t-high", "threshold-aa-t-low"));
		const other = convert("threshold-aa-", alert("threshold-bb-t-high"));
		const named = convert("threshold-aa-", alert("bucket"));
		const swept = convert("threshold-bb-", new Map());

		expect([mine.written, other.written, named.written, swept.written]).toEqual([true, false, false, true]);
		expect(home.automations.list().map(({ id, body }) => [id, body])).toEqual([
			["threshold-aa-t-high", iceBucket()],
		]);
		expect(away.automations.ownerPut("review", event, 0).stored).toBe(false);
		expect(away.automations.ownerPut("bucket", iceBucket(), 0).stored).toBe(true);
	});

	it("runs a crossing's effects in order once it fires, logs each, and asks before a save adds a dangerous one", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		const heat: Automation = {
			...iceBucket(),
			actions: [
				{ kind: "device_set", device: "plug", verb: "on" },
				{ kind: "ifttt_trigger", event: "freezer" },
			],
		};

		const asked = automations.ownerPut("heat", heat, 0);
		const saved = automations.ownerPut("heat", heat, 0, true);
		w.read(fields, -5);
		await automations.settled();
		const toggled = automations.ownerPut("heat", { ...heat, enabled: false }, 1);

		expect(asked).toMatchObject({ stored: false, confirm: ["Send to IFTTT"] });
		expect([saved.stored, toggled.stored]).toEqual([true, true]);
		expect(w.effects).toEqual(["plug:on", "ifttt:freezer"]);
		expect(automations.runs().map((run) => [run.action, run.outcome])).toEqual([
			["device_set", "ran"],
			["ifttt_trigger", "refused"],
		]);
		expect(await queued(automations)).toEqual([]);
	});

	it("keeps one unstarted fire per automation, so a busy one starves no other", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut(
			"heat",
			{ ...iceBucket(), actions: [{ kind: "device_set", device: "plug", verb: "on" }] },
			0,
		);
		const cross = (times: number) => {
			for (let at = 0; at < times; at++) {
				w.read(fields, -5);
				w.read(fields, -15);
			}
		};
		const release = w.holdEffects();
		cross(3);
		const replaced = automations.runs().map((run) => run.outcome);
		automations.ownerPut("bucket", iceBucket(), 0);
		cross(80);
		release();
		await automations.settled();

		expect(replaced).toEqual(["suppressed"]);
		expect(w.effects).toEqual(["plug:on", "plug:on"]);
		expect(await queued(automations)).toHaveLength(80);
	});

	it("lets a flood of one automation crowd out only its own waiting runs, never another automation's", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut(
			"flash",
			{
				enabled: true,
				trigger: { kind: "event", source: "github", conditions: [] },
				actions: [{ kind: "device_set", device: "plug", verb: "toggle" }],
			},
			0,
		);
		automations.ownerPut(
			"heat",
			{ ...iceBucket(), actions: [{ kind: "device_set", device: "plug", verb: "on" }] },
			0,
		);
		const release = w.holdEffects();
		const flood = Array.from({ length: 70 }, (_, at) => ({
			automation: "flash",
			key: memberKey("github", { id: String(at), at }),
			names: {},
		}));
		automations.fireEvents(flood, 5_000);
		w.read(fields, -5);
		const crowded = automations.runs().map(({ automation, outcome }) => [automation, outcome]);
		release();
		await automations.settled();

		expect(crowded).toEqual([["flash", "suppressed"]]);
		expect([w.effects.filter((at) => at === "plug:toggle").length, w.effects.at(-1)]).toEqual([63, "plug:on"]);
	});

	it("leaves a fire queued while its effect cannot be attempted, runs the others, and sends it once it can", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		const bell = { ...iceBucket(), actions: [{ kind: "ifttt_trigger", event: "freezer" }] };
		automations.ownerPut("bell", bell, 0, true);
		automations.ownerPut(
			"heat",
			{ ...iceBucket(), actions: [{ kind: "device_set", device: "plug", verb: "on" }] },
			0,
		);
		w.setIftttReady(false);
		w.read(fields, -5);
		await automations.settled();
		const unready = [[...w.effects], automations.runs().map((run) => run.automation)];
		w.setIftttReady(true);
		automations.tick();
		await automations.settled();
		automations.tick();
		await automations.settled();

		expect(unready).toEqual([["plug:on"], ["heat"]]);
		expect(w.effects).toEqual(["plug:on", "ifttt:freezer"]);
	});

	const bell: Automation = {
		...iceBucket(),
		actions: [
			{ kind: "device_set", device: "plug", verb: "on" },
			{ kind: "ifttt_trigger", event: "freezer" },
			{ kind: "tell_assistant", when: "now" },
		],
	};
	const ifttt = (automations: ReturnType<typeof createAutomations>) =>
		automations
			.runs()
			.filter((run) => run.action === "ifttt_trigger")
			.map((run) => run.outcome);

	it("runs a fire's plug and tell while its unready effect waits alone, and refuses that effect unsent once the wait has passed", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut("bell", bell, 0, true);
		w.setIftttReady(false);
		w.read(fields, -5);
		await automations.settled();
		const held = [[...w.effects], (await queued(automations)).length, ifttt(automations)];
		w.advance(EFFECT_WAIT_MS);
		automations.tick();
		await automations.settled();

		expect(held).toEqual([["plug:on"], 1, []]);
		expect(w.effects).toEqual(["plug:on"]);
		expect(ifttt(automations)).toEqual(["refused"]);
	});

	it("retries an effect that sent nothing while its plug and tell go ahead, sends it once it can, and refuses it once the wait has passed", async () => {
		const sends = world(fresh());
		const a = sends.open();
		a.fields.put("band", hotBand, 0);
		a.automations.ownerPut("bell", bell, 0, true);
		sends.answerIfttt({ outcome: "not_started", reason: "not_ready" });
		sends.read(a.fields, -5);
		await a.automations.settled();
		const first = [[...sends.effects], (await queued(a.automations)).length, ifttt(a.automations)];
		a.automations.tick();
		await a.automations.settled();
		const resting = [...sends.effects];
		sends.answerIfttt({ outcome: "ran" });
		sends.advance(EFFECT_RETRY_MS);
		a.automations.tick();
		await a.automations.settled();

		const lapses = world(fresh());
		const b = lapses.open();
		b.fields.put("band", hotBand, 0);
		b.automations.ownerPut("bell", bell, 0, true);
		lapses.answerIfttt({ outcome: "not_started", reason: "not_ready" });
		lapses.read(b.fields, -5);
		await b.automations.settled();
		for (const step of [EFFECT_RETRY_MS, EFFECT_WAIT_MS, EFFECT_RETRY_MS]) {
			lapses.advance(step);
			b.automations.tick();
			await b.automations.settled();
		}

		expect(first).toEqual([["plug:on", "ifttt:freezer"], 1, []]);
		expect(resting).toEqual(["plug:on", "ifttt:freezer"]);
		expect([sends.effects, ifttt(a.automations)]).toEqual([["plug:on", "ifttt:freezer", "ifttt:freezer"], ["ran"]]);
		expect([lapses.effects, ifttt(b.automations)]).toEqual([
			["plug:on", "ifttt:freezer", "ifttt:freezer"],
			["refused"],
		]);
	});

	it("runs the effect of every event one poll brings, and of each that arrives behind a busy run", async () => {
		const w = world(fresh());
		const { automations } = w.open();
		automations.ownerPut(
			"flash",
			{
				enabled: true,
				trigger: { kind: "event", source: "github", conditions: [] },
				actions: [{ kind: "device_set", device: "plug", verb: "toggle" }],
			},
			0,
		);
		const event = (at: number) => ({
			automation: "flash",
			key: memberKey("github", { id: String(at), at }),
			names: {},
		});

		automations.fireEvents([event(1), event(2)], 5_000);
		await automations.settled();
		const batch = w.effects.length;
		const release = w.holdEffects();
		for (const at of [3, 4, 5]) automations.fireEvents([event(at)], 6_000 + at);
		release();
		await automations.settled();

		expect([batch, w.effects.length]).toEqual([2, 5]);
		expect(automations.runs().filter((run) => run.outcome === "suppressed")).toEqual([]);
	});

	it("away from the home, switches its plug, refuses unsent an action that needs the home, and logs each standing refusal once", async () => {
		const w = world(fresh(), false);
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		const heat: Automation = {
			...iceBucket(),
			actions: [
				{ kind: "ifttt_trigger", event: "freezer" },
				{ kind: "device_set", device: "plug", verb: "on" },
			],
		};
		const alert: Automation = {
			...iceBucket(),
			actions: [
				{ kind: "tell_assistant", when: "now" },
				{ kind: "ifttt_trigger", event: "freezer" },
			],
		};
		automations.ownerPut("heat", heat, 0, true);
		w.read(fields, -5);
		await automations.settled();
		const first = automations.runs().map((run) => [run.action, run.outcome]);
		automations.ownerPut("alert", alert, 0, true);
		for (let at = 0; at < 3; at++) {
			w.read(fields, -15);
			w.read(fields, -5);
			await automations.settled();
		}

		expect(first).toEqual([
			["ifttt_trigger", "refused"],
			["device_set", "ran"],
		]);
		expect(w.effects).toEqual(["plug:on", "plug:on", "plug:on", "plug:on"]);
		expect(
			automations
				.runs()
				.filter((run) => run.automation === "alert")
				.map((run) => [run.action, run.outcome]),
		).toEqual([
			[undefined, "refused"],
			["ifttt_trigger", "refused"],
		]);
	});

	it("never reruns a fire a restart found claimed: uncertain after a crash, ran after a graceful stop", async () => {
		const heat = { ...iceBucket(), actions: [{ kind: "device_set", device: "plug", verb: "on" }] };
		const started = (w: ReturnType<typeof world>) => {
			const before = w.open();
			before.fields.put("band", hotBand, 0);
			before.automations.ownerPut("heat", heat, 0);
			const release = w.holdEffects();
			w.read(before.fields, -5);
			return { before, release };
		};
		const crashed = world(fresh());
		started(crashed);
		const lost = crashed.open().automations;
		await lost.settled();

		const stopped = world(fresh());
		const { before, release } = started(stopped);
		const stopping = before.automations.stop();
		release();
		await stopping;
		const kept = stopped.open().automations;
		await kept.settled();

		expect([crashed.effects, stopped.effects]).toEqual([["plug:on"], ["plug:on"]]);
		expect([lost.runs().map((run) => run.outcome), kept.runs().map((run) => run.outcome)]).toEqual([
			["uncertain"],
			["ran"],
		]);
	});

	it("after a crash mid-run, runs the effects not yet started, logs the one in flight uncertain, and repeats none", async () => {
		const w = world(fresh());
		const before = w.open();
		before.fields.put("band", hotBand, 0);
		const three: Automation = {
			...iceBucket(),
			actions: [
				{ kind: "device_set", device: "plug", verb: "on" },
				{ kind: "device_set", device: "plug", verb: "off" },
				{ kind: "device_set", device: "plug", verb: "toggle" },
			],
		};
		before.automations.ownerPut("three", three, 0);
		w.holdEffects("plug:off");
		w.read(before.fields, -5);
		await vi.waitFor(() => expect(w.effects).toContain("plug:off"));

		const after = w.open().automations;
		await after.settled();

		expect(w.effects).toEqual(["plug:on", "plug:off", "plug:toggle"]);
		expect(after.runs().map((run) => run.outcome)).toEqual(["ran", "uncertain", "ran"]);
	});

	it("runs an event's effects once per member, again for later activity on it, and refuses an action whose switch this Gateway lacks", async () => {
		const w = world(fresh());
		const { automations } = w.open();
		const onMention: Automation = {
			enabled: true,
			trigger: { kind: "event", source: "github", conditions: [] },
			actions: [{ kind: "device_set", device: "plug", verb: "toggle" }],
		};
		const elsewhere = { ...onMention, actions: [{ kind: "device_set", device: "lamp", verb: "on" }] };
		automations.ownerPut("flash", onMention, 0);
		const matched = (at: number) => [{ automation: "flash", key: memberKey("github", { id: "1", at }), names: {} }];

		automations.fireEvents(matched(1), 5_000);
		automations.fireEvents(matched(1), 6_000);
		automations.fireEvents(matched(2), 7_000);
		await automations.settled();
		const refused = automations.ownerPut("lamp", elsewhere, 0);
		w.unplug();

		expect(w.effects).toEqual(["plug:toggle", "plug:toggle"]);
		expect(refused.stored).toBe(false);
		expect(automations.rows().map((row) => [row.id, row.invalid !== undefined])).toEqual([["flash", true]]);
	});

	it("reads a text with holes as invalid while no hole reader is composed, and fires nothing", async () => {
		const w = world(fresh());
		const { automations } = w.open();
		automations.ownerPut(
			"messaged",
			{
				enabled: true,
				trigger: { kind: "event", source: "github", conditions: [] },
				actions: [{ kind: "tell_assistant", when: "now", message: "{event} on {source}" }],
			},
			0,
		);
		const held = automations.rows().map((row) => typeof row.invalid);
		w.unreadable();

		automations.fireEvents([{ automation: "messaged", key: "event:github:7", names: {} }], 5_000);
		await automations.settled();
		const answer = await polled(automations);

		expect([held, automations.rows().map((row) => typeof row.invalid)]).toEqual([["undefined"], ["string"]]);
		expect(answer.kind === "events" ? answer.events : []).toEqual([]);
		expect(automations.runs()).toEqual([]);
	});

	it("tells an event's message through the outbox with the event's names, and leaves only a tell with no message to the source's lane", async () => {
		const w = world(fresh());
		const { automations } = w.open();
		const event: Automation["trigger"] = { kind: "event", source: "github", conditions: [] };
		const messaged: Automation = {
			enabled: true,
			trigger: event,
			actions: [{ kind: "tell_assistant", when: "now", message: "{event.reason} on {source}: {event}" }],
		};
		const plain: Automation = { enabled: true, trigger: event, actions: [{ kind: "tell_assistant", when: "now" }] };
		const noted: Automation = {
			enabled: true,
			trigger: event,
			actions: [{ kind: "tell_assistant", when: "now", message: "Look now" }],
		};
		automations.ownerPut("messaged", messaged, 0);
		automations.ownerPut("plain", plain, 0);
		automations.ownerPut("noted", noted, 0);
		const names = {
			event: { value: { reason: "mention", title: "Fix the build" }, shown: "Fix the build" },
			source: { value: "GitHub" },
		};

		automations.fireEvents(
			["messaged", "plain", "noted"].map((automation) => ({ automation, key: "event:github:7", names })),
			5_000,
		);
		await automations.settled();
		const answer = await polled(automations);
		const events = answer.kind === "events" ? answer.events : [];

		expect(automations.eventsOf("github").map(({ id, when }) => [id, when])).toEqual([
			["messaged", null],
			["plain", "now"],
			["noted", null],
		]);
		expect(events.map((told) => [told.fields.message, told.fields.note, told.fields.event, told.tell])).toEqual([
			["Look now", undefined, "Fix the build", "now"],
			["mention on GitHub: Fix the build", "{event.reason} on {source}: {event}", "Fix the build", "now"],
		]);
	});

	it("refuses a trigger value the field cannot take, and reads a stored one invalid once its field changes", () => {
		const { fields, automations } = world(fresh()).open();
		fields.put("band", hotBand, 0);

		expect(automations.ownerPut("bucket", iceBucket({ becomes: "Hot!" }), 0)).toMatchObject({
			stored: false,
		});
		expect(automations.ownerPut("bucket", iceBucket({ field: "nowhere" }), 0)).toMatchObject({
			stored: false,
		});
		automations.ownerPut("bucket", iceBucket(), 0);
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
