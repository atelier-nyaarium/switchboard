import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Shape only; no TypeScript renders the message.
type Node = { name: string; kind: string; symbolId: string; questions: string[]; children?: Node[] };

type Vector = {
	name: string;
	nodes: Node[];
	lines: string[];
	pairs: { symbolId: string; questions: string[] }[];
};

const vectors = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/ask-grammar/vectors.json"), "utf8"),
) as { cases: Vector[] };

const strings = (value: unknown): boolean => Array.isArray(value) && value.every((v) => typeof v === "string");

function expectNode(node: Node): void {
	expect(typeof node.name).toBe("string");
	expect(typeof node.kind).toBe("string");
	expect(typeof node.symbolId).toBe("string");
	expect(strings(node.questions)).toBe(true);
	for (const child of node.children ?? []) expectNode(child);
}

describe("the Ask grammar corpus", () => {
	it("carries a tree, its lines and its pairs in every case", () => {
		expect(vectors.cases.length).toBeGreaterThan(0);
		for (const vector of vectors.cases) {
			expect(typeof vector.name).toBe("string");
			expect(Array.isArray(vector.nodes)).toBe(true);
			for (const node of vector.nodes) expectNode(node);
			expect(strings(vector.lines)).toBe(true);
			expect(Array.isArray(vector.pairs)).toBe(true);
			for (const pair of vector.pairs) {
				expect(typeof pair.symbolId).toBe("string");
				expect(strings(pair.questions)).toBe(true);
				expect(pair.questions.length).toBeGreaterThan(0);
			}
		}
	});
});
