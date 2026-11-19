import { describe, expect, it } from "vitest";
import {
	admit,
	FIRES_MAX,
	type Fire,
	mayRun,
	nextEffect,
	outdatedSets,
	type SwitchTarget,
} from "../gateway/computed/automationFires.js";
import { type AutomationRun, fireRun, logged, REPLACED } from "../gateway/computed/automationLog.js";
import { QUEUE_MAX_EVENTS, roomFor } from "../gateway/computed/automationOutbox.js";
import { BACKOFF_MIN_MS, backoffMs, type Nature, OVERDUE_MS, type Step } from "../gateway/computed/automationSteps.js";
import { AUTOMATION_ATTEMPT_MS } from "../gateway/devices/road.js";

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
const begun = { "0": { attempts: 1, startedAt: 0, lastAt: 0, word: "unreachable" as const } };
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
		const held = [fire("busy", 0, begun), fire("busy", 1), fire("busy", 2), ...others(FIRES_MAX - 3)];

		const answer = admit(held, fire("late", 999), rule);

		expect(answer.admitted).toBe(true);
		expect(members(answer.fires)).toEqual([...members(held).filter((member) => member !== "busy:1"), "late:999"]);
		expect(answer.runs.map((run) => [run.fire.member, run.outcome])).toEqual([["busy:1", "suppressed"]]);
	});

	it("keeps a started run through 64 newer fires, even where its automation holds the most", () => {
		const telling: Fire = { ...fire("busy", 1, {}), tell: { when: "now", fields: {} } };
		let held = [fire("busy", 0, begun), telling, ...others(FIRES_MAX - 2)];
		for (let at = 0; at < 64; at++) held = admit(held, fire(`new${at}`, 500 + at), rule).fires;

		expect(members(held)).toContain("busy:0");
		expect(members(held)).not.toContain("busy:1");
	});

	it("drops an event's run past its automation's waiting cap but keeps its tell, and still replaces a clock's own waiting fire", () => {
		const waiting = [fire("bell", 0, begun), fire("bell", 1), fire("bell", 2)];
		const telling: Fire = { ...fire("bell", 4), tell: { when: "now", fields: {} } };

		const capped = admit(waiting, fire("bell", 3), { ...rule, waitingMax: 2 });
		const told = admit(waiting, telling, { ...rule, waitingMax: 2 });
		const replaced = admit(waiting, fire("bell", 3), { supersede: true, earlier: () => true });

		expect([capped.admitted, capped.runs.map((run) => run.outcome)]).toEqual([false, ["suppressed"]]);
		expect(told.fires.at(-1)).toMatchObject({ member: "bell:4", steps: {} });
		expect(members(replaced.fires)).toEqual(["bell:0", "bell:2", "bell:3"]);
	});

	it("refuses a capped event's tell when every slot is held, costing no other run", () => {
		const held = [fire("bell", 0, begun), fire("bell", 1), fire("bell", 2), ...others(FIRES_MAX - 3)];
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
	const turn = (held: Fire): Fire => ({ ...held, active: ["0"] });

	it("takes a first attempt of a newer run before an older run's due retry, until the retry is overdue", () => {
		const fires = [turn(fire("silent", 0, begun)), turn(fire("lamp", 1))];
		// Due at `backoffMs(1)` after its last attempt.
		const due = backoffMs(1);

		expect(nextEffect(fires, () => true, due)?.member).toBe("lamp:1");
		expect(nextEffect(fires, () => true, due + OVERDUE_MS)?.member).toBe("lamp:1");
		expect(nextEffect(fires, () => true, due + OVERDUE_MS + 1)?.member).toBe("silent:0");
		expect(nextEffect([fires[0] as Fire], () => true, due)?.member).toBe("silent:0");
	});

	it("takes a healthy first attempt that has waited longest ahead of three dead plugs' overdue retries", () => {
		const dead = (name: string, lastAt: number) =>
			turn(fire(name, 0, { "0": { attempts: 3, startedAt: 0, lastAt, word: "unreachable" } }));
		const healthy = turn(fire("lamp", 1, { "0": { attempts: 0, startedAt: 10_000 } }));
		const fires = [dead("a", 10_000), dead("b", 12_000), dead("c", 14_000), healthy];
		// The dead ones came due at their last answer plus 20 s.
		const now = 10_000 + OVERDUE_MS + 1;

		expect(nextEffect(fires, () => true, now)?.member).toBe("lamp:1");
		expect(nextEffect(fires.slice(1), () => true, 200_000)?.member).toBe("lamp:1");
		expect(nextEffect(fires.slice(1, 3), () => true, 200_000)?.member).toBe("b:0");
	});

	it("measures a resumed retry with no last attempt from its turn, so a stream of first attempts cannot starve it", () => {
		const resumed = turn(fire("heat", 0, { "0": { attempts: 1, startedAt: 0 } }));
		const fresh = (at: number) => turn(fire(`new${at}`, at, { "0": { attempts: 0, startedAt: at } }));

		expect(nextEffect([resumed, fresh(OVERDUE_MS)], () => true, OVERDUE_MS)?.member).toBe("new20000:20000");
		expect(nextEffect([resumed, fresh(OVERDUE_MS + 1)], () => true, OVERDUE_MS + 1)?.member).toBe("heat:0");
	});

	it("bounds the overdue rule by one device attempt and the shortest gap", () => {
		expect(OVERDUE_MS).toBe(AUTOMATION_ATTEMPT_MS + BACKOFF_MIN_MS);
	});

	it("gives an automation's turn to its oldest fire with steps, past a fire waiting only to tell", () => {
		const telling: Fire = { ...fire("bell", 0, {}), tell: { when: "now", fields: {} }, waiting: true };

		expect([...mayRun([telling, fire("bell", 1), fire("bell", 2)])]).toEqual(["bell:1"]);
	});
});

describe("a switch set that landed", () => {
	const on = (automation: string, at: number, step: Step = { attempts: 1, startedAt: 0, lastAt: 0 }) =>
		fire(automation, at, { "0": step, "1": { attempts: 0 } });
	const targetOf = (held: Fire, path: string): SwitchTarget => ({
		device: held.automation === "fan" ? "fan-plug" : `plug-${path}`,
		nature: held.automation.startsWith("flip") ? "nudges" : "sets",
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
	it("is started, so neither a newer fire of its own nor a crowd replaces it", () => {
		const holding = fire("bell", 0, { "0": { attempts: 0, startedAt: 0 } });

		const replaced = admit([holding], fire("bell", 1), { supersede: true, earlier: () => true });
		let held = [holding, ...others(FIRES_MAX - 1)];
		for (let at = 0; at < 64; at++) held = admit(held, fire(`new${at}`, 500 + at), rule).fires;

		expect(members(replaced.fires)).toEqual(["bell:0", "bell:1"]);
		expect(members(held)).toContain("bell:0");
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
