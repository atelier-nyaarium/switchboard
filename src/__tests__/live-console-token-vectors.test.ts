import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	CONSOLE_SCRIPT_CASES,
	CONSOLE_STRING_CASES,
	CONSOLE_TEXT_CASES,
	CONSOLE_TOKEN_CASES,
} from "../../scripts/lib/consoleTokenCases.js";
import {
	type ConsoleStringPart,
	type ConsoleToken,
	lexConsole,
	lexConsoleText,
	lexScript,
	quoteConsoleString,
	quoteConsoleText,
} from "../shared/live-console-grammar.js";

type Tokens = { name: string; input: string; tokens: ConsoleToken[] };
type Parts = { name: string; input: string; parts: ConsoleStringPart[] };

type Quoted = { name: string; input: string; quoted: string };

const vectors = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/live-console-tokens/vectors.json"), "utf8"),
) as { cases: Tokens[]; texts: Parts[]; scripts: Tokens[]; strings: Quoted[] };

/** Every leaf a token covers, in order: a string's quotes, runs and escapes, and its placeholders' own. */
function leaves(tokens: readonly ConsoleToken[], into: [number, number][] = []): [number, number][] {
	for (const token of tokens) {
		if (!token.parts) {
			into.push([token.start, token.end]);
			continue;
		}
		pieces(token.parts, into);
	}
	return into;
}

function pieces(parts: readonly ConsoleStringPart[], into: [number, number][] = []): [number, number][] {
	for (const part of parts) {
		if (part.kind === "placeholder") leaves(part.tokens, into);
		else into.push([part.start, part.end]);
	}
	return into;
}

const lineIn = (source: string, part: { start: number; end: number }) =>
	/[\r\n]/.test(source.slice(part.start, part.end));

describe("the one lexer, against the shared corpus", () => {
	it("holds every case the generator lists, as the lexer reads it now", () => {
		expect(vectors.cases).toEqual(
			CONSOLE_TOKEN_CASES.map(([name, input]) => ({ name, input, tokens: lexConsole(input) })),
		);
		expect(vectors.texts).toEqual(
			CONSOLE_TEXT_CASES.map(([name, input]) => ({ name, input, parts: lexConsoleText(input) })),
		);
		expect(vectors.scripts).toEqual(
			CONSOLE_SCRIPT_CASES.map(([name, input]) => ({ name, input, tokens: lexScript(input) })),
		);
		expect(vectors.strings).toEqual(
			CONSOLE_STRING_CASES.map(([name, input]) => ({ name, input, quoted: quoteConsoleString(input) })),
		);
	});

	it("writes a constant the lexer reads back as itself, and a text the lexer reads back as it says", () => {
		for (const { input, quoted } of vectors.strings) {
			expect(lexConsole(quoted)).toMatchObject([
				{ kind: "string", closed: true, value: input, end: quoted.length },
			]);
		}
		// Runs join where an escape was written, so compare what the whole says.
		const said = (parts: ConsoleStringPart[], source: string) =>
			parts
				.map((part) => (part.kind === "placeholder" ? source.slice(part.start, part.end) : part.value))
				.join("");
		for (const { input, parts } of vectors.texts) {
			// Between quotes a placeholder ends with its line, so one that passes a line is written on one.
			if (parts.some((part) => part.kind === "placeholder" && (!part.closed || lineIn(input, part)))) continue;
			const written = quoteConsoleText(input);
			const [token] = lexConsole(written);

			expect(token).toMatchObject({ kind: "string", closed: true, end: written.length });
			expect(said(token?.parts ?? [], written)).toBe(said(parts, input));
		}
	});

	for (const vector of vectors.cases) {
		it(`an expression: ${vector.name}`, () => {
			expect(lexConsole(vector.input)).toEqual(vector.tokens);
		});
	}
	for (const vector of vectors.texts) {
		it(`a text: ${vector.name}`, () => {
			expect(lexConsoleText(vector.input)).toEqual(vector.parts);
		});
	}
	for (const vector of vectors.scripts) {
		it(`a script: ${vector.name}`, () => {
			expect(lexScript(vector.input)).toEqual(vector.tokens);
		});
	}

	it("reads every character once, in order: no piece overlaps another or runs backwards", () => {
		const ordered = (spans: [number, number][], length: number) =>
			spans.every(([start, end], at) => start < end && end <= length && start >= (spans[at - 1]?.[1] ?? 0));

		for (const { input, tokens } of [...vectors.cases, ...vectors.scripts]) {
			expect(ordered(leaves(tokens), input.length)).toBe(true);
		}
		for (const { input, parts } of vectors.texts) expect(ordered(pieces(parts), input.length)).toBe(true);
	});

	it("reads a text as the body of the string that quotes it", () => {
		let compared = 0;
		for (const { input, parts } of vectors.texts) {
			// A quote, a line break or a backslash in a run means something else between quotes.
			const same = parts.every((part) =>
				part.kind === "placeholder"
					? part.closed && !lineIn(input, part)
					: part.kind === "escape" || !/["\n\\]/.test(part.value),
			);
			if (!same) continue;
			compared++;
			const [quoted] = lexConsole(`"${input}"`);
			const shifted = JSON.parse(JSON.stringify(lexConsoleText(input)), (key, value) =>
				key === "start" || key === "end" ? value + 1 : value,
			);

			expect(quoted?.parts).toEqual(shifted);
		}
		expect(compared).toBeGreaterThan(3);
	});
});
