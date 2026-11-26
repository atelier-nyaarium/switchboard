import { describe, expect, it } from "vitest";
import { type Address, addressOf, byPath, framesOf, pathOf, siteOf, within } from "../shared/automation-walk.js";

const paths: [string, Address[]][] = [
	["0", [[0]]],
	["0.1", [[0], [1]]],
	["3.2t.1", [[3], [2, "then", 1]]],
	["0.2e.0", [[0], [2, "else", 0]]],
	["0.4b.1c.0", [[0], [4, "try", 1, "catch", 0]]],
	["0.2t.1.0", [[0], [2, "then", 1], [0]]],
	["12.10c.11", [[12], [10, "catch", 11]]],
];

describe("a step's path", () => {
	it("spells a frame per call and a letter per side, and reads back what it spelled", () => {
		expect(paths.map(([, frames]) => pathOf(frames))).toEqual(paths.map(([path]) => path));
		expect(paths.map(([path]) => framesOf(path))).toEqual(paths.map(([, frames]) => frames));
	});

	it("reads nothing from a string that is no path", () => {
		const strings = ["", "a", "0.", ".0", "0..1", "0t", "0.1t", "0x.1", "0.-1", "0.1 "];

		expect(strings.map(framesOf)).toEqual(strings.map(() => null));
	});

	it("names the call a step runs under, and none for an automation's own action", () => {
		expect(["0", "0.1", "0.2t.1", "0.2t.1.0"].map(siteOf)).toEqual([null, "0", "0", "0.2t.1"]);
		expect(["0", "0.2t.1", "0.2t.1.0"].map(addressOf)).toEqual([[0], [2, "then", 1], [0]]);
		expect(within("0", [2, "try", 0])).toBe("0.2b.0");
	});

	it("orders by where a step is written: a step before what it holds, then before else, try before catch", () => {
		const written = [
			"0",
			"0.0",
			"0.1",
			"0.1t.0",
			"0.1t.1",
			"0.1e.0",
			"0.2",
			"0.2b.0",
			"0.2b.0.0",
			"0.2c.0",
			"0.10",
			"1",
		];
		const shuffled = [...written].reverse();

		expect(shuffled.sort(byPath)).toEqual(written);
	});
});
