import { describe, expect, it } from "vitest";
import { admit, FIRES_MAX, type Fire } from "../gateway/computed/automationFires.js";

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
