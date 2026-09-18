import fs from "node:fs";
import path from "node:path";
import type { Session } from "@nyaa-lexicon/client";
import type { PaintFacts } from "@nyaa-lexicon/protocol";
import { describe, expect, it } from "vitest";
import { factsForModule, spansFromFacts } from "../mcp/workspace/paint.js";
import { CODE_TOKENS } from "../shared/schemasWorkspace.js";

////////////////////////////////
//  Functions & Helpers

interface Vector {
	name: string;
	text: string;
	facts: PaintFacts | null;
	lines: number[][] | null;
}

const vectors = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/code-spans/vectors.json"), "utf8"),
) as { tokens: string[]; cases: Vector[] };

const code = (token: (typeof CODE_TOKENS)[number]) => CODE_TOKENS.indexOf(token);

const emptyFacts: PaintFacts = {
	contentHash: null,
	words: { keywords: [], builtins: [], literals: [] },
	depth: "full",
	declarations: [],
	references: [],
	literals: [],
	comments: [],
};

const range = (startLine: number, startChar: number, endLine: number, endChar: number) => ({
	start: { line: startLine, character: startChar },
	end: { line: endLine, character: endChar },
});

/** Only the methods `factsForModule` reaches. */
function sessionOf(answers: Partial<Record<string, unknown>>): () => Promise<Session> {
	return async () =>
		({
			moduleFacts: async () => answers.moduleFacts,
			parseFacts: async () => answers.parseFacts,
		}) as unknown as Session;
}

////////////////////////////////
//  Tests

describe("code spans, replayed from real Lexicon facts", () => {
	it("answers every vector in the token order the phone reads", () => {
		expect(vectors.tokens).toEqual([...CODE_TOKENS]);
		for (const vector of vectors.cases) {
			const lines = vector.facts === null ? null : spansFromFacts(vector.text, vector.facts);
			expect({ name: vector.name, lines }).toEqual({ name: vector.name, lines: vector.lines });
		}
	});
});

describe("painting from facts", () => {
	it("paints a template literal holding a regex, and keeps painting the lines after it", () => {
		// const bin = "b";
		// execSync(`"${bin}" bash -lc "${x.replace(/"/g, '\\"')}"`, {});
		// const after = 1;
		const text = [
			'const bin = "b";',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: source text, not a template
			'execSync(`"${bin}" bash -lc "${x.replace(/"/g, \'\\\\"\')}"`, {});',
			"const after = 1;",
		].join("\n");
		const facts: PaintFacts = {
			...emptyFacts,
			words: { keywords: ["const"], builtins: [], literals: [] },
			declarations: [
				{ kind: "constant", range: range(0, 6, 0, 9) },
				{ kind: "constant", range: range(2, 6, 2, 11) },
			],
			references: [
				{ role: "call", range: range(1, 0, 1, 8), bound: false },
				{ role: "read", range: range(1, 13, 1, 16), bound: true },
				{ role: "read", range: range(1, 32, 1, 33), bound: false },
				{ role: "call", range: range(1, 34, 1, 41), bound: false },
			],
			literals: [
				{ kind: "string", range: range(0, 12, 0, 15) },
				// The regex itself is not a fact; the string argument to replace is.
				{ kind: "string", range: range(1, 51, 1, 56) },
				{ kind: "number", range: range(2, 14, 2, 15) },
			],
		};

		const lines = spansFromFacts(text, facts);

		expect(lines[0]).toEqual([0, 5, code("keyword"), 6, 3, code("variable"), 12, 3, code("string")]);
		expect(lines[1]).toEqual([
			0,
			8,
			code("function"),
			13,
			3,
			code("variable"),
			32,
			1,
			code("variable"),
			34,
			7,
			code("function"),
			51,
			5,
			code("string"),
		]);
		// The regex `/"/g` paints nothing between "x.replace(" and the string argument: no fact covers it.
		expect(lines[2]).toEqual([0, 5, code("keyword"), 6, 5, code("variable"), 14, 1, code("number")]);
	});

	it("paints a keyword no fact covers, and leaves an uncovered non-keyword identifier plain", () => {
		const text = "return x;";
		const facts: PaintFacts = { ...emptyFacts, words: { keywords: ["return"], builtins: [], literals: [] } };

		const lines = spansFromFacts(text, facts);

		expect(lines).toEqual([[0, 6, code("keyword")]]);
	});

	it("paints a reference nested inside a string literal's range as interpolation", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: source text, not a template
		const text = "`a${b}c`";
		const facts: PaintFacts = {
			...emptyFacts,
			references: [{ role: "read", range: range(0, 3, 0, 4), bound: true }],
			literals: [{ kind: "string", range: range(0, 0, 0, 8) }],
		};

		const lines = spansFromFacts(text, facts);

		expect(lines).toEqual([[0, 3, code("string"), 3, 1, code("interpolation"), 4, 4, code("string")]]);
	});

	it("paints a substitution in the gap between a template's head and tail fragments as interpolation", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: source text, not a template
		const text = "`a${b}c`";
		const facts: PaintFacts = {
			...emptyFacts,
			// TemplateHead "`a${" and TemplateTail "}c`" each their own literal; "b" sits in the gap
			// between them, covered by neither.
			references: [{ role: "read", range: range(0, 4, 0, 5), bound: true }],
			literals: [
				{ kind: "string", range: range(0, 0, 0, 4) },
				{ kind: "string", range: range(0, 5, 0, 8) },
			],
		};

		const lines = spansFromFacts(text, facts);

		expect(lines).toEqual([[0, 4, code("string"), 4, 1, code("interpolation"), 5, 3, code("string")]]);
	});

	it("resolves an overlap by width: the narrower span wins regardless of which fact carries it", () => {
		// A whole-body declaration (no name of its own) with a number literal inside it.
		const text = "func f():\n\treturn 1\n";
		const facts: PaintFacts = {
			...emptyFacts,
			declarations: [{ kind: "class", range: range(0, 0, 1, 9) }],
			literals: [{ kind: "number", range: range(1, 8, 1, 9) }],
		};

		const lines = spansFromFacts(text, facts);

		expect(lines[0]).toEqual([0, 9, code("type")]);
		expect(lines[1]).toEqual([0, 8, code("type"), 8, 1, code("number")]);
	});
});

describe("clamping a position to its own line", () => {
	it("stops a fact at its own line's end rather than bleeding into the next line", () => {
		const text = "ab\ncd\n";
		const facts: PaintFacts = {
			...emptyFacts,
			// A column far past "ab"'s length must not reach into line 1's "cd".
			declarations: [{ kind: "variable", range: range(0, 0, 0, 100) }],
		};

		const lines = spansFromFacts(text, facts);

		expect(lines[0]).toEqual([0, 2, code("variable")]);
		expect(lines[1]).toEqual([]);
	});

	it("stops before a line's carriage return, even when the fact's column reaches past it", () => {
		const text = "ab\r\ncd\r\n";
		const facts: PaintFacts = { ...emptyFacts, declarations: [{ kind: "variable", range: range(0, 0, 0, 4) }] };

		const lines = spansFromFacts(text, facts);

		expect(lines[0]).toEqual([0, 2, code("variable")]);
		expect(lines[1]).toEqual([]);
	});

	it("still lands on the right column when an astral character sits earlier on the line", () => {
		// U+1F600 is two UTF-16 units, so "x" sits at column 2.
		const text = "\u{1F600}x = 1;\n";
		const facts: PaintFacts = { ...emptyFacts, declarations: [{ kind: "variable", range: range(0, 2, 0, 3) }] };

		const lines = spansFromFacts(text, facts);

		expect(lines[0]).toEqual([2, 1, code("variable")]);
	});
});

describe("skipping a word escaped out of being a keyword", () => {
	it("does not paint a Kotlin backticked identifier as its own keyword spelling", () => {
		const text = "val `class` = 1";
		const facts: PaintFacts = { ...emptyFacts, words: { keywords: ["class"], builtins: [], literals: [] } };

		expect(spansFromFacts(text, facts)).toEqual([[]]);
	});

	it("does not paint a C# @keyword identifier as its own keyword spelling", () => {
		const text = "var @class = 1;";
		const facts: PaintFacts = { ...emptyFacts, words: { keywords: ["class"], builtins: [], literals: [] } };

		expect(spansFromFacts(text, facts)).toEqual([[]]);
	});

	it("does not paint a Rust raw identifier r#type as its own keyword spelling", () => {
		const text = "let r#type = 1;";
		const facts: PaintFacts = { ...emptyFacts, words: { keywords: ["type"], builtins: [], literals: [] } };

		expect(spansFromFacts(text, facts)).toEqual([[]]);
	});
});

describe("choosing the facts to paint from", () => {
	it("takes the store's rows only when they are full depth and describe exactly the handed text", async () => {
		const text = "const x = 1;";
		const stored: PaintFacts & { module: string; known: true } = {
			module: "a.ts",
			known: true,
			...emptyFacts,
			contentHash: "not-a-match",
		};
		const session = sessionOf({ moduleFacts: stored });

		// The stored contentHash does not match the handed text, so it falls through to parseFacts,
		// which this session answers nothing for: the fall-through is what is under test.
		const outcome = await factsForModule(await session(), "a.ts", text, Date.now() + 1_000);

		expect(outcome).toMatchObject({ reason: expect.any(String) });
	});

	it("falls through to parseFacts when the store is not yet at full depth", async () => {
		const text = "const x = 1;";
		const { hashContent } = await import("@nyaa-lexicon/protocol");
		const stored = { module: "a.ts", known: true, ...emptyFacts, depth: "outline", contentHash: hashContent(text) };
		const parsed: PaintFacts & { ok: true } = { ok: true, ...emptyFacts, contentHash: hashContent(text) };
		const session = sessionOf({ moduleFacts: stored, parseFacts: parsed });

		const outcome = await factsForModule(await session(), "a.ts", text, Date.now() + 1_000);

		expect(outcome).toEqual({ facts: parsed });
	});

	it("takes the store's full-depth rows once their contentHash matches the handed text", async () => {
		const text = "const x = 1;";
		const { hashContent } = await import("@nyaa-lexicon/protocol");
		const stored = { module: "a.ts", known: true, ...emptyFacts, contentHash: hashContent(text) };
		// parseFacts is never provided: reaching it would throw and fail the test.
		const session = sessionOf({ moduleFacts: stored });

		const outcome = await factsForModule(await session(), "a.ts", text, Date.now() + 1_000);

		expect(outcome).toEqual({ facts: stored });
	});

	it("answers a reason, never spans, when no provider owns the module", async () => {
		const session = sessionOf({
			moduleFacts: { module: "a.zzz", known: false, reason: "notIndexed" },
			parseFacts: { ok: false, reason: "no provider owns a.zzz" },
		});

		const outcome = await factsForModule(await session(), "a.zzz", "x", Date.now() + 1_000);

		expect(outcome).toEqual({ reason: "no provider owns a.zzz" });
	});

	it("answers a reason rather than throwing when the daemon itself fails", async () => {
		const session = async () =>
			({
				moduleFacts: async () => {
					throw new Error("socket closed");
				},
			}) as unknown as Session;

		const outcome = await factsForModule(await session(), "a.ts", "x", Date.now() + 1_000);

		expect(outcome).toMatchObject({ reason: "socket closed" });
	});
});
