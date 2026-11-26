import { describe, expect, it } from "vitest";
import { addressIn } from "../gateway/computed/automationFrames.js";
import { below, byPath, STEP_PATH_RE, siteAmong, within } from "../shared/automation-walk.js";

describe("a step's path", () => {
	it("spells a call, an index and a side as numbers, the first side 0 and the second 1", () => {
		expect([
			within("0", [1]),
			within("3", [2, "then", 1]),
			within("0", [2, "else", 0]),
			within("0", [4, "try", 1, "catch", 0]),
		]).toEqual(["0.1", "3.2.0.1", "0.2.1.0", "0.4.0.1.1.0"]);
	});

	it("matches what a build before sides stored, and nothing that is no path", () => {
		const paths = ["0", "0.1", "12.10.1.11"];
		const others = ["", "a", "0.", ".0", "0..1", "0t", "0.-1", "0.1 "];

		expect([
			paths.every((path) => STEP_PATH_RE.test(path)),
			others.some((path) => STEP_PATH_RE.test(path)),
		]).toEqual([true, false]);
	});

	it("names the call a step runs under as the longest site above it, and none for an automation's own step", () => {
		const sites = ["0", "0.2.0.1", "1"];

		expect(["0", "0.1", "0.2.0.1", "0.2.0.1.3", "10.1", "2.0"].map((path) => siteAmong(path, sites))).toEqual([
			null,
			"0",
			"0",
			"0.2.0.1",
			null,
			null,
		]);
		expect(below("0.2.0.1", "0")).toEqual([2, 0, 1]);
	});

	it("orders by where a step is written: a step before what it holds, a first side before a second", () => {
		const written = ["0", "0.0", "0.1", "0.1.0.0", "0.1.0.1", "0.1.1.0", "0.2", "0.2.0.0", "0.10", "1"];

		expect([...written].reverse().sort(byPath)).toEqual(written);
	});

	it("reads its numbers against the body they address, which names each side", () => {
		const body = [
			{ kind: "do" },
			{ kind: "if", steps: [{ kind: "do" }], else: [{ kind: "do" }] },
			{ kind: "try", steps: [{ kind: "do" }], catch: [{ kind: "if", steps: [{ kind: "do" }] }] },
		];

		expect(
			[[0], [1, 0, 0], [1, 1, 0], [2, 0, 0], [2, 1, 0, 0, 0]].map((numbers) => addressIn(body, numbers)),
		).toEqual([[0], [1, "then", 0], [1, "else", 0], [2, "try", 0], [2, "catch", 0, "then", 0]]);
		expect([[3], [0, 0, 0], [1, 2, 0], [1, 0], [1, 0, 4]].map((numbers) => addressIn(body, numbers))).toEqual(
			Array(5).fill(null),
		);
	});
});
