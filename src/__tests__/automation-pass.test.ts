import { describe, expect, it } from "vitest";
import { type Fire, stepKey } from "../gateway/computed/automationFires.js";
import { createPass, type PassInput, type PassPorts } from "../gateway/computed/automationPass.js";
import type { AutomationEffect } from "../gateway/computed/automationRunner.js";
import type { State } from "../gateway/computed/automationState.js";
import { NO_SILENCES } from "../gateway/computed/sensorSilence.js";
import { AutomationSchema } from "../shared/schemasAutomation.js";

const action: AutomationEffect = { kind: "device_set", device: "plug", verb: "on" };
const body = AutomationSchema.parse({
	enabled: true,
	trigger: { kind: "value", field: "field", becomes: "on", coolDownSec: 0 },
	actions: [action],
});

const ports: PassPorts = {
	retireOf: () => null,
	stampOf: () => ({ body: "body", functions: [] }),
	enter: (fire, path) => ({ fire, first: path }),
	frameBody: () => null,
	bodyOf: () => body,
	actionOf: () => action,
	stepAt: () => action,
	kindAt: () => action.kind,
	unreadAt: () => false,
	noteAt: () => null,
	laneTold: () => false,
	errorAt: () => false,
	windowOf: () => 600_000,
	callAt: () => null,
	ready: () => true,
	sentenceOf: () => "automation",
	withMessage: (fields, messages, notes = []) => ({
		...fields,
		...(messages.length > 0 ? { message: messages.join("\n") } : {}),
		...(notes.length > 0 ? { note: notes.join("\n") } : {}),
	}),
};

const fireOf = (step: Fire["steps"][string]): Fire => ({
	member: "automation:0",
	automation: "automation",
	incarnation: "incarnation",
	revision: 1,
	seq: 0,
	at: 0,
	steps: { "0": step },
	active: step.claimed ? ["0"] : [],
});

const stateOf = (fire: Fire): State => ({
	automations: {},
	queue: { lastAt: 0, events: [] },
	log: { rows: [], standing: {} },
	ran: {},
	fires: [fire],
	fired: [],
	slots: {},
	silences: NO_SILENCES,
	versions: {},
	functionVersions: {},
	unusedFunctions: {},
	landedSets: {},
	firedAt: {},
	lastRuns: {},
	order: { next: 0, members: {} },
});

const inputOf = (fire: Fire, overrides: Partial<PassInput> = {}): PassInput => ({
	state: stateOf(fire),
	now: 1,
	home: true,
	recover: false,
	answers: new Map(),
	inFlight: () => false,
	busy: { free: 1, devices: new Set(), read: false },
	...overrides,
});

describe("automation pass", () => {
	it("claims the effect whose turn came", () => {
		const fire = fireOf({ attempts: 0 });

		const result = createPass(ports).pass(inputOf(fire));

		expect(result.effects).toEqual([{ member: fire.member, path: "0" }]);
		expect(result.next.fires[0]?.steps["0"]?.claimed).toBe(true);
	});

	it("lands a completed answer, logs its step, and keeps the run as its automation's last", () => {
		const fire = fireOf({ attempts: 1, startedAt: 0, lastAt: 0, claimed: true });
		const ref = { member: fire.member, path: "0" };
		const answers = new Map([[stepKey(ref), { ref, rows: [], attempt: { word: "done" as const } }]]);

		const result = createPass(ports).pass(inputOf(fire, { answers }));

		expect(result.next.fires).toEqual([]);
		expect(result.next.log.rows.at(-1)).toMatchObject({
			kind: "step",
			outcome: "ran",
			action: "device_set",
			step: "0",
		});
		expect(result.next.lastRuns.automation?.run).toEqual({
			at: 0,
			revision: 1,
			steps: [{ path: "0", kind: "device_set", outcome: "ran", startMs: 0, endMs: 1 }],
			running: false,
		});
	});

	it("keeps the later run of two fired at one instant, whichever ends first", () => {
		const step = { attempts: 1, startedAt: 0, lastAt: 0, claimed: true as const };
		const older = { ...fireOf(step), member: "automation:older" };
		const newer = { ...fireOf(step), member: "automation:newer" };
		const answers = new Map(
			[newer].map((fire) => {
				const ref = { member: fire.member, path: "0" };
				return [stepKey(ref), { ref, rows: [], attempt: { word: "done" as const } }];
			}),
		);
		const state = {
			...stateOf(older),
			fires: [older, newer],
			order: { next: 2, members: { [older.member]: 0, [newer.member]: 1 } },
		};

		const first = createPass(ports).pass({ ...inputOf(older, { answers }), state });
		const second = createPass(ports).pass({ ...inputOf(older), state: first.next });

		expect([first.next.lastRuns.automation?.member, second.next.lastRuns.automation?.member]).toEqual([
			"automation:newer",
			"automation:newer",
		]);
	});

	it("lets a later admission replace a run whose fire is gone, at the same instant", () => {
		const step = { attempts: 1, startedAt: 0, lastAt: 0, claimed: true as const };
		const later = { ...fireOf(step), member: "automation:later" };
		const ref = { member: later.member, path: "0" };
		const answers = new Map([[stepKey(ref), { ref, rows: [], attempt: { word: "done" as const } }]]);
		const gone = {
			member: "automation:gone",
			incarnation: "incarnation",
			order: 0,
			stamp: { body: "body", functions: [] },
			run: {
				at: 0,
				revision: 1,
				steps: [{ path: "0", kind: "device_set", outcome: "ran" as const }],
				running: false,
			},
		};
		const state = {
			...stateOf(later),
			lastRuns: { automation: gone },
			order: { next: 2, members: { [later.member]: 1 } },
		};

		const result = createPass(ports).pass({ ...inputOf(later, { answers }), state });

		expect(result.next.lastRuns.automation?.member).toBe("automation:later");
	});

	it("leaves a ready effect unclaimed while one is busy", () => {
		const fire = fireOf({ attempts: 0 });

		const result = createPass(ports).pass(inputOf(fire, { busy: { free: 0, devices: new Set(), read: false } }));

		expect(result.effects).toEqual([]);
		expect(result.next.fires[0]?.steps["0"]?.claimed).toBeUndefined();
	});
});
