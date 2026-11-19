import { describe, expect, it } from "vitest";
import {
	admit,
	FIRES_MAX,
	type Fire,
	mayRun,
	nextEffect,
	outdatedSets,
	readFire,
} from "../gateway/computed/automationFires.js";
import { type AutomationRun, fireRun, logged, REPLACED } from "../gateway/computed/automationLog.js";
import { QUEUE_MAX_EVENTS, roomFor } from "../gateway/computed/automationOutbox.js";
import type { AutomationEffect } from "../gateway/computed/automationRunner.js";
import {
	begun,
	dueAt,
	KEEP_TRYING_MS,
	type Nature,
	recovered,
	type Step,
} from "../gateway/computed/automationSteps.js";

const fire = (automation: string, at: number, steps: Fire["steps"] = { "0": { attempts: 0 } }): Fire => ({
	member: `${automation}:${at}`,
	automation,
	incarnation: "i",
	revision: 1,
	seq: 0,
	at,
	steps,
	active: [],
});
const retrying = { "0": { attempts: 1, startedAt: 0, lastAt: 0, word: "unreachable" as const } };
const running = (automation: string, at: number): Fire => ({ ...fire(automation, at, retrying), active: ["0"] });
const others = (count: number) => Array.from({ length: count }, (_, n) => fire(`a${n}`, 100 + n));
const rule = { supersede: false, earlier: () => false };
const members = (fires: readonly Fire[]) => fires.map((held) => held.member);

describe("admission past the bound", () => {
	it("refuses a newcomer when no automation holds more than it would", () => {
		const held = others(FIRES_MAX);

		const answer = admit(held, fire("late", 999), rule);

		expect(answer.admitted).toBe(false);
		expect(answer.fires).toEqual(held);
	});

	it("gives up the largest holder's oldest fire that has not started, whoever asks", () => {
		const held = [running("busy", 0), fire("busy", 1), fire("busy", 2), ...others(FIRES_MAX - 3)];

		const answer = admit(held, fire("late", 999), rule);

		expect(answer.admitted).toBe(true);
		expect(members(answer.fires)).toEqual([...members(held).filter((member) => member !== "busy:1"), "late:999"]);
		expect(answer.runs.map((run) => [run.fire.member, run.outcome])).toEqual([["busy:1", "suppressed"]]);
	});

	it("keeps a started run through 64 newer fires, even where its automation holds the most", () => {
		const telling: Fire = { ...fire("busy", 1, {}), tell: { when: "now", fields: {} } };
		let held = [running("busy", 0), telling, ...others(FIRES_MAX - 2)];
		for (let at = 0; at < 64; at++) held = admit(held, fire(`new${at}`, 500 + at), rule).fires;

		expect(members(held)).toContain("busy:0");
		expect(members(held)).not.toContain("busy:1");
	});

	it("drops an event's run past its automation's waiting cap but keeps its tell, and still replaces a clock's own waiting fire", () => {
		const waiting = [running("bell", 0), fire("bell", 1), fire("bell", 2)];
		const telling: Fire = { ...fire("bell", 4), tell: { when: "now", fields: {} } };

		const capped = admit(waiting, fire("bell", 3), { ...rule, waitingMax: 2 });
		const told = admit(waiting, telling, { ...rule, waitingMax: 2 });
		const replaced = admit(waiting, fire("bell", 3), { supersede: true, earlier: () => true });

		expect([capped.admitted, capped.runs.map((run) => run.outcome)]).toEqual([false, ["suppressed"]]);
		expect(told.fires.at(-1)).toMatchObject({ member: "bell:4", steps: {} });
		expect(members(replaced.fires)).toEqual(["bell:0", "bell:2", "bell:3"]);
	});

	it("refuses a capped event's tell when every slot is held, costing no other run", () => {
		const held = [running("bell", 0), fire("bell", 1), fire("bell", 2), ...others(FIRES_MAX - 3)];
		const telling: Fire = { ...fire("bell", 4), tell: { when: "now", fields: {} } };

		const answer = admit(held, telling, { ...rule, waitingMax: 2 });

		expect([answer.admitted, answer.fires, answer.runs.map((run) => run.outcome)]).toEqual([
			false,
			held,
			["suppressed"],
		]);
	});
});

describe("the runner's next attempt", () => {
	const offer = (member: string, step: Step) => ({ ref: { member, path: "0" }, dueAt: dueAt(begun(step, 0)) });

	it("takes a retry that fell due ahead of every first attempt whose turn came later", () => {
		const retry = offer("silent:0", { attempts: 1, startedAt: 0, lastAt: 0, word: "unreachable" });
		const later = [
			offer("lamp:1", { attempts: 0, startedAt: 6_000 }),
			offer("fan:2", { attempts: 0, startedAt: 7_000 }),
		];

		expect(nextEffect([...later, retry])?.member).toBe("silent:0");
		expect(nextEffect(later)?.member).toBe("lamp:1");
	});

	it("takes a healthy first attempt ahead of dead plugs whose gaps put them later, and a resumed retry from its turn", () => {
		const dead = (member: string, lastAt: number) =>
			offer(member, { attempts: 3, startedAt: 0, lastAt, word: "unreachable" });
		const healthy = offer("lamp:1", { attempts: 0, startedAt: 10_000 });
		const resumed = offer("heat:0", { attempts: 1, startedAt: 9_000 });

		expect(nextEffect([dead("a:0", 10_000), dead("b:0", 12_000), dead("c:0", 14_000), healthy])?.member).toBe(
			"lamp:1",
		);
		expect(nextEffect([healthy, resumed])?.member).toBe("heat:0");
	});

	it("breaks a tie by fire order", () => {
		const tied = [offer("a:0", { attempts: 0, startedAt: 5_000 }), offer("b:0", { attempts: 0, startedAt: 5_000 })];

		expect(nextEffect(tied)?.member).toBe("a:0");
		expect(nextEffect([])).toBeNull();
	});

	it("gives an automation's turn to its oldest fire with steps, past a fire waiting only to tell", () => {
		const telling: Fire = { ...fire("bell", 0, {}), tell: { when: "now", fields: {} }, waiting: true };

		expect([...mayRun([telling, fire("bell", 1), fire("bell", 2)])]).toEqual(["bell:1"]);
	});
});

describe("a switch set that landed", () => {
	const on = (automation: string, at: number, step: Step = { attempts: 1, startedAt: 0, lastAt: 0 }) =>
		fire(automation, at, { "0": step, "1": { attempts: 0 } });
	const targetOf = (held: Fire, path: string): AutomationEffect => ({
		kind: "device_set",
		device: held.automation === "fan" ? "fan-plug" : `plug-${path}`,
		verb: held.automation.startsWith("flip") ? "toggle" : "on",
	});
	const landedSet = (at: number, nature: Nature = "sets") => [{ member: `cool:${at}`, device: "plug-0", nature, at }];

	it("ends open, unclaimed sets of that switch in older fires alone, never one that ended", () => {
		const older = on("heat", 100);
		const claimedOlder = on("lamp", 50, { attempts: 1, startedAt: 0, lastAt: 0, claimed: true });
		const endedOlder = on("glow", 50, { attempts: 1, startedAt: 0, lastAt: 0, word: "done", verdict: "done" });
		const newer = on("cool", 300);
		const otherSwitch = on("fan", 50);

		expect(outdatedSets([older, claimedOlder, endedOlder, newer, otherSwitch], landedSet(200), targetOf)).toEqual([
			{ member: "heat:100", path: "0" },
		]);
	});

	it("never ends a step of the fire whose set landed", () => {
		const own = on("heat", 100);

		expect(
			outdatedSets([own], [{ member: "heat:100", device: "plug-1", nature: "sets", at: 500 }], targetOf),
		).toEqual([]);
	});

	it("lets a newer toggle end an older On or Off, and an older toggle end under a newer On, but never a toggle a toggle", () => {
		const olderOn = on("heat", 100);
		const olderFlip = on("flip", 100);

		expect(outdatedSets([olderOn], landedSet(200, "nudges"), targetOf)).toEqual([
			{ member: "heat:100", path: "0" },
		]);
		expect(outdatedSets([olderFlip], landedSet(200, "sets"), targetOf)).toEqual([
			{ member: "flip:100", path: "0" },
		]);
		expect(outdatedSets([olderFlip], landedSet(200, "nudges"), targetOf)).toEqual([]);
	});
});

describe("a fire whose step's turn began", () => {
	it("is started even once a restart erased its window, so neither a newer fire of its own nor a crowd replaces it", () => {
		const held = { attempts: 0, startedAt: 0, lastAt: 0 };
		const holding: Fire = {
			...fire("bell", 0, { "0": recovered(held, "sends", KEEP_TRYING_MS * 3) }),
			active: ["0"],
		};

		const replaced = admit([holding], fire("bell", 1), { supersede: true, earlier: () => true });
		let crowd = [holding, ...others(FIRES_MAX - 1)];
		for (let at = 0; at < 64; at++) crowd = admit(crowd, fire(`new${at}`, 500 + at), rule).fires;

		expect(members(replaced.fires)).toEqual(["bell:0", "bell:1"]);
		expect(members(crowd)).toContain("bell:0");
	});
});

describe("a fire an 8.14.84 build stored", () => {
	const legacy = (at: number, effects: Record<string, string>) => ({
		member: `bell:${at}`,
		automation: "bell",
		incarnation: "i",
		revision: 1,
		seq: 0,
		at,
		effects,
	});

	it("reads unstarted while every effect was pending, so it is replaced and counted waiting, and started once one ran", () => {
		const waiting = readFire(legacy(0, { "0": "pending", "1": "pending" })) as Fire;
		const ran = readFire(legacy(1, { "0": "done", "1": "pending" })) as Fire;

		const replaced = admit([waiting], fire("bell", 9), { supersede: true, earlier: () => true });
		const capped = admit([waiting], fire("bell", 9), { ...rule, waitingMax: 1 });
		const kept = admit([ran], fire("bell", 9), { supersede: true, earlier: () => true });

		expect(members(replaced.fires)).toEqual(["bell:9"]);
		expect(capped.admitted).toBe(false);
		expect(members(kept.fires)).toEqual(["bell:1", "bell:9"]);
	});
});

describe("room in the outbox", () => {
	const quiet = (owner: string, at: number) => ({
		member: `automation:${owner}:${at}`,
		at,
		body: { title: owner, fields: {} },
	});

	it("counts a quiet newcomer in its automation's share, so a tie costs that automation its own oldest", () => {
		const held = [
			...Array.from({ length: QUEUE_MAX_EVENTS / 2 }, (_, at) => quiet("alpha", at)),
			...Array.from({ length: QUEUE_MAX_EVENTS / 2 }, (_, at) => quiet("beta", 500 + at)),
		];

		const room = roomFor(held, quiet("beta", 999), 1_000);

		expect([...(room?.dropped ?? [])]).toEqual([["beta", 1]]);
		expect(room?.events.map((event) => event.member)).not.toContain("automation:beta:500");
	});
});

describe("the run log", () => {
	const run = (outcome: AutomationRun["outcome"], reason?: string, action?: string) =>
		fireRun({ automation: "heat", seq: 0, at: 1 }, outcome, reason, action);

	it("logs a replaced run again once another run came between, and a repeat in a row once", () => {
		const between = [run("suppressed", REPLACED), run("ran", undefined, "device_set"), run("suppressed", REPLACED)];
		const repeated = [run("suppressed", REPLACED), run("suppressed", REPLACED)];

		expect(between.reduce(logged, [])).toHaveLength(3);
		expect(repeated.reduce(logged, [])).toHaveLength(1);
	});

	it("logs a standing refusal of no action once, whatever effect rows land between", () => {
		const refusal = run("refused", "not home");
		const fires = [refusal, run("ran", undefined, "device_set"), refusal];

		expect(fires.reduce(logged, []).filter((row) => row.outcome === "refused")).toHaveLength(1);
	});

	it("logs a standing refusal and a replaced run once each while they alternate", () => {
		const pair = [run("refused", "not home"), run("suppressed", REPLACED)];

		expect([...pair, ...pair, ...pair, ...pair].reduce(logged, [])).toHaveLength(2);
	});
});
