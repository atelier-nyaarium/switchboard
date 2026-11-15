import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONSOLE_TOKEN_CASES } from "../../scripts/lib/consoleTokenCases.js";
import { type ConsoleToken, lexConsole } from "../shared/live-console-grammar.js";

type Vector = { name: string; input: string; tokens: ConsoleToken[] };

const vectors = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/live-console-tokens/vectors.json"), "utf8"),
) as { cases: Vector[] };

describe("live console tokens, against the shared corpus", () => {
	it("holds every case the generator lists, as the lexer reads it now", () => {
		expect(vectors.cases).toEqual(
			CONSOLE_TOKEN_CASES.map(([name, input]) => ({ name, input, tokens: lexConsole(input) })),
		);
	});

	for (const vector of vectors.cases) {
		it(vector.name, () => {
			expect(lexConsole(vector.input)).toEqual(vector.tokens);
		});
	}
});
