import { describe, expect, it } from "vitest";
import { admit, FIRES_MAX, type Fire } from "../gateway/computed/automationFires.js";
import { type AutomationRun, fireRun, logged, REPLACED } from "../gateway/computed/automationLog.js";
import { QUEUE_MAX_EVENTS, roomFor } from "../gateway/computed/automationOutbox.js";

const fire = (automation: string, at: number, effects: Fire["effects"] = { "0": "pending" }): Fire => ({
	member: `${automation}:${at}`,
	automation,
	incarnation: "i",
	revision: 1,
	seq: 0,
	at,
	effects,
});
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

	it("gives up the largest holder's oldest unclaimed fire, whoever asks", () => {
		const held = [fire("busy", 0, { "0": "claimed" }), fire("busy", 1), fire("busy", 2), ...others(FIRES_MAX - 3)];

		const answer = admit(held, fire("late", 999), rule);

		expect(answer.admitted).toBe(true);
		expect(members(answer.fires)).toEqual([...members(held).filter((member) => member !== "busy:1"), "late:999"]);
		expect(answer.runs.map((run) => [run.fire.member, run.outcome])).toEqual([["busy:1", "suppressed"]]);
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
});
