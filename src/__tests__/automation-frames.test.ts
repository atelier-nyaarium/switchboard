import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type Address,
	branchesOf,
	catchOf,
	type Ended,
	entered,
	type Failure,
	type FrameMemory,
	guardOf,
	type Move,
	moved,
	ownerOf,
	strandOf,
	type TreeStep,
} from "../gateway/computed/automationFrames.js";

interface Case {
	name: string;
	body: TreeStep[];
	events: Ended[];
	visits: Address[];
	caught: ({ by: Address; code: string } | null)[];
	end: { end: "done" } | { end: "failed"; code: string };
}

const { cases } = JSON.parse(
	fs.readFileSync(
		path.resolve(import.meta.dirname, "../../tests/fixtures/automation-frames/failure-table.json"),
		"utf8",
	),
) as { cases: Case[] };

/** Applies one event per step whose turn comes. */
function run(body: TreeStep[], events: Ended[]) {
	const visits: Address[] = [];
	const caught: Case["caught"] = [];
	let memory: FrameMemory = {};
	let move: Move = entered(body);
	for (const event of events) {
		if (!("to" in move)) throw new Error("the frame ended with events left");
		visits.push(move.to);
		caught.push(move.caught ? { by: move.caught.by, code: move.caught.failure.code } : null);
		({ move, memory } = moved(body, move.to, event, memory));
	}
	const end = "end" in move ? (move.end === "failed" ? { end: move.end, code: move.failure.code } : move) : null;
	return { visits, caught, end };
}

describe("the failure table", () => {
	it("holds more than a dozen cases", () => {
		expect(cases.length).toBeGreaterThan(12);
	});

	for (const vector of cases) {
		it(vector.name, () => {
			expect(run(vector.body, vector.events)).toEqual({
				visits: vector.visits,
				caught: vector.caught,
				end: vector.end,
			});
		});
	}
});

describe("what encloses a step", () => {
	it("is guarded by the try whose guarded side holds it, and a catch guards nothing", () => {
		expect([
			guardOf([0, "try", 1]),
			guardOf([0, "catch", 1]),
			guardOf([0, "try", 2, "catch", 0]),
			guardOf([0, "try", 2, "catch", 0, "try", 1]),
			guardOf([3]),
		]).toEqual([[0], null, [0], [0, "try", 2, "catch", 0], null]);
	});

	it("reads `e` from the catch that holds it, the innermost first", () => {
		expect([
			catchOf([0, "catch", 1]),
			catchOf([0, "catch", 1, "try", 0, "catch", 2]),
			catchOf([0, "try", 1]),
		]).toEqual([[0], [0, "catch", 1, "try", 0], null]);
	});
});

describe("a strand of a block", () => {
	const act = { kind: "do" };
	/** A try holding a block of two branches, the second a try of its own; then a step. */
	const body: TreeStep[] = [
		{
			kind: "try",
			steps: [{ kind: "parallel", steps: [act, { kind: "try", steps: [act, act], catch: [act] }] }, act],
			catch: [act],
		},
		act,
	];
	const block: Address = [0, "try", 0];
	const first: Address = [...block, "parallel", 0];
	const second: Address = [...block, "parallel", 1];
	const failure: Failure = { code: "refused", message: "x" };
	const failed: Ended = { how: "failed", failure };

	it("names its block and its own root, and a block names each branch", () => {
		const inner: Address = [...second, "try", 1];

		expect([ownerOf(inner), strandOf(inner), ownerOf([1]), strandOf(block)]).toEqual([block, second, null, null]);
		expect(branchesOf(body, block)).toEqual([first, second]);
	});

	it("ends at its root: a branch that is done runs out to its block, never on to the next branch", () => {
		expect(moved(body, first, { how: "done" }, {}).move).toEqual({ strand: block });
		expect(moved(body, [...second, "try", 1], { how: "done" }, {}).move).toEqual({ strand: block });
	});

	it("is guarded by a try inside it, and never by one around its block", () => {
		const inside = moved(body, [...second, "try", 0], failed, {});
		const outside = moved(body, first, failed, {});

		expect(inside.move).toEqual({ to: [...second, "catch", 0], caught: { by: second, failure } });
		expect(outside).toEqual({ move: { strand: block, failure }, memory: { failed: failure } });
		expect(guardOf(first)).toBeNull();
	});

	it("ends alone at a throw or an exit, with what it remembers", () => {
		const thrown = moved(body, [...second, "catch", 0], { how: "thrown", failure }, {});
		const left = moved(body, [...second, "catch", 0], { how: "exit" }, { failed: failure });

		expect(thrown.move).toEqual({ strand: block, failure });
		expect(left.move).toEqual({ strand: block, failure });
	});

	it("hands its block's failure to the try around the block, as any step's", () => {
		expect(moved(body, block, failed, {}).move).toEqual({ to: [0, "catch", 0], caught: { by: [0], failure } });
		expect(moved(body, block, { how: "done" }, {}).move).toEqual({ to: [0, "try", 1] });
	});
});
