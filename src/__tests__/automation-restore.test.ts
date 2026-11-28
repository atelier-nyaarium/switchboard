import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAutomationPair } from "../gateway/compose/composeAutomations.js";
import { placeholdersOver } from "../gateway/liveConsole/placeholders.js";
import { createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import { createRestoreRepairs } from "../shared/durable-store.js";
import { unknown } from "../shared/expressions.js";

const REGISTRY = createConsoleRegistry([]);
const FIXTURES = path.join(import.meta.dirname, "..", "..", "tests", "fixtures", "automation-state");
const PLUG = "aa:bb:cc:dd:ee:01";
const FAN = "aa:bb:cc:dd:ee:02";
const SENSOR = "ce:1c:44:06:3c:5d";
/** What 8.14.87 reads of the state file. */
const FLAT_KEYS = ["automations", "queue", "log", "ran", "fires", "fired", "slots", "silences", "versions"];
/** What 8.14.87 reads of a fire. */
const FLAT_FIRE_KEYS = new Set([
	"member",
	"automation",
	"incarnation",
	"revision",
	"seq",
	"at",
	"names",
	"tell",
	"waiting",
	"steps",
	"active",
]);

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A copy of a fixture, opened by this build. */
function restored(fixture: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-restore-"));
	roots.push(dir);
	for (const name of ["automations.json", "automation-state.json"])
		fs.copyFileSync(path.join(FIXTURES, fixture, name), path.join(dir, name));
	let n = 0;
	const { automations } = openAutomationPair({
		repairs: createRestoreRepairs(),
		dataDir: dir,
		newIncarnation: () => `a${++n}`,
		now: () => 6_000_000,
		input: () => ({ type: { type: "number", integral: false }, value: unknown("not heard") }),
		automations: {
			isHome: () => true,
			eventIssue: () => null,
			eventFields: () => ["reason"],
			entropy: (size) => crypto.randomBytes(size),
			reading: (device) =>
				device === SENSOR
					? {
							label: "Freezer temperature",
							device: "Freezer",
							measure: "Temperature",
							shown: (value) => `${value} C`,
							inUnit: (value) => value,
							now: () => null,
						}
					: null,
			placeholders: () => placeholdersOver(REGISTRY),
			actions: {
				ready: () => true,
				deviceName: (device) => (device === PLUG ? "Lamp" : device === FAN ? "Fan" : null),
				deviceSet: async () => ({ word: "unreachable" }),
				iftttTrigger: async () => ({ word: "done" }),
			},
		},
	});
	const stored = () => JSON.parse(fs.readFileSync(path.join(dir, "automation-state.json"), "utf8"));
	return { automations, stored };
}

describe("a restore across builds", () => {
	it("reads 8.14.87's state of the five flat automations with nothing dropped, and tells the run it held", async () => {
		const { automations } = restored("flat-8.14.87");
		await automations.settled();

		expect(automations.list().map((record) => [record.id, automations.invalidOf(record.id)])).toEqual([
			["gh-mentions", null],
			["gh-reviews", null],
			["gh-assigned", null],
			["gh-ci", null],
			["freezer-cold", null],
		]);
		expect(automations.checkpoint("freezer-cold")).toEqual({
			revision: 1,
			incarnation: "inc-freezer",
			fieldEpoch: "epoch-1",
			handledSeq: 3,
			firedAt: 1_000_000,
		});
		expect(automations.log().filter((row) => row.outcome === "unsure")).toEqual([]);
		expect(automations.queued().events.map((event) => event.member)).toEqual([
			"automation:freezer-cold:inc-freezer:epoch-1:3",
		]);
	});

	it("keeps every key and fire an older reader reads beside a function's run, and resumes that run", async () => {
		const held = JSON.parse(fs.readFileSync(path.join(FIXTURES, "functions", "automation-state.json"), "utf8"));
		const flatFires = held.fires.filter((fire: { frames?: object }) => fire.frames === undefined);
		const { automations, stored } = restored("functions");
		await automations.settled();
		const after = stored();

		expect(FLAT_KEYS.filter((key) => !Object.hasOwn(held, key))).toEqual([]);
		expect(flatFires.map((fire: object) => Object.keys(fire).filter((key) => !FLAT_FIRE_KEYS.has(key)))).toEqual([
			[],
		]);
		expect(
			flatFires.every((fire: { steps: object }) => Object.keys(fire.steps).every((at) => /^\d+$/.test(at))),
		).toBe(true);
		expect(automations.log().filter((row) => row.outcome === "unsure" && row.automation === "warm")).toEqual([]);
		expect(after.fires.map((fire: { automation: string }) => fire.automation)).toEqual(["fan-on", "warm"]);
		expect(after.functionVersions).toEqual(held.functionVersions);
		expect(after.unusedFunctions).toEqual(held.unusedFunctions);
	});

	it("resumes a run it held in a block: every branch where it stood, and the block's end with what failed", async () => {
		const held = JSON.parse(fs.readFileSync(path.join(FIXTURES, "block", "automation-state.json"), "utf8"));
		const { automations, stored } = restored("block");
		await automations.settled();

		expect(held.fires[0].active).toEqual(["0.0.0.0", "0.0.0.1.0.0"]);
		expect(automations.log().map((row) => [row.step, row.action, row.outcome])).toEqual([
			["0.0.0.2", "throw", "failed"],
			["0.0.0.0", "device_set", "failed"],
			["0.0.0.1.0.1", "ifttt_trigger", "done"],
			["0.0", "parallel", "failed"],
			["0.1", "ifttt_trigger", "done"],
			["0", "run_function", "failed"],
		]);
		expect(stored().fires).toEqual([]);
	});
});
