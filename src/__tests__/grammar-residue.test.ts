import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.join(import.meta.dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(REPO, file), "utf8");

function walk(dir: string, into: string[] = []): string[] {
	for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(file, into);
		} else if (entry.name.endsWith(".ts")) into.push(file);
	}
	return into;
}

const SOURCES = walk("src");

/** Where expressions, texts and scripts are read. */
const LANGUAGE = SOURCES.filter(
	(file) =>
		file.startsWith("src/gateway/liveConsole/") ||
		file.startsWith("src/gateway/computed/") ||
		/^src\/shared\/(live-console-grammar|script-grammar|script-types|text-holes|automation-fit)\.ts$/.test(file),
);

const GRAMMAR = "src/shared/live-console-grammar.ts";
const SCRIPT = "src/shared/script-grammar.ts";

/** Who may turn characters into tokens, and why. */
const LEXES: Record<string, readonly string[]> = {
	[GRAMMAR]: ["lexConsole", "lexConsoleText"],
	// A script's statements.
	[SCRIPT]: ["lexScript"],
	// Whether a text holds a hole, and a text with its holes unread.
	"src/shared/text-holes.ts": ["lexConsoleText"],
};

const CALL = /\b(lexConsole|lexConsoleText|lexScript)\(/g;
/** A character held against a quote, a brace or a backslash: compared, switched on, or searched for. */
const MARK = String.raw`(?:'"'|"'"|"[{}]"|'[{}]'|"\\\\"|'\\\\')`;
const QUOTE = new RegExp(
	String.raw`[!=]==\s*${MARK}|${MARK}\s*[!=]==|\bcase\s+${MARK}|\b(?:lastIndexOf|indexOf)\(${MARK}`,
);
/** Brackets counted by hand. */
const COUNTED = /\b(?:depth|open|nest|level)\s*(?:\+\+|--|[+-]=\s*1)|(?:\+\+|--)(?:depth|open|nest|level)\b/;
/** Space decided apart from the lexer. */
const SPACED = /\.trim(?:Start|End)?\(\)/;
/** A hole's own source, read apart from its text. */
const SLICED = /\b(?:part|hole|piece)\.source\b/;
/** The scanners this language once had. */
const GONE = /\b(?:scanScript|splitTop|holeEnd|canonicalRun|ScriptPiece)\b|\b(?:readText|printText|unfilled)\(/;

describe("one lexer and one parser read the language", () => {
	it("knows a second scanner when it sees one", () => {
		expect(QUOTE.test(`if (c === '"' || c === "'") {`)).toBe(true);
		expect(QUOTE.test(`while (text[at] !== '"') at++;`)).toBe(true);
		expect(QUOTE.test(`const QUOTED = { '"': '\\\\"' };`)).toBe(false);
		expect(QUOTE.test(`switch (c) { case '"': return 1; }`)).toBe(true);
		expect(QUOTE.test(`const end = text.indexOf('"', at + 1);`)).toBe(true);
		expect(QUOTE.test(`if (c === "{") open++;`)).toBe(true);
		expect(QUOTE.test(String.raw`if (c === "\\") at += 2;`)).toBe(true);
		expect(COUNTED.test("depth += 1;")).toBe(true);
		expect(COUNTED.test("open++;")).toBe(true);
		expect(SPACED.test("const written = source.trim();")).toBe(true);
		expect(COUNTED.test("if (OPENERS.has(token.text)) depth++;")).toBe(true);
		expect(COUNTED.test("walk(inner, depth + 1);")).toBe(false);
		expect(SLICED.test("parseConsole(part.source)")).toBe(true);
		expect(SLICED.test("piece.node")).toBe(false);
		expect(GONE.test("const pieces = scanScript(source);")).toBe(true);
	});

	it("lexes only where this list says, each for its reason", () => {
		const found = Object.fromEntries(
			SOURCES.map((file) => [
				file,
				[...new Set([...read(file).matchAll(CALL)].map((match) => match[1]))].sort(),
			]).filter(([, names]) => (names as string[]).length > 0),
		);

		expect(found).toEqual(LEXES);
	});

	it("decides where a string ends in the lexer alone", () => {
		// The two parsers hold a token's text against a brace, never a character.
		expect(LANGUAGE.filter((file) => file !== GRAMMAR && file !== SCRIPT && QUOTE.test(read(file)))).toEqual([]);
	});

	it("reads an expression's own span from the lexer, never by trimming", () => {
		// Where source of this language is cut to its tokens.
		const cutters = ["src/gateway/computed/automationScript.ts", "src/gateway/liveConsole/holes.ts"];

		expect(cutters.filter((file) => SPACED.test(read(file)))).toEqual([]);
	});

	it("counts brackets in the lexer and the parsers alone", () => {
		expect(LANGUAGE.filter((file) => file !== GRAMMAR && file !== SCRIPT && COUNTED.test(read(file)))).toEqual([]);
	});

	it("parses no slice a second time, and keeps the old scanners gone", () => {
		expect(LANGUAGE.filter((file) => SLICED.test(read(file)))).toEqual([]);
		expect(LANGUAGE.filter((file) => GONE.test(read(file)))).toEqual([]);
	});

	const PHONE = "android/app/src/main/java/com/atelier_nyaarium/switchboard";
	const kotlin = (dir: string): string[] =>
		fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
			const file = path.join(dir, entry.name);
			return entry.isDirectory() ? kotlin(file) : entry.name.endsWith(".kt") ? [file] : [];
		});
	const TOKENS = `${PHONE}/liveconsole/ConsoleTokens.kt`;
	/** Who may lex on the phone, and why. */
	const PHONE_LEXES: Record<string, readonly string[]> = {
		// Paint, the names a read sends, a key's one token.
		[`${PHONE}/liveconsole/ConsoleRules.kt`]: ["lexConsole", "lexConsoleText", "lexScript"],
		// Hints and completions.
		[`${PHONE}/liveconsole/ConsoleAssist.kt`]: ["lexConsole", "lexConsoleText", "lexScript"],
		// Where the cursor's hole is, its close and its gap.
		[`${PHONE}/assistant/HoleTextRules.kt`]: ["lexConsoleText"],
		// Whether a text holds a hole.
		[`${PHONE}/assistant/AutomationParts.kt`]: ["lexConsoleText"],
		// A value that is one name.
		[`${PHONE}/assistant/RunsDraft.kt`]: ["lexConsole"],
		// A choice subject's field.
		[`${PHONE}/assistant/SwitchCases.kt`]: ["lexConsole"],
		// A script's case lines.
		[`${PHONE}/assistant/ScriptDraft.kt`]: ["lexScript"],
		// The emulator's canned reads.
		[`${PHONE}/SandboxAutomations.kt`]: ["lexConsole", "lexConsoleText"],
	};
	/** A character held against a quote, in Kotlin. */
	const KOTLIN_QUOTE = /[!=]=\s*'(?:"|\\')'/;
	const PHONE_LANGUAGE = (file: string) =>
		file.startsWith(`${PHONE}/liveconsole/`) ||
		file === `${PHONE}/assistant/HoleTextRules.kt` ||
		file === `${PHONE}/SandboxAutomations.kt`;

	it("holds the phone to the same: its lexer's twin alone ends a string, and no pattern reads the language", () => {
		const files = kotlin(PHONE);
		const found = Object.fromEntries(
			files
				.filter((file) => file !== TOKENS)
				.map((file) => [file, [...new Set([...read(file).matchAll(CALL)].map((match) => match[1]))].sort()])
				.filter(([, names]) => (names as string[]).length > 0),
		);

		expect(KOTLIN_QUOTE.test("if (c == '\"' || c == '\\'') {")).toBe(true);
		expect(found).toEqual(PHONE_LEXES);
		expect(
			files.filter((file) => file !== TOKENS && PHONE_LANGUAGE(file) && KOTLIN_QUOTE.test(read(file))),
		).toEqual([]);
		expect(files.filter((file) => PHONE_LANGUAGE(file) && /\bRegex\(|\.toRegex\(/.test(read(file)))).toEqual([]);
	});
});
