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

interface Place {
	module: string;
	line: number;
}

/** The index's order, as far as an answer carries it: a row keeps no column. */
function inOrder(rows: readonly Place[]): boolean {
	return rows.every((row, at) => {
		const before = rows[at - 1];
		if (before === undefined) return true;
		return before.module === row.module ? before.line <= row.line : before.module < row.module;
	});
}

const useRowsOf = (answer: FacetVectorAnswer) => ("tooLarge" in answer.uses ? [] : answer.uses.rows);

////////////////////////////////
//  Tests

describe("the facet vectors, against the plugin's own builders", () => {
	it.each(VECTORS.cases.map((vector) => [vector.name, vector] as const))("%s", async (_name, vector) => {
		expect(await facetAnswerOf(vector)).toEqual(vector.answer);
	});

	// A corpus of one rule pins one rule.
	it("covers every drill-in and every count", () => {
		const answers = VECTORS.cases.map((vector) => vector.answer);
		const rows = answers.flatMap(useRowsOf);

		expect(VECTORS.cases.length).toBeGreaterThanOrEqual(9);
		expect(rows.some((row) => row.holder === null && row.topLevel !== null)).toBe(true);
		expect(rows.some((row) => row.holder !== null && row.topLevel === null)).toBe(true);
		expect(
			answers.some(
				(answer) =>
					!("tooLarge" in answer.usesFrom) && answer.usesFrom.targets.some((t) => t.status === "ambiguous"),
			),
		).toBe(true);
		expect(answers.some((answer) => answer.comments.truncated)).toBe(true);
		expect(answers.some((answer) => answer.hierarchy.supertypeCount > answer.hierarchy.supertypes.length)).toBe(
			true,
		);
		expect(answers.some((answer) => "tooLarge" in answer.uses && answer.counts === null)).toBe(true);
	});

	// A corpus authored in source order would pin the order of nothing.
	it("answers in the index's order over inputs that are not", () => {
		expect(VECTORS.cases.every((vector) => inOrder(useRowsOf(vector.answer)))).toBe(true);
		expect(VECTORS.cases.some((vector) => !inOrder(vector.uses ?? []))).toBe(true);
		expect(VECTORS.cases.some((vector) => !inOrder(vector.targets ?? []))).toBe(true);
	});
});
