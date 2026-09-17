import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	type FacetCase,
	type FacetVectorAnswer,
	facetAnswerOf,
	removeFacetWorkspaces,
} from "../testing/facetVectors.js";

////////////////////////////////
//  Functions & Helpers

const VECTORS: { cases: (FacetCase & { answer: FacetVectorAnswer })[] } = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/workspace-facets/vectors.json"), "utf8"),
);

afterAll(removeFacetWorkspaces);

////////////////////////////////
//  Tests

describe("the facet vectors, against the plugin's own builders", () => {
	it.each(VECTORS.cases.map((vector) => [vector.name, vector] as const))("%s", async (_name, vector) => {
		expect(await facetAnswerOf(vector)).toEqual(vector.answer);
	});

	// A corpus of one rule pins one rule.
	it("covers every drill-in and every count", () => {
		const answers = VECTORS.cases.map((vector) => vector.answer);

		expect(VECTORS.cases.length).toBeGreaterThanOrEqual(7);
		expect(
			answers.some((answer) => answer.uses.rows.some((row) => row.holder === null && row.topLevel !== null)),
		).toBe(true);
		expect(answers.some((answer) => answer.usesFrom.targets.some((target) => target.status === "ambiguous"))).toBe(
			true,
		);
		expect(answers.some((answer) => answer.comments.truncated)).toBe(true);
		expect(answers.some((answer) => answer.hierarchy.supertypeCount > answer.hierarchy.supertypes.length)).toBe(
			true,
		);
	});
});
