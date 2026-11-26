import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInboxListing } from "../gateway/assistant/inboxListing.js";
import { createOutboxSource } from "../gateway/assistant/outboxSource.js";
import { PollAnswerSchema, told } from "../gateway/assistant/source.js";
import { memberKey } from "../gateway/assistant/sourceLane.js";
import { FRESH_STATE, type SourceState } from "../gateway/assistant/sourceState.js";
import { openAutomationPair } from "../gateway/compose/composeAutomations.js";
import type { Attempt } from "../gateway/computed/automationRunner.js";
import { versionKey } from "../gateway/computed/automationState.js";
import {
	BACKOFF_MAX_MS,
	BACKOFF_MIN_MS,
	type createAutomations,
	KEEP_TRYING_MS,
	NEWER_SET,
	SWITCHED_OFF,
	WAITING_EVENTS_MAX,
} from "../gateway/computed/automations.js";
import { type ComputedField, createComputedFields } from "../gateway/computed/computedFields.js";
import { fillHoles, holesOver } from "../gateway/liveConsole/holes.js";
import { createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import { openDurable } from "../shared/durable-store.js";
import { type FieldRef, known, refKey, unknown, type Value } from "../shared/expressions.js";
import {
	AUTOMATIONS_MAX,
	type Automation,
	type AutomationInput,
	AutomationSchema,
	type ValueTrigger,
} from "../shared/schemasAutomation.js";
import { unreadText } from "../shared/text-holes.js";

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

/** A test body as a writer builds it. */
const parsed = (input: AutomationInput): Automation => AutomationSchema.parse(input);

const iceBucket = (over: Partial<AutomationInput> & Partial<ValueTrigger> = {}): AutomationInput => {
	const { field = "band", becomes = "high", coolDownSec = 0, kind: _kind, ...rest } = over;
	return {
		label: "Throw ice bucket!",
		enabled: true,
		trigger: { kind: "value", field, becomes, coolDownSec },
		actions: [{ kind: "tell_assistant", when: "quietly" }],
		...rest,
	};
};

function world(dir: string, home = true) {
	const readings = new Map<string, Value>([[TEMP, known(-18)]]);
	let clock = 1_000;
	/** Added on every read of the clock. */
	let drift = 0;
	let n = 0;
	let pokes = 0;
	let failing = 0;
	const effects: string[] = [];
	let switches = ["plug"];
	let readable = true;
	/** The next hole reader throws. */
	let holesThrow = false;
	let broken = false;
	/** Fills wait on it. */
	let fillGate: Promise<void> = Promise.resolve();
	let iftttReady = true;
	/** An Error is thrown. */
	let iftttAnswer: Attempt | Error = { word: "refused" };
	/** By `device:verb`. */
	let deviceAnswer: (effect: string) => Attempt = () => ({ word: "done" });
	/** Effects wait on it. */
	let gate: Promise<void> = Promise.resolve();
	/** Only this effect waits; null: all. */
	let gated: string | null = null;
	const open = () => {
		const pair = openAutomationPair({
			dataDir: dir,
			newIncarnation: () => `a${++n}`,
			now: () => {
				clock += drift;
				return clock;
			},
			input: (ref) => ({ type: NUMBER, value: readings.get(refKey(ref)) ?? unknown("not heard") }),
			opened: (name, state) => {
				if (name !== "automation-state") return;
				const save = state.saveChecked.bind(state);
				state.saveChecked = (value: unknown) => {
					if (failing > 0) {
						failing--;
						throw new Error("disk full");
					}
					save(value);
				};
			},
			automations: {
				isHome: () => home,
				onQueued: () => pokes++,
				eventIssue: (trigger) => (trigger.source === "github" ? null : "no such source"),
				eventFields: (source) => (source === "github" ? ["reason", "repo"] : null),
				entropy: (size) => crypto.randomBytes(size),
				holes: () => {
					if (holesThrow) {
						holesThrow = false;
						throw new Error("holes broke");
					}
					return readable
						? {
								...holesOver(REGISTRY),
								fill: async (text, names) => {
									await fillGate;
									if (broken) throw new Error("fill broke");
									return fillHoles(text, names, REGISTRY);
								},
							}
						: undefined;
				},
				actions: {
					ready: (action) => action.kind !== "ifttt_trigger" || iftttReady,
					switchName: (device) => (switches.includes(device) ? "Heater" : null),
					deviceSet: async (device, verb) => {
						effects.push(`${device}:${verb}`);
						if (gated === null || gated === `${device}:${verb}`) await gate;
						return deviceAnswer(`${device}:${verb}`);
					},
					iftttTrigger: async ({ event, value1 }) => {
						const sent = value1 === undefined ? `ifttt:${event}` : `ifttt:${event}:${value1}`;
						effects.push(sent);
						if (gated === sent) await gate;
						if (iftttAnswer instanceof Error) throw iftttAnswer;
						return iftttAnswer;
					},
				},
			},
		});
		pair.fields.start();
		return pair;
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
	const plugIn = (device: string) => {
		switches = [...switches, device];
	};
	/** No hole reader. */
	const unreadable = () => {
		readable = false;
	};
	const breakHolesOnce = () => {
		holesThrow = true;
	};
	/** Fills throw. */
	const breakFills = () => {
		broken = true;
	};
	/** Fills wait until released. */
	const holdFills = () => {
		let release = () => {};
		fillGate = new Promise((resolve) => {
			release = resolve;
		});
		return () => release();
	};
	const setHome = (next: boolean) => {
		home = next;
	};
	const setIftttReady = (ready: boolean) => {
		iftttReady = ready;
	};
	const answerIfttt = (answer: Attempt | Error) => {
		iftttAnswer = answer;
	};
	const answerDevices = (answer: (effect: string) => Attempt) => {
		deviceAnswer = answer;
	};
	const advance = (ms: number) => {
		clock += ms;
	};
	const driftEachRead = (ms: number) => {
		drift = ms;
	};
	return {
		advance,
		driftEachRead,
		open,
		read,
		missed,
		unheard,
		failWrites,
		pokes: () => pokes,
		effects,
		holdEffects,
		unplug,
		plugIn,
		unreadable,
		breakHolesOnce,
		breakFills,
		holdFills,
		setHome,
		setIftttReady,
		answerIfttt,
		answerDevices,
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
		const review = (over: Partial<AutomationInput> = {}): AutomationInput => ({
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
		expect(automations.log().map((run) => run.outcome)).toEqual(["ran", "ran"]);
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
		expect(a.automations.log().map((run) => run.outcome)).toEqual(["ran", "suppressed"]);

		const away = world(fresh(), false);
		const b = away.open();
		b.fields.put("band", hotBand, 0);
		b.automations.ownerPut("bucket", iceBucket(), 0);
		away.read(b.fields, -5);
		away.read(b.fields, -15);
		away.read(b.fields, -5);
		expect(b.automations.log()).toMatchObject([
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
		expect(automations.log().map((run) => run.outcome)).toEqual(["refused"]);

		automations.clear(old);
		expect(await queued(automations)).toEqual(["high"]);
		expect(automations.log().map((run) => run.outcome)).toEqual(["refused", "ran"]);
	});

	it("gives up a tell that found no room once its automation's window has passed, though room came first", async () => {
		const dir = fresh();
		const old = fullQueue(dir, "now");
		const w = world(dir);
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut("bucket", { ...iceBucket(), keepTryingMin: 1 }, 0);
		w.read(fields, -5);
		w.advance(61_000);
		automations.clear(old);

		expect(await queued(automations)).toEqual([]);
		expect(automations.log().map((run) => [run.action, run.outcome])).toEqual([
			["tell_assistant", "refused"],
			["tell_assistant", "refused"],
		]);
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
		expect(automations.log().map((run) => run.outcome)).toEqual(["ran", "suppressed"]);
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
		const urgent = { ...iceBucket(), actions: [{ kind: "tell_assistant", when: "now" }] } as AutomationInput;
		automations.ownerPut("bucket", urgent, 0);
		automations.ownerPut("pail", { ...urgent, label: "Pail" }, 0);
		// Held, so their rows stay.
		for (const owner of ["alpha", "beta"]) automations.ownerPut(owner, { ...urgent, enabled: false }, 0);
		w.read(fields, -5);

		const ids = automations.outbox.events().map((event) => event.id);
		expect([old[0]?.member, old[128]?.member].map((member) => ids.includes(member as string))).toEqual([
			false,
			false,
		]);
		expect(ids).toHaveLength(256);
		expect(
			automations
				.log()
				.filter((run) => run.outcome === "suppressed")
				.map((run) => run.automation),
		).toEqual(["alpha", "beta"]);
	});

	it("runs a fire's effects whatever the outbox holds, and tells each tell on its own once there is room", async () => {
		const dir = fresh();
		const old = fullQueue(dir, "now");
		const w = world(dir);
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		const long = "x".repeat(600);
		const heat: AutomationInput = {
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
		const waiting = automations.log().map((run) => `${run.action} ${run.outcome}`);
		automations.clear(old);
		await automations.settled();
		const answer = await polled(automations);
		const told = answer.kind === "events" ? answer.events : [];

		expect(w.effects).toEqual(["plug:on"]);
		expect(waiting.toSorted()).toEqual(["device_set ran", "tell_assistant refused"]);
		expect(told.map((event) => [event.fields.value, event.fields.message?.length, event.tell])).toEqual([
			["high", 605, "now"],
			["high", 600, "quietly"],
		]);
	});

	it("runs an effect held across a long downtime, its time starting again, and tells after it", async () => {
		const dir = fresh();
		const old = fullQueue(dir, "now");
		const w = world(dir);
		const before = w.open();
		before.fields.put("band", hotBand, 0);
		const bell: AutomationInput = {
			...iceBucket(),
			actions: [
				{ kind: "ifttt_trigger", event: "freezer" },
				{ kind: "tell_assistant", when: "now" },
			],
		};
		before.automations.ownerPut("bell", bell, 0, true);
		w.setIftttReady(false);
		w.read(before.fields, -5);
		await before.automations.settled();
		w.setIftttReady(true);
		w.answerIfttt({ word: "done" });
		w.advance(3 * 60 * 60_000);

		const after = w.open().automations;
		after.clear(old);
		await after.settled();

		expect(w.effects).toEqual(["ifttt:freezer"]);
		expect(after.log().map((run) => [run.action, run.outcome])).toEqual([
			["ifttt_trigger", "ran"],
			["tell_assistant", "ran"],
		]);
		expect(await queued(after)).toEqual(["high"]);
	});

	it("drops a waiting fire once its automation is switched off, and starts no run after a stop", async () => {
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
		const edited = automations.log().map((run) => [run.outcome, run.reason]);

		const stopped = world(fresh());
		const later = stopped.open();
		later.fields.put("band", hotBand, 0);
		later.automations.ownerPut("heat", heat, 0);
		await later.automations.stop();
		stopped.read(later.fields, -5);
		const idle = [...stopped.effects];
		await stopped.open().automations.settled();

		expect(w.effects).toEqual(["plug:on"]);
		expect(edited).toEqual([["suppressed", SWITCHED_OFF]]);
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

		const outcomes = automations.log().map((run) => run.outcome);
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

	it("drops a deleted automation's queued tells and keeps an edited one's", () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut("bucket", iceBucket(), 0);
		automations.ownerPut("pail", { ...iceBucket(), label: "Pail" }, 0);
		w.read(fields, -5);
		const titles = () => automations.outbox.events().map((event) => event.title);
		const both = titles();

		automations.ownerPut("pail", { ...iceBucket(), label: "Pail", enabled: false }, 1);
		automations.ownerRemove("bucket", 1);

		expect(both).toEqual(["Throw ice bucket!", "Pail"]);
		expect(titles()).toEqual(["Pail"]);
	});

	it("neither lists nor keeps a queued entry past its retention", () => {
		const dir = fresh();
		const old = { member: "automation:old:a0:1", at: 1_000, body: { title: "Old", fields: {} } };
		const state = { automations: {}, queue: { lastAt: 1_000, events: [old] }, log: [] };
		fs.writeFileSync(path.join(dir, "automation-state.json"), JSON.stringify(state));
		const w = world(dir);
		const first = w.open().automations;
		const before = first.outbox.events().length;

		w.advance(7 * 24 * 60 * 60_000);
		const listed = first.outbox.events().length;
		const restarted = w.open().automations;

		expect([before, listed, restarted.queued().events.length]).toEqual([1, 0, 0]);
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
		const event = (source = "github"): Automation =>
			parsed({
				enabled: true,
				trigger: { kind: "event", source, conditions: [] },
				actions: [{ kind: "tell_assistant", when: "now" }],
			});
		const ids = () => automations.list().map((record) => record.id);
		automations.ownerPut("bucket", iceBucket(), 0);
		automations.write({ kind: "carry", rows: [{ id: "old", automation: event() }], functions: [] });
		const many = Array.from({ length: AUTOMATIONS_MAX }, (_, at) => ({ id: `e${at}`, automation: event() }));

		const over = automations.write({ kind: "carry", rows: many, functions: [] });
		const taken = automations.write({
			kind: "carry",
			rows: [{ id: "bucket", automation: event() }],
			functions: [],
		});
		const kept = ids();
		const fits = automations.write({
			kind: "carry",
			rows: [
				...many.slice(2),
				{ id: "elsewhere", automation: event("gmail") },
				{ id: "local", automation: parsed(iceBucket()) },
			],
			functions: [],
		});

		expect([over.written, taken.written]).toEqual([false, false]);
		expect(kept).toEqual(["bucket", "old"]);
		expect(fits).toMatchObject({ written: true, dropped: [{ id: "local", why: "not_event" }] });
		expect(ids()).toEqual(["bucket", ...many.slice(2).map((row) => row.id), "elsewhere"]);
		expect(automations.invalidOf("elsewhere")).not.toBeNull();
		expect(automations.eventsOf("gmail")).toEqual([]);
	});

	it("converts only a sensor's own stored alerts, creating none, and keeps an event automation to the home", () => {
		const home = world(fresh()).open();
		home.fields.put("band", hotBand, 0);
		const away = world(fresh(), false).open();
		away.fields.put("band", hotBand, 0);
		const event: AutomationInput = {
			enabled: true,
			trigger: { kind: "event", source: "github", conditions: [] },
			actions: [{ kind: "tell_assistant", when: "now" }],
		};
		const alert = (...ids: string[]) => new Map(ids.map((id) => [id, parsed(iceBucket())]));
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

	it("logs an effect that throws as uncertain, keeping none of the thrown message", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut("door", { ...iceBucket(), actions: [{ kind: "ifttt_trigger", event: "door" }] }, 0, true);
		w.answerIfttt(new Error("POST https://maker.ifttt.com/trigger/door/with/key/sk-secret-0042 failed"));

		w.read(fields, -5);
		await automations.settled();

		expect(automations.log().map((run) => run.outcome)).toEqual(["uncertain"]);
		expect(JSON.stringify(automations.log())).not.toContain("sk-secret");
	});

	it("runs a crossing's effects in order once it fires, logs each, and asks before a save adds a dangerous one", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		const heat: AutomationInput = {
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
		expect(automations.log().map((run) => [run.action, run.outcome])).toEqual([
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
		const replaced = automations.log().map((run) => run.outcome);
		automations.ownerPut("bucket", iceBucket(), 0);
		cross(80);
		release();
		await automations.settled();

		expect(replaced).toEqual(["suppressed"]);
		expect(w.effects).toEqual(["plug:on", "plug:on"]);
		expect(await queued(automations)).toHaveLength(80);
	});

	it("caps a flood of one automation's events behind its run, never refusing another automation's", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		// Another switch, so no newer set outdates the heater.
		w.plugIn("fan");
		automations.ownerPut(
			"flash",
			{
				enabled: true,
				trigger: { kind: "event", source: "github", conditions: [] },
				actions: [{ kind: "device_set", device: "fan", verb: "toggle" }],
			},
			0,
			true,
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
		const crowded = automations.log().map(({ automation, outcome }) => [automation, outcome]);
		release();
		await automations.settled();

		expect(crowded).toEqual([["flash", "suppressed"]]);
		expect([w.effects.filter((at) => at === "fan:toggle").length, w.effects.at(-1)]).toEqual([
			WAITING_EVENTS_MAX,
			"plug:on",
		]);
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
		const unready = [[...w.effects], automations.log().map((run) => run.automation)];
		w.setIftttReady(true);
		automations.tick();
		await automations.settled();
		automations.tick();
		await automations.settled();

		expect(unready).toEqual([["plug:on"], ["heat"]]);
		expect(w.effects).toEqual(["plug:on", "ifttt:freezer"]);
	});

	const bell: AutomationInput = {
		...iceBucket(),
		actions: [
			{ kind: "device_set", device: "plug", verb: "on" },
			{ kind: "ifttt_trigger", event: "freezer" },
			{ kind: "tell_assistant", when: "now" },
		],
	};
	const ifttt = (automations: ReturnType<typeof createAutomations>) =>
		automations
			.log()
			.filter((run) => run.action === "ifttt_trigger")
			.map((run) => run.outcome);

	it("runs a fire's plug while its unready effect holds and its tell waits behind, ends the effect past its own time and then tells, and gives it a full time from when its turn came", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut("bell", bell, 0, true);
		w.setIftttReady(false);
		w.read(fields, -5);
		await automations.settled();
		const held = [[...w.effects], (await queued(automations)).length, ifttt(automations)];
		w.advance(KEEP_TRYING_MS);
		automations.tick();
		await automations.settled();
		const toldAfter = (await queued(automations)).length;

		const afterQueue = async (first: Attempt) => {
			const queues = world(fresh());
			const b = queues.open();
			b.fields.put("band", hotBand, 0);
			b.automations.ownerPut("bell", bell, 0, true);
			queues.setIftttReady(false);
			queues.answerIfttt(first);
			const release = queues.holdEffects();
			queues.read(b.fields, -5);
			queues.setIftttReady(true);
			queues.advance(KEEP_TRYING_MS + 1);
			b.automations.tick();
			release();
			await b.automations.settled();
			queues.answerIfttt({ word: "done" });
			queues.advance(BACKOFF_MIN_MS);
			b.automations.tick();
			await b.automations.settled();
			return [queues.effects, ifttt(b.automations)];
		};

		expect(held).toEqual([["plug:on"], 0, []]);
		expect(w.effects).toEqual(["plug:on"]);
		expect([ifttt(automations), toldAfter]).toEqual([["refused"], 1]);
		expect(await afterQueue({ word: "done" })).toEqual([["plug:on", "ifttt:freezer"], ["ran"]]);
		expect(await afterQueue({ hold: "not_ready" })).toEqual([
			["plug:on", "ifttt:freezer", "ifttt:freezer"],
			["ran"],
		]);
	});

	it("keeps a held effect's retry gap while its port flaps, and ends it once its own time has passed", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut("door", { ...iceBucket(), actions: [{ kind: "ifttt_trigger", event: "door" }] }, 0, true);
		w.answerIfttt({ hold: "not_ready" });
		w.read(fields, -5);
		await automations.settled();
		const flap = async (ms: number) => {
			w.setIftttReady(false);
			w.advance(1);
			automations.tick();
			await automations.settled();
			w.setIftttReady(true);
			w.advance(ms - 1);
			automations.tick();
			await automations.settled();
			return w.effects.length;
		};

		const attempts = [await flap(1_000), await flap(BACKOFF_MIN_MS), await flap(KEEP_TRYING_MS)];

		expect(attempts).toEqual([1, 2, 2]);
		expect(ifttt(automations)).toEqual(["refused"]);
	});

	it("retries an effect that sent nothing after its plug while its tell waits behind, holds no retry for a clock stepped back, and ends it once its time has passed", async () => {
		const sends = world(fresh());
		const a = sends.open();
		a.fields.put("band", hotBand, 0);
		a.automations.ownerPut("bell", bell, 0, true);
		sends.answerIfttt({ hold: "not_ready" });
		sends.read(a.fields, -5);
		await a.automations.settled();
		const first = [[...sends.effects], (await queued(a.automations)).length, ifttt(a.automations)];
		a.automations.tick();
		await a.automations.settled();
		const resting = [...sends.effects];
		sends.answerIfttt({ word: "done" });
		sends.advance(-60 * 60_000);
		a.automations.tick();
		await a.automations.settled();

		const lapses = world(fresh());
		const b = lapses.open();
		b.fields.put("band", hotBand, 0);
		b.automations.ownerPut("bell", bell, 0, true);
		lapses.answerIfttt({ hold: "not_ready" });
		lapses.read(b.fields, -5);
		await b.automations.settled();
		for (const step of [BACKOFF_MIN_MS, KEEP_TRYING_MS]) {
			lapses.advance(step);
			b.automations.tick();
			await b.automations.settled();
		}

		expect(first).toEqual([["plug:on", "ifttt:freezer"], 0, []]);
		expect(resting).toEqual(["plug:on", "ifttt:freezer"]);
		expect([sends.effects, ifttt(a.automations)]).toEqual([["plug:on", "ifttt:freezer", "ifttt:freezer"], ["ran"]]);
		expect((await queued(a.automations)).length).toBe(1);
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
			true,
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
		expect(automations.log().filter((run) => run.outcome === "suppressed")).toEqual([]);
	});

	it("away from the home, switches its plug, refuses unsent an action that needs the home, and logs each standing refusal once", async () => {
		const w = world(fresh(), false);
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		const heat: AutomationInput = {
			...iceBucket(),
			actions: [
				{ kind: "ifttt_trigger", event: "freezer" },
				{ kind: "device_set", device: "plug", verb: "on" },
			],
		};
		const alert: AutomationInput = {
			...iceBucket(),
			actions: [
				{ kind: "tell_assistant", when: "now" },
				{ kind: "ifttt_trigger", event: "freezer" },
			],
		};
		automations.ownerPut("heat", heat, 0, true);
		w.read(fields, -5);
		await automations.settled();
		const first = automations.log().map((run) => [run.action, run.outcome]);
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
				.log()
				.filter((run) => run.automation === "alert")
				.map((run) => [run.action, run.outcome]),
		).toEqual([
			["tell_assistant", "refused"],
			["ifttt_trigger", "refused"],
		]);
	});

	describe("a fire whose automation is edited while it runs", () => {
		const on = { kind: "device_set", device: "plug", verb: "on" } as const;
		const toggle = { kind: "device_set", device: "plug", verb: "toggle" } as const;
		const bell = { kind: "ifttt_trigger", event: "bell" } as const;

		it("finishes a started run on the body it fired with, and retires a waiting one, keeping each body pinned", async () => {
			const dir = fresh();
			const w = world(dir);
			const { fields, automations } = w.open();
			fields.put("band", hotBand, 0);
			automations.ownerPut("run", { ...iceBucket(), actions: [on, toggle] }, 0);
			const release = w.holdEffects("plug:on");
			w.read(fields, -5);
			w.read(fields, -15);
			w.read(fields, -5);
			const edited = automations.ownerPut("run", { ...iceBucket(), actions: [bell] }, 1, true);
			const stored = JSON.parse(fs.readFileSync(path.join(dir, "automation-state.json"), "utf8"));
			release();
			await automations.settled();

			expect(edited.stored).toBe(true);
			expect(
				stored.fires.every((held: Parameters<typeof versionKey>[0]) => versionKey(held) in stored.versions),
			).toBe(true);
			expect(w.effects).toEqual(["plug:on", "plug:toggle"]);
			expect(automations.log().map((run) => [run.action, run.outcome, run.reason])).toEqual([
				[undefined, "suppressed", "the automation changed"],
				["device_set", "ran", undefined],
				["device_set", "ran", undefined],
			]);
		});
	});

	describe("a fire whose automation is switched off while it runs", () => {
		const on = { kind: "device_set", device: "plug", verb: "on" } as const;
		const toggle = { kind: "device_set", device: "plug", verb: "toggle" } as const;
		const off = (actions: AutomationInput["actions"]) => ({ ...iceBucket(), actions, enabled: false });
		const offMidAttempt = (w: ReturnType<typeof world>) => {
			const { fields, automations } = w.open();
			fields.put("band", hotBand, 0);
			automations.ownerPut("run", { ...iceBucket(), actions: [on] }, 0);
			const release = w.holdEffects("plug:on");
			w.read(fields, -5);
			automations.ownerPut("run", off([on]), 1, true);
			return { automations, release };
		};

		it("ends an On a crash left out as no answer, never resumed, logging what ran", async () => {
			const dir = fresh();
			const w = world(dir);
			offMidAttempt(w);
			w.holdEffects("none");
			const after = w.open().automations;
			await after.settled();

			expect(w.effects).toEqual(["plug:on"]);
			expect(after.log().map((run) => [run.action, run.outcome])).toEqual([["device_set", "uncertain"]]);
		});

		it("ends an On that answered no answer as uncertain, not retried, once it was switched off", async () => {
			const w = world(fresh());
			w.answerDevices(() => ({ word: "no_answer" }));
			const { automations, release } = offMidAttempt(w);
			release();
			await automations.settled();
			w.advance(BACKOFF_MAX_MS);
			automations.tick();
			await automations.settled();

			expect(w.effects).toEqual(["plug:on"]);
			expect(automations.log().map((run) => [run.action, run.outcome])).toEqual([["device_set", "uncertain"]]);
		});

		describe("an On waiting to retry after no answer", () => {
			const waiting = (w: ReturnType<typeof world>, actions: AutomationInput["actions"]) => {
				const { fields, automations } = w.open();
				fields.put("band", hotBand, 0);
				automations.ownerPut("run", { ...iceBucket(), actions }, 0);
				w.answerDevices(() => ({ word: "no_answer" }));
				w.read(fields, -5);
				return automations;
			};
			const rows = (automations: ReturnType<ReturnType<typeof world>["open"]>["automations"]) =>
				automations.log().map((run) => [run.action, run.outcome]);

			it("ends with that word when its automation is switched off in the gap, then one row for the steps unreached", async () => {
				const alone = world(fresh());
				const one = waiting(alone, [on]);
				await one.settled();
				one.ownerPut("run", off([on]), 1, true);
				await one.settled();
				const pair = world(fresh());
				const two = waiting(pair, [on, toggle]);
				await two.settled();
				two.ownerPut("run", off([on, toggle]), 1, true);
				await two.settled();
				for (const [w, automations] of [
					[alone, one],
					[pair, two],
				] as const) {
					w.advance(BACKOFF_MAX_MS);
					automations.tick();
					await automations.settled();
				}

				expect([alone.effects, pair.effects]).toEqual([["plug:on"], ["plug:on"]]);
				expect(rows(one)).toEqual([["device_set", "uncertain"]]);
				expect(rows(two)).toEqual([
					["device_set", "uncertain"],
					[undefined, "suppressed"],
				]);
			});

			it("ends with that word when a restart finds its automation switched off in the gap", async () => {
				const dir = fresh();
				const w = world(dir);
				const before = waiting(w, [on]);
				await before.settled();
				w.failWrites(100);
				const edited = before.ownerPut("run", off([on]), 1, true);
				await before.settled();
				w.failWrites(0);
				const after = w.open().automations;
				await after.settled();

				expect(edited.stored).toBe(true);
				expect(w.effects).toEqual(["plug:on"]);
				expect(rows(after)).toEqual([["device_set", "uncertain"]]);
			});
		});

		it("logs one suppressed row for the steps a switch-off left unreached", async () => {
			const w = world(fresh());
			const { fields, automations } = w.open();
			fields.put("band", hotBand, 0);
			automations.ownerPut("run", { ...iceBucket(), actions: [on, toggle] }, 0);
			const release = w.holdEffects("plug:on");
			w.read(fields, -5);
			automations.ownerPut("run", off([on, toggle]), 1, true);
			release();
			await automations.settled();

			expect(w.effects).toEqual(["plug:on"]);
			expect(automations.log().map((run) => [run.action, run.outcome])).toEqual([
				["device_set", "ran"],
				[undefined, "suppressed"],
			]);
		});
	});

	it("pins and resumes a claimed On from a state written with no versions, its record unchanged", async () => {
		const dir = fresh();
		const w = world(dir);
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		automations.ownerPut(
			"heat",
			{ ...iceBucket(), actions: [{ kind: "device_set", device: "plug", verb: "on" }] },
			0,
		);
		w.holdEffects("plug:on");
		w.read(fields, -5);
		const file = path.join(dir, "automation-state.json");
		const { versions: _versions, ...live } = JSON.parse(fs.readFileSync(file, "utf8"));
		fs.writeFileSync(file, JSON.stringify(live));
		w.holdEffects("none");
		const after = w.open().automations;
		await after.settled();

		expect(live.fires[0].steps["0"].claimed).toBe(true);
		expect(w.effects).toEqual(["plug:on", "plug:on"]);
		expect(after.log().map((run) => [run.action, run.outcome])).toEqual([["device_set", "ran"]]);
	});

	it("never reruns a fire a graceful stop let land", async () => {
		const w = world(fresh());
		const before = w.open();
		before.fields.put("band", hotBand, 0);
		before.automations.ownerPut(
			"heat",
			{ ...iceBucket(), actions: [{ kind: "device_set", device: "plug", verb: "on" }] },
			0,
		);
		const release = w.holdEffects();
		w.read(before.fields, -5);
		const stopping = before.automations.stop();
		release();
		await stopping;
		const kept = w.open().automations;
		await kept.settled();

		expect(w.effects).toEqual(["plug:on"]);
		expect(kept.log().map((run) => run.outcome)).toEqual(["ran"]);
		expect(kept.lastRun("heat")).toMatchObject({ running: false, steps: [{ path: "0", outcome: "ran" }] });
	});

	describe("a run's steps", () => {
		const toggle = { kind: "device_set", device: "plug", verb: "toggle" } as const;
		const on = { kind: "device_set", device: "plug", verb: "on" } as const;
		const bell = { kind: "ifttt_trigger", event: "bell" } as const;
		const setUp = (actions: AutomationInput["actions"]) => {
			const w = world(fresh());
			const { fields, automations } = w.open();
			fields.put("band", hotBand, 0);
			automations.ownerPut("run", { ...iceBucket(), actions }, 0, true);
			return { w, fields, automations };
		};
		const pass = async (
			w: ReturnType<typeof world>,
			automations: ReturnType<typeof createAutomations>,
			ms: number,
		) => {
			for (let left = ms; left > 0; left -= 60_000) {
				w.advance(Math.min(60_000, left));
				automations.tick();
				await automations.settled();
			}
		};

		it("starts each step once the one above it ended, and carries on past one that failed", async () => {
			const { w, fields, automations } = setUp([toggle, bell]);
			w.answerDevices(() => ({ word: "no_answer" }));
			w.answerIfttt({ word: "done" });
			const release = w.holdEffects("plug:toggle");
			w.read(fields, -5);
			await vi.waitFor(() => expect(w.effects).toContain("plug:toggle"));
			const waiting = [...w.effects];
			release();
			await automations.settled();

			expect(waiting).toEqual(["plug:toggle"]);
			expect(w.effects).toEqual(["plug:toggle", "ifttt:bell"]);
			expect(automations.log().map((run) => `${run.action} ${run.outcome}`)).toEqual([
				"device_set uncertain",
				"ifttt_trigger ran",
			]);
		});

		it("gives each step its own time from when its turn came", async () => {
			const { w, fields, automations } = setUp([on, bell]);
			w.answerDevices(() => ({ word: "unreachable" }));
			w.answerIfttt({ word: "unreachable" });
			w.read(fields, -5);
			await automations.settled();
			await pass(w, automations, 8 * 60_000);
			w.answerDevices(() => ({ word: "done" }));
			await pass(w, automations, 60_000);
			await pass(w, automations, 8 * 60_000);
			const still = automations.log().map((run) => `${run.action} ${run.outcome}`);
			w.answerIfttt({ word: "done" });
			await pass(w, automations, 60_000);

			expect(still).toEqual(["device_set ran"]);
			expect(automations.log().map((run) => `${run.action} ${run.outcome}`)).toEqual([
				"device_set ran",
				"ifttt_trigger ran",
			]);
		});

		it("starts a second fire of one automation only once the first has ended", async () => {
			const { w, fields, automations } = setUp([on]);
			w.answerDevices(() => ({ word: "unreachable" }));
			w.read(fields, -5);
			await automations.settled();
			w.read(fields, -15);
			w.read(fields, -5);
			await pass(w, automations, 60_000);
			const behind = w.effects.length;
			w.answerDevices(() => ({ word: "done" }));
			await pass(w, automations, 60_000);
			await pass(w, automations, 60_000);

			expect(behind).toBe(2);
			expect(w.effects).toEqual(["plug:on", "plug:on", "plug:on", "plug:on"]);
			expect(automations.log().map((run) => run.outcome)).toEqual(["ran", "ran"]);
		});

		it("tells every event's message past its automation's waiting cap, dropping only the runs", async () => {
			const w = world(fresh());
			const { automations } = w.open();
			const event: Automation["trigger"] = { kind: "event", source: "github", conditions: [] };
			automations.ownerPut(
				"bell",
				{
					enabled: true,
					trigger: event,
					actions: [toggle, { kind: "tell_assistant", when: "quietly", message: "rang" }],
				},
				0,
				true,
			);
			const count = WAITING_EVENTS_MAX + 3;
			automations.fireEvents(
				Array.from({ length: count }, (_, at) => ({
					automation: "bell",
					key: memberKey("github", { id: String(at), at }),
					names: {},
				})),
				5_000,
			);
			await automations.settled();
			const answer = await polled(automations);

			expect(answer.kind === "events" ? answer.events.length : 0).toBe(count);
			expect(automations.log().filter((run) => run.outcome === "suppressed")).toHaveLength(1);
		});

		it("hands back a claim whose runner threw before sending, and sends its toggle once the throw clears", async () => {
			const { w, fields, automations } = setUp([toggle]);
			w.read(fields, -5);
			w.breakHolesOnce();
			await automations.settled();
			const unsent = [...w.effects];
			await pass(w, automations, 60_000);

			expect(unsent).toEqual([]);
			expect(w.effects).toEqual(["plug:toggle"]);
			expect(automations.log().map((run) => `${run.action} ${run.outcome}`)).toEqual(["device_set ran"]);
		});

		describe("two automations setting one switch", () => {
			const event: Automation["trigger"] = { kind: "event", source: "github", conditions: [] };
			const off = { kind: "device_set", device: "plug", verb: "off" } as const;
			const unanswered = async () => {
				const w = world(fresh());
				const { automations } = w.open();
				automations.ownerPut("light", { enabled: true, trigger: event, actions: [on] }, 0, true);
				automations.ownerPut("dark", { enabled: true, trigger: event, actions: [off] }, 0, true);
				w.answerDevices(() => ({ word: "unreachable" }));
				automations.fireEvents([{ automation: "light", key: "event:github:light", names: {} }], 5_000);
				await automations.settled();
				await pass(w, automations, 5 * 60_000);
				const dark = async () => {
					automations.fireEvents([{ automation: "dark", key: "event:github:dark", names: {} }], 305_000);
					await automations.settled();
				};
				return { w, automations, dark, sent: w.effects.length };
			};
			const rows = (automations: ReturnType<typeof createAutomations>) =>
				automations.log().map((run) => `${run.automation} ${run.outcome}`);

			it("ends an older On once a newer Off on the same switch lands first, and never sends it", async () => {
				const { w, automations, dark } = await unanswered();
				await dark();
				const sent = w.effects.length;
				w.answerDevices(() => ({ word: "done" }));
				w.advance(BACKOFF_MIN_MS);
				automations.tick();
				await automations.settled();
				await pass(w, automations, 2 * 60_000);

				expect(w.effects.slice(sent)).toEqual(["plug:off"]);
				expect(rows(automations)).toEqual(["dark ran", "light refused"]);
				expect(automations.log().at(-1)?.reason).toBe(NEWER_SET);
			});

			it("ends the older On even when the newer Off's automation is edited while its set is in flight", async () => {
				const { w, automations } = await unanswered();
				const release = w.holdEffects("plug:off");
				w.answerDevices((effect) => (effect === "plug:off" ? { word: "done" } : { word: "unreachable" }));
				automations.fireEvents([{ automation: "dark", key: "event:github:dark", names: {} }], 305_000);
				await vi.waitFor(() => expect(w.effects.at(-1)).toBe("plug:off"));
				const edited = automations.ownerPut(
					"dark",
					{ enabled: true, label: "Night", trigger: event, actions: [off] },
					1,
				);
				w.answerDevices(() => ({ word: "done" }));
				release();
				await automations.settled();
				await pass(w, automations, 2 * 60_000);

				expect(edited.stored).toBe(true);
				expect(w.effects.at(-1)).toBe("plug:off");
				expect(
					automations
						.log()
						.filter((run) => run.automation === "light")
						.map((run) => run.reason),
				).toEqual([NEWER_SET]);
			});

			it("runs both in order when the older On lands first", async () => {
				const { w, automations, dark, sent } = await unanswered();
				w.answerDevices(() => ({ word: "done" }));
				await pass(w, automations, 60_000);
				await dark();

				expect(w.effects.slice(sent)).toEqual(["plug:on", "plug:off"]);
				expect(rows(automations)).toEqual(["light ran", "dark ran"]);
			});

			it("runs both when two automations set the switch from one event", async () => {
				const w = world(fresh());
				const { automations } = w.open();
				automations.ownerPut("light", { enabled: true, trigger: event, actions: [on] }, 0, true);
				automations.ownerPut("dark", { enabled: true, trigger: event, actions: [off] }, 0, true);
				automations.fireEvents(
					[
						{ automation: "light", key: "event:github:1", names: {} },
						{ automation: "dark", key: "event:github:1", names: {} },
					],
					5_000,
				);
				await automations.settled();

				expect(w.effects).toEqual(["plug:on", "plug:off"]);
				expect(rows(automations)).toEqual(["light ran", "dark ran"]);
			});

			it("never lets a toggle outdate another automation's toggle that has not had its turn", async () => {
				const w = world(fresh());
				const { automations } = w.open();
				w.plugIn("heater");
				w.plugIn("lamp");
				const flip = { kind: "device_set", device: "lamp", verb: "toggle" } as const;
				const cold = { kind: "device_set", device: "heater", verb: "off" } as const;
				automations.ownerPut("night", { enabled: true, trigger: event, actions: [cold, flip] }, 0, true);
				automations.ownerPut("blink", { enabled: true, trigger: event, actions: [flip] }, 0, true);
				w.answerDevices((effect) => (effect === "heater:off" ? { word: "unreachable" } : { word: "done" }));
				automations.fireEvents([{ automation: "night", key: "event:github:night", names: {} }], 5_000);
				await automations.settled();
				automations.fireEvents([{ automation: "blink", key: "event:github:blink", names: {} }], 6_000);
				await automations.settled();
				w.answerDevices(() => ({ word: "done" }));
				await pass(w, automations, 60_000);

				expect(w.effects.filter((effect) => effect === "lamp:toggle")).toHaveLength(2);
				expect(automations.log().map((run) => run.outcome)).toEqual(["ran", "ran", "ran"]);
			});
		});

		it("lands an answer at the pass's own reading of the clock, so a clock that moves on every read keeps the gap", async () => {
			const { w, fields, automations } = setUp([on]);
			let answers = 0;
			// Then done, so a lost gap shows as a second send, never a spin.
			w.answerDevices(() => (++answers === 1 ? { word: "unreachable" } : { word: "done" }));
			w.driftEachRead(1);
			w.read(fields, -5);
			await automations.settled();
			automations.tick();
			await automations.settled();

			expect(w.effects).toEqual(["plug:on"]);
		});

		it("retries a step the moment its gap ends, not a millisecond before", async () => {
			const { w, fields, automations } = setUp([on]);
			let answers = 0;
			w.answerDevices(() => (++answers === 1 ? { word: "unreachable" } : { word: "done" }));
			w.read(fields, -5);
			await automations.settled();
			w.advance(BACKOFF_MIN_MS - 1);
			automations.tick();
			await automations.settled();
			const early = [...w.effects];
			w.advance(1);
			automations.tick();
			await automations.settled();

			expect([early, w.effects]).toEqual([["plug:on"], ["plug:on", "plug:on"]]);
		});

		const neverThrough = async (blocked: (w: ReturnType<typeof world>) => void) => {
			const w = world(fresh());
			const { automations } = w.open();
			automations.ownerPut(
				"bell",
				{ enabled: true, trigger: { kind: "interval", everyMin: 5 }, actions: [bell] },
				0,
				true,
			);
			blocked(w);
			for (let second = 0; second < 16 * 60; second += 3) {
				w.advance(3_000);
				automations.tick();
				await automations.settled();
			}
			const ended = automations.log().filter((run) => run.outcome === "refused");
			const replaced = automations.log().filter((run) => run.outcome === "suppressed");
			return {
				ended: ended.map((run) => run.action),
				replacedIt: replaced.filter((run) => run.at === ended[0]?.at),
			};
		};

		it("keeps a holding run whose turn began through newer fires of its clock, and ends it unreachable at its time", async () => {
			const held = await neverThrough((w) => w.answerIfttt({ hold: "not_ready" }));
			const unready = await neverThrough((w) => w.setIftttReady(false));

			expect(held).toEqual({ ended: ["ifttt_trigger"], replacedIt: [] });
			expect(unready).toEqual({ ended: ["ifttt_trigger"], replacedIt: [] });
		});

		it("finishes a run held on an unreachable plug behind 64 newer fires of other automations, and logs it ran once answered", async () => {
			const w = world(fresh());
			const { automations } = w.open();
			const event: Automation["trigger"] = { kind: "event", source: "github", conditions: [] };
			automations.ownerPut("held", { enabled: true, trigger: event, actions: [on] }, 0, true);
			// Another switch, so no newer set outdates the held one.
			w.plugIn("fan");
			const flip = { kind: "device_set", device: "fan", verb: "toggle" } as const;
			const others = Array.from({ length: 9 }, (_, at) => `other${at}`);
			for (const id of others) {
				automations.ownerPut(id, { enabled: true, trigger: event, actions: [flip] }, 0, true);
			}
			const firing = (automation: string, at: number) => ({
				automation,
				key: memberKey("github", { id: `${automation}:${at}`, at }),
				names: {},
			});
			w.answerDevices((effect) => (effect === "plug:on" ? { word: "unreachable" } : { word: "done" }));
			automations.fireEvents([firing("held", 0)], 5_000);
			await automations.settled();
			const release = w.holdEffects("fan:toggle");
			automations.fireEvents(
				others.flatMap((id) => Array.from({ length: 8 }, (_, at) => firing(id, at))).slice(0, 64),
				6_000,
			);
			w.answerDevices(() => ({ word: "done" }));
			release();
			await pass(w, automations, 5 * 60_000);

			expect(
				automations
					.log()
					.filter((run) => run.automation === "held")
					.map((run) => run.outcome),
			).toEqual(["ran"]);
		});
	});

	describe("a stored state", () => {
		it("carries on the fires an 8.14.84 build stored, its claimed step judged as a restart judges it", async () => {
			const dir = fresh();
			fs.cpSync(path.join(import.meta.dirname, "fixtures", "automation-state-8.14.84"), dir, { recursive: true });
			const w = world(dir);
			w.advance(10_000);
			w.answerIfttt({ word: "done" });
			const { automations } = w.open();
			await automations.settled();
			for (let at = 0; at < 4; at++) {
				automations.tick();
				await automations.settled();
			}

			expect(w.effects).toEqual(["plug:off", "ifttt:freezer", "plug:on", "plug:off", "ifttt:freezer"]);
			expect(
				automations
					.log()
					.filter((run) => run.seq === 1)
					.map((run) => `${run.action} ${run.outcome}`),
			).toEqual(["tell_assistant ran", "device_set ran", "device_set ran", "ifttt_trigger ran"]);
		});

		it("lists today's automations beside a stored function, counts the function in the one total, and keeps it as written", () => {
			const dir = fresh();
			fs.cpSync(path.join(import.meta.dirname, "fixtures", "automation-state-8.14.84"), dir, { recursive: true });
			const file = path.join(dir, "automations.json");
			const fn = {
				id: "warm-up",
				kind: "function",
				revision: 1,
				incarnation: "f1",
				body: {
					name: "Warm up",
					params: [],
					steps: [
						{
							kind: "do",
							action: "device_set",
							args: {
								device: { kind: "literal", value: "plug" },
								verb: { kind: "literal", value: "on" },
							},
						},
					],
				},
			};
			fs.writeFileSync(file, JSON.stringify([...JSON.parse(fs.readFileSync(file, "utf8")), fn]));
			const w = world(dir);
			const { fields, automations } = w.open();
			fields.put("band", hotBand, 0);

			const listed = automations.list().map((record) => record.id);
			const room = Array.from({ length: AUTOMATIONS_MAX - 2 }, (_, at) =>
				automations.ownerPut(`a${at}`, iceBucket(), 0),
			).every((put) => put.stored);
			const over = automations.ownerPut("over", iceBucket(), 0);

			expect([listed, room, over.stored]).toEqual([["heat"], true, false]);
			expect(
				JSON.parse(fs.readFileSync(file, "utf8")).find((row: { id: string }) => row.id === "warm-up"),
			).toEqual(fn);
		});

		it("refuses a pointer at a function it does not hold or one whose step it cannot run, and takes one it holds", () => {
			const dir = fresh();
			const fn = (id: string, action: string, args: object = {}) => ({
				id,
				kind: "function",
				revision: 1,
				incarnation: id,
				body: { name: id, params: [], steps: [{ kind: "do", action, args }] },
			});
			fs.writeFileSync(
				path.join(dir, "automations.json"),
				JSON.stringify([
					fn("tell", "tell_assistant", { when: { kind: "literal", value: "now" } }),
					fn("odd", "launch_rocket"),
				]),
			);
			const { automations } = world(dir).open();
			const pointing = (function_: string): AutomationInput => ({
				enabled: true,
				trigger: { kind: "event", source: "github", conditions: [] },
				actions: [{ kind: "run_function", function: function_ }],
			});

			expect(
				["gone", "odd", "tell"].map((id) => automations.ownerPut(`to-${id}`, pointing(id), 0).stored),
			).toEqual([false, false, true]);
		});

		const storedWith = (fires: (held: Record<string, unknown>[]) => unknown[]) => {
			const dir = fresh();
			fs.cpSync(path.join(import.meta.dirname, "fixtures", "automation-state-8.14.84"), dir, { recursive: true });
			const file = path.join(dir, "automation-state.json");
			const stored = JSON.parse(fs.readFileSync(file, "utf8"));
			stored.fires = fires(stored.fires);
			fs.writeFileSync(file, JSON.stringify(stored));
			return dir;
		};
		it("retires the fires of a state with no versions whose automation was edited since, sending nothing", async () => {
			const dir = storedWith((fires) => fires);
			const records = path.join(dir, "automations.json");
			const [held] = JSON.parse(fs.readFileSync(records, "utf8"));
			fs.writeFileSync(records, JSON.stringify([{ ...held, revision: 2 }]));
			const w = world(dir);
			w.advance(10_000);
			const { automations } = w.open();
			await automations.settled();

			expect(w.effects).toEqual([]);
			expect(
				automations
					.log()
					.filter((run) => run.outcome !== "ran")
					.map((run) => [run.seq, run.outcome]),
			).toEqual([
				[1, "uncertain"],
				[1, "suppressed"],
				[3, "suppressed"],
			]);
		});

		const uncertain = (automations: ReturnType<typeof createAutomations>) =>
			automations
				.log()
				.filter((run) => run.outcome === "uncertain")
				.map((run) => run.seq);

		it("drops a stored fire of a shape it cannot read, logging it uncertain once across two opens, and one with no automation not at all", async () => {
			const dir = storedWith(([first]) => [
				{ ...first, effects: { "0": "later" } },
				{ seq: 9, effects: {} },
			]);
			const w = world(dir);
			const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

			const once = uncertain(w.open().automations);
			const again = uncertain(w.open().automations);
			const drops = warned.mock.calls.filter(([line]) => String(line).includes("another shape")).length;
			warned.mockRestore();

			expect([once, again, drops]).toEqual([[1], [1], 1]);
		});

		it("never resends an IFTTT post an 8.14.84 build left claimed, and runs the next fire", async () => {
			const dir = storedWith(([first, second]) => [
				{ ...first, effects: { "0": "done", "1": "done", "2": "claimed" } },
				second,
			]);
			const w = world(dir);
			w.advance(10_000);
			w.answerIfttt({ word: "done" });
			const { automations } = w.open();
			for (let at = 0; at < 4; at++) {
				automations.tick();
				await automations.settled();
			}

			expect(w.effects).toEqual(["plug:on", "plug:off", "ifttt:freezer"]);
			expect(uncertain(automations)).toEqual([1]);
		});

		it("keeps a stored run whose first effect ran started, so a newer crossing waits behind it", async () => {
			const dir = storedWith(([first]) => [{ ...first, effects: { "0": "done", "1": "done", "2": "pending" } }]);
			const w = world(dir);
			w.advance(10_000);
			w.answerIfttt({ word: "done" });
			w.setIftttReady(false);
			const { fields, automations } = w.open();
			w.read(fields, -5);
			await automations.settled();
			w.setIftttReady(true);
			for (let at = 0; at < 4; at++) {
				automations.tick();
				await automations.settled();
			}

			expect(w.effects).toEqual(["ifttt:freezer", "plug:on", "plug:off", "ifttt:freezer"]);
		});
	});

	describe("a restart", () => {
		const crash = async (actions: AutomationInput["actions"], held: string, later: number, w = world(fresh())) => {
			const before = w.open();
			before.fields.put("band", hotBand, 0);
			before.automations.ownerPut("run", { ...iceBucket(), actions }, 0, true);
			w.answerIfttt({ word: "done" });
			w.holdEffects(held);
			w.read(before.fields, -5);
			await vi.waitFor(() => expect(w.effects).toContain(held));
			w.holdEffects("none");
			w.advance(later);
			const after = w.open().automations;
			await after.settled();
			return { w, after, outcomes: after.log().map((run) => `${run.action} ${run.outcome}`) };
		};
		const on = { kind: "device_set", device: "plug", verb: "on" } as const;
		const toggle = { kind: "device_set", device: "plug", verb: "toggle" } as const;
		const bell = { kind: "ifttt_trigger", event: "bell" } as const;

		it("ends a claimed toggle or IFTTT post with no answer, and runs the next step", async () => {
			const toggled = await crash([toggle, bell], "plug:toggle", 1_000);
			const posted = await crash([bell, toggle], "ifttt:bell", 1_000);

			expect([toggled.w.effects, toggled.outcomes]).toEqual([
				["plug:toggle", "ifttt:bell"],
				["device_set uncertain", "ifttt_trigger ran"],
			]);
			expect([posted.w.effects, posted.outcomes]).toEqual([
				["ifttt:bell", "plug:toggle"],
				["ifttt_trigger uncertain", "device_set ran"],
			]);
		});

		it("resumes a claimed On inside its time, and ends it past its time with a later step still run however late", async () => {
			const inside = await crash([on], "plug:on", 1_000);
			const past = await crash([on, bell], "plug:on", 3 * 60 * 60_000);

			expect([inside.w.effects, inside.outcomes]).toEqual([["plug:on", "plug:on"], ["device_set ran"]]);
			expect([past.w.effects, past.outcomes]).toEqual([
				["plug:on", "ifttt:bell"],
				["device_set refused", "ifttt_trigger ran"],
			]);
		});

		it("resumes a step between attempts inside its time whatever its nature, and ends it past", async () => {
			const between = async (later: number) => {
				const w = world(fresh());
				const before = w.open();
				before.fields.put("band", hotBand, 0);
				before.automations.ownerPut("run", { ...iceBucket(), actions: [bell] }, 0, true);
				w.answerIfttt({ word: "unreachable" });
				w.read(before.fields, -5);
				await before.automations.settled();
				w.answerIfttt({ word: "done" });
				w.advance(later);
				const after = w.open().automations;
				await after.settled();
				return [w.effects.length, after.log().map((run) => run.outcome)];
			};

			expect(await between(BACKOFF_MIN_MS)).toEqual([2, ["ran"]]);
			expect(await between(KEEP_TRYING_MS)).toEqual([1, ["refused"]]);
		});

		it("clamps a step started ahead of the clock, so its time restarts from the restart", async () => {
			const w = world(fresh());
			const before = w.open();
			before.fields.put("band", hotBand, 0);
			before.automations.ownerPut("run", { ...iceBucket(), actions: [bell] }, 0, true);
			w.answerIfttt({ word: "unreachable" });
			w.read(before.fields, -5);
			await before.automations.settled();
			w.advance(-60 * 60_000);
			const after = w.open().automations;
			await after.settled();
			w.advance(KEEP_TRYING_MS);
			after.tick();
			await after.settled();

			expect(after.log().map((run) => run.outcome)).toEqual(["refused"]);
		});

		it("gives a step that only held a full time after a long downtime", async () => {
			const w = world(fresh());
			const before = w.open();
			before.fields.put("band", hotBand, 0);
			before.automations.ownerPut("run", { ...iceBucket(), actions: [bell] }, 0, true);
			w.answerIfttt({ word: "done" });
			w.setIftttReady(false);
			w.read(before.fields, -5);
			await before.automations.settled();
			w.advance(3 * 60 * 60_000);
			const after = w.open().automations;
			for (let minute = 0; minute < 9; minute++) {
				w.advance(60_000);
				after.tick();
				await after.settled();
			}
			const waiting = after.log().length;
			w.setIftttReady(true);
			after.tick();
			await after.settled();

			expect(waiting).toBe(0);
			expect(after.log().map((run) => run.outcome)).toEqual(["ran"]);
		});
	});

	it("runs an event's effects once per member, again for later activity on it, and refuses an action whose switch this Gateway lacks", async () => {
		const w = world(fresh());
		const { automations } = w.open();
		const onMention: AutomationInput = {
			enabled: true,
			trigger: { kind: "event", source: "github", conditions: [] },
			actions: [{ kind: "device_set", device: "plug", verb: "toggle" }],
		};
		const elsewhere = { ...onMention, actions: [{ kind: "device_set", device: "lamp", verb: "on" }] };
		automations.ownerPut("flash", onMention, 0, true);
		const matched = (at: number) => [{ automation: "flash", key: memberKey("github", { id: "1", at }), names: {} }];

		automations.fireEvents(matched(1), 5_000);
		automations.fireEvents(matched(1), 6_000);
		automations.fireEvents(matched(2), 7_000);
		await automations.settled();
		const refused = automations.ownerPut("lamp", elsewhere, 0, true);
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
		expect(automations.log()).toEqual([]);
	});

	it("gives up a fill that throws: tells the message and sends the effect with their holes marked, logging each uncertain", async () => {
		const w = world(fresh());
		const { automations } = w.open();
		const event: Automation["trigger"] = { kind: "event", source: "github", conditions: [] };
		const message = "{event} on {source}";
		automations.ownerPut(
			"messaged",
			{ enabled: true, trigger: event, actions: [{ kind: "tell_assistant", when: "now", message }] },
			0,
		);
		automations.ownerPut(
			"flash",
			{ enabled: true, trigger: event, actions: [{ kind: "ifttt_trigger", event: "door", value1: message }] },
			0,
			true,
		);
		w.answerIfttt({ word: "done" });
		w.breakFills();

		const key = memberKey("github", { id: "7", at: 7 });
		automations.fireEvents(
			[
				{ automation: "messaged", key, names: {} },
				{ automation: "flash", key, names: {} },
			],
			5_000,
		);
		await automations.settled();
		const answer = await polled(automations);

		expect(answer.kind === "events" ? answer.events.map((told) => told.fields.message) : []).toEqual([
			unreadText(message),
		]);
		expect(w.effects).toEqual([`ifttt:door:${unreadText(message)}`]);
		expect(
			automations
				.log()
				.map((run) => `${run.automation} ${run.outcome}`)
				.toSorted(),
		).toEqual(["flash ran", "flash uncertain", "messaged ran", "messaged uncertain"]);
	});

	it("fills and tells a message while another automation's effect is in flight", async () => {
		const w = world(fresh());
		const { automations } = w.open();
		const event: Automation["trigger"] = { kind: "event", source: "github", conditions: [] };
		automations.ownerPut(
			"flash",
			{ enabled: true, trigger: event, actions: [{ kind: "device_set", device: "plug", verb: "toggle" }] },
			0,
			true,
		);
		automations.ownerPut(
			"messaged",
			{
				enabled: true,
				trigger: event,
				actions: [{ kind: "tell_assistant", when: "now", message: "{source} spoke" }],
			},
			0,
		);
		const messages = async () => {
			const answer = await polled(automations);
			return answer.kind === "events" ? answer.events.map((told) => told.fields.message) : [];
		};
		const release = w.holdEffects();

		const key = memberKey("github", { id: "7", at: 7 });
		automations.fireEvents([{ automation: "flash", key, names: {} }], 5_000);
		automations.fireEvents([{ automation: "messaged", key, names: { source: { value: "GitHub" } } }], 5_001);
		await vi.waitFor(async () => expect(await messages()).toEqual(["GitHub spoke"]));
		const during = automations.log().map((run) => run.automation);
		release();
		await automations.settled();

		expect(during).toEqual(["messaged"]);
		expect(w.effects).toEqual(["plug:toggle"]);
	});

	it("never puts back a tell the home's leaving refused while its message was being read", async () => {
		const w = world(fresh());
		const { fields, automations } = w.open();
		fields.put("band", hotBand, 0);
		const heat: AutomationInput = {
			...iceBucket(),
			actions: [
				{ kind: "device_set", device: "plug", verb: "on" },
				{ kind: "tell_assistant", when: "now", message: "It reads {value}" },
			],
		};
		automations.ownerPut("heat", heat, 0);
		const releasePlug = w.holdEffects();
		const releaseFill = w.holdFills();

		w.read(fields, -5);
		releasePlug();
		for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
		w.setHome(false);
		automations.tick();
		w.setHome(true);
		releaseFill();
		await automations.settled();

		expect(w.effects).toEqual(["plug:on"]);
		expect(await queued(automations)).toEqual([]);
		expect(
			automations
				.log()
				.filter((run) => run.action === "tell_assistant")
				.map((run) => run.outcome),
		).toEqual(["refused"]);
	});

	it("tells an event's message through the outbox with the event's names, and leaves only a tell with no message to the source's lane", async () => {
		const w = world(fresh());
		const { automations } = w.open();
		const event: Automation["trigger"] = { kind: "event", source: "github", conditions: [] };
		const messaged: AutomationInput = {
			enabled: true,
			trigger: event,
			actions: [{ kind: "tell_assistant", when: "now", message: "{event.reason} on {source}: {event}" }],
		};
		const plain: AutomationInput = {
			enabled: true,
			trigger: event,
			actions: [{ kind: "tell_assistant", when: "now" }],
		};
		const noted: AutomationInput = {
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
