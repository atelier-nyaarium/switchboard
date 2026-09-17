import fs from "node:fs";
import path from "node:path";
import hljs from "highlight.js/lib/core";
import { describe, expect, it } from "vitest";
import {
	GRAMMARS,
	highlightable,
	lineSpansOf,
	sliceSpans,
	spansFromHtml,
	TOKEN_OF_SCOPE,
} from "../mcp/workspace/highlight.js";
import { CODE_TOKENS } from "../shared/schemasWorkspace.js";

////////////////////////////////
//  Functions & Helpers

interface Vectors {
	tokens: string[];
	cases: { name: string; language: string; text: string; lines: number[][] | null }[];
}

const vectors = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/code-spans/vectors.json"), "utf8"),
) as Vectors;

const code = (token: (typeof CODE_TOKENS)[number]) => CODE_TOKENS.indexOf(token);

/** Scopes a grammar can open. */
function scopesOf(definition: unknown): Set<string> {
	const scopes = new Set<string>();
	const seen = new Set<object>();
	const add = (scope: unknown) => {
		if (typeof scope === "string" && scope !== "") scopes.add(scope);
		else if (typeof scope === "object" && scope !== null) for (const each of Object.values(scope)) add(each);
	};
	const walk = (node: unknown) => {
		if (typeof node !== "object" || node === null || seen.has(node)) return;
		seen.add(node);
		if (Array.isArray(node)) {
			for (const each of node) walk(each);
			return;
		}
		const mode = node as Record<string, unknown>;
		for (const key of ["scope", "className", "beginScope", "endScope"]) add(mode[key]);
		const keywords = mode.keywords;
		if (typeof keywords === "string" || Array.isArray(keywords)) scopes.add("keyword");
		else if (typeof keywords === "object" && keywords !== null)
			// Underscored groups only score.
			for (const group of Object.keys(keywords)) if (group !== "$pattern" && !group.startsWith("_")) add(group);
		for (const key of ["contains", "variants", "starts", "cachedVariants"]) walk(mode[key]);
	};
	walk(definition);
	return scopes;
}

////////////////////////////////
//  Tests

describe("code spans", () => {
	it("answers every vector, in the token order the phone reads", () => {
		expect(vectors.tokens).toEqual([...CODE_TOKENS]);
		for (const vector of vectors.cases) {
			const lines = highlightable(vector.language) ? lineSpansOf(vector.language, vector.text) : null;
			expect({ name: vector.name, lines }).toEqual({ name: vector.name, lines: vector.lines });
		}
	});

	it("reaches every registered grammar from a Lexicon language", () => {
		const unreachable = Object.keys(GRAMMARS).filter(
			(name) => !highlightable(name) || lineSpansOf(name, "x") === null,
		);

		expect(unreachable).toEqual([]);
	});

	it("maps every scope a registered grammar can open", () => {
		const instance = hljs.newInstance();
		const unmapped: string[] = [];
		const opened = new Set<string>();
		for (const [name, grammar] of Object.entries(GRAMMARS)) {
			instance.registerLanguage(name, grammar);
			for (const scope of scopesOf(instance.getLanguage(name))) {
				opened.add(scope);
				if (!Object.hasOwn(TOKEN_OF_SCOPE, scope)) unmapped.push(`${name} ${scope}`);
			}
		}

		expect(unmapped).toEqual([]);
		// Reached a multi-match scope.
		expect(opened).toContain("title.class.inherited");
	});

	it("gives nested text the innermost token, and a container's text the enclosing one", () => {
		const html =
			'<span class="hljs-string">&quot;a<span class="hljs-subst">b</span><span class="hljs-function">c</span></span>' +
			'<span class="language-css"><span class="hljs-number">1</span>d</span>';

		expect(spansFromHtml('"abc1d', html)).toEqual([
			[0, 2, code("string"), 2, 1, code("interpolation"), 3, 1, code("string"), 4, 1, code("number")],
		]);
	});

	it("refuses anything highlight.js does not render for that text", () => {
		const refused = [
			'<span class="hljs-bogus">a</span>',
			'<span class="hljs-title class__">a</span>',
			'<span class="hljs-title" data-x="1">a</span>',
			"<b>a</b>",
			'<span class="hljs-string">a',
			"a</span>",
			"&nbsp;",
			"a>",
			"b",
		];

		for (const html of refused) expect({ html, spans: spansFromHtml("a", html) }).toEqual({ html, spans: null });
	});

	it("slices a line's triples to a window, from zero", () => {
		const line = [0, 10, code("string"), 12, 3, code("keyword"), 20, 4, code("number")];

		expect(sliceSpans(line, 5, 14)).toEqual([0, 5, code("string"), 7, 2, code("keyword")]);
	});
});
