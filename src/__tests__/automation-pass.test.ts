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
	enter: (fire) => fire,
	frameBody: () => null,
	bodyOf: () => body,
	actionOf: () => action,
	stepAt: () => action,
	kindAt: () => action.kind,
	writtenStep: () => null,
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
	log: [],
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
});

const inputOf = (fire: Fire, overrides: Partial<PassInput> = {}): PassInput => ({
	state: stateOf(fire),
	now: 1,
	home: true,
	recover: false,
	answers: new Map(),
	inFlight: () => false,
	busy: { effect: false, fill: false, read: false },
	...overrides,
});

describe("automation pass", () => {
	it("claims the effect whose turn came", () => {
		const fire = fireOf({ attempts: 0 });

		const result = createPass(ports).pass(inputOf(fire));

		expect(result.effect).toEqual({ member: fire.member, path: "0" });
		expect(result.next.fires[0]?.steps["0"]?.claimed).toBe(true);
	});

	it("lands a completed answer and logs its step", () => {
		const fire = fireOf({ attempts: 1, startedAt: 0, lastAt: 0, claimed: true });
		const ref = { member: fire.member, path: "0" };
		const answers = new Map([[stepKey(ref), { ref, rows: [], attempt: { word: "done" as const } }]]);

		const result = createPass(ports).pass(inputOf(fire, { answers }));

		expect(result.next.fires).toEqual([]);
		expect(result.next.log.at(-1)).toMatchObject({ outcome: "ran", action: "device_set", step: "0" });
	});

	it("leaves a ready effect unclaimed while one is busy", () => {
		const fire = fireOf({ attempts: 0 });

		const result = createPass(ports).pass(inputOf(fire, { busy: { effect: true, fill: false, read: false } }));

		expect(result.effect).toBeNull();
		expect(result.next.fires[0]?.steps["0"]?.claimed).toBeUndefined();
	});
});
