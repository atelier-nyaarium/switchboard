import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SCRIPT_SCAN_CASES } from "../../scripts/lib/scriptScanCases.js";
import { type ScriptPiece, scanScript } from "../shared/script-scan.js";

type Vector = { name: string; input: string; pieces: ScriptPiece[] };

const vectors = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/script-scan/vectors.json"), "utf8"),
) as { cases: Vector[] };

const read = (source: string) =>
	scanScript(source).map((piece) => `${piece.kind}${piece.joins ? "+" : ""}:${source.slice(piece.start, piece.end)}`);

describe("the script scanner, against the shared corpus", () => {
	it("holds every case the generator lists, as the scanner reads it now", () => {
		expect(vectors.cases).toEqual(
			SCRIPT_SCAN_CASES.map(([name, input]) => ({ name, input, pieces: scanScript(input) })),
		);
	});
});

describe("the script scanner", () => {
	it("parts a statement's word, its code and its block's braces, and takes else if as two words", () => {
		expect(read('if (a) {\n\twait(5)\n} else if (b) {\n\tthrow "x"\n}')).toEqual([
			"word:if",
			"code:(a)",
			"open:{",
			"word:wait",
			"code:(5)",
			"close:}",
			"word:else",
			"word:if",
			"code:(b)",
			"open:{",
			"word:throw",
			'code:"x"',
			"close:}",
		]);
	});

	it("reads a brace as a record's unless its statement began with a block word", () => {
		expect(read("x = {a: 1}\ntry {\n}")).toEqual(["code:x = {a: 1}", "word:try", "open:{", "close:}"]);
	});

	it("keeps a statement open across lines while a bracket is, and ends it at a newline otherwise", () => {
		expect(read("f(a,\n b)\ng()")).toEqual(["code:f(a,\n b)", "code:g()"]);
	});

	it("ends a comment at its line, leaves slashes in a string alone, and marks code a comment cut off", () => {
		expect(read('x = "a // b" // why\nf(a, // one\n b)')).toEqual([
			'code:x = "a // b"',
			"comment:// why",
			"code:f(a,",
			"comment:// one",
			"code+:b)",
		]);
	});

	it("ends an open string with its line", () => {
		expect(read('x = "abc\ny = 1')).toEqual(['code:x = "abc', "code:y = 1"]);
	});

	it("takes a reserved word only as a whole word opening a statement", () => {
		expect(read("iffy = 1\nx = wait\nexit")).toEqual(["code:iffy = 1", "code:x = wait", "word:exit"]);
	});
});
