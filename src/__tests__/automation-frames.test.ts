import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type Address,
	catchOf,
	type Ended,
	entered,
	type FrameMemory,
	guardOf,
	type Move,
	moved,
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
