import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEXT_HOLE_CASES } from "../../scripts/lib/textHoleCases.js";
import { type HolePart, hasHoles, scanHoles } from "../shared/text-holes.js";

type Vector = { name: string; input: string; parts: HolePart[] };

const vectors = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/text-holes/vectors.json"), "utf8"),
) as { cases: Vector[] };

describe("text holes, against the shared corpus", () => {
	it("holds every case the generator lists, as the scanner reads it now", () => {
		expect(vectors.cases).toEqual(
			TEXT_HOLE_CASES.map(([name, input]) => ({ name, input, parts: scanHoles(input) })),
		);
	});

	for (const vector of vectors.cases) {
		it(vector.name, () => {
			expect(scanHoles(vector.input)).toEqual(vector.parts);
		});
	}

	it("covers the whole text with its parts, in order", () => {
		for (const { input, parts } of vectors.cases) {
			expect(parts.flatMap((part) => [part.start, part.end])).toEqual(
				parts.flatMap((part, at) => [at === 0 ? 0 : (parts[at - 1]?.end ?? 0), part.end]),
			);
			expect(parts.at(-1)?.end ?? 0).toBe(input.length);
		}
		expect([hasHoles("plain \\{ text"), hasHoles("a {x}")]).toEqual([false, true]);
	});
});
