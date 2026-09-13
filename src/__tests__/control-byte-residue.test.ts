import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..", "..");

// A control byte written into source, rather than as an escape, makes the file BINARY to every tool
// that reads it: grep skips it, a diff will not show it, and the Lexicon index refuses it. It compiles,
// so no gate here sees it. An escape sequence in source is text and is fine; a raw byte is not.
// Built from escaped text, so this guard does not have to exempt itself.
// biome-ignore lint/complexity/useRegexLiterals: a literal is a control-character regex.
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]");

/** Zero-width and format characters, the em dash, and smart quotes. Built from code points. */
const FORBIDDEN_TEXT = new Set([0xfeff, 0x200b, 0x200c, 0x200d, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d]);

/** Deliberate: both assert on terminal escapes, so the byte IS the subject. */
const ALLOWED = new Set([
	"android/app/src/test/java/com/atelier_nyaarium/switchboard/AgentScreenVectorsTest.kt",
	"src/__tests__/agent-screen-vectors.test.ts",
]);

/** Tracked and not yet added, so a working tree is read as it will be committed. */
function sources(...patterns: string[]): string[] {
	return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", ...patterns], {
		cwd: ROOT,
		encoding: "utf8",
	})
		.split("\n")
		.filter((file) => file && fs.existsSync(path.join(ROOT, file)));
}

function tracked(): string[] {
	return sources("*.kt", "*.ts", "*.tsx");
}

function forbiddenIn(name: string, text: string): string[] {
	const found: string[] = [];
	text.split("\n").forEach((line, index) => {
		for (const character of line) {
			const point = character.codePointAt(0) ?? 0;
			if (FORBIDDEN_TEXT.has(point)) found.push(`${name}:${index + 1}: U+${point.toString(16).toUpperCase()}`);
		}
	});
	return found;
}

describe("control bytes in source", () => {
	it("finds none outside the files whose subject they are", () => {
		const offenders = tracked().filter(
			(file) => !ALLOWED.has(file) && CONTROL.test(fs.readFileSync(path.join(ROOT, file), "utf8")),
		);

		expect(offenders).toEqual([]);
	});

	it("reads an escape as text and a raw byte as a byte", () => {
		expect(CONTROL.test('val sep = "\\u0000"')).toBe(false);
		// Built, not written: a literal here would put the byte in this file.
		expect(CONTROL.test(`val sep = "${String.fromCharCode(0)}"`)).toBe(true);
		expect(CONTROL.test("tabs\tand\nnewlines are fine\r\n")).toBe(false);
	});
});

describe("zero-width characters and banned punctuation", () => {
	it("finds none in Kotlin, TypeScript or markdown", () => {
		const files = sources("*.kt", "*.ts", "*.tsx", "*.md");
		expect(files.length).toBeGreaterThan(100);

		const found = files.flatMap((file) => forbiddenIn(file, fs.readFileSync(path.join(ROOT, file), "utf8")));

		expect(
			found,
			"Construct the character from its code point (String.fromCodePoint in TypeScript, Char(0x2014) in Kotlin); in prose, reword.",
		).toEqual([]);
	});

	it("names each character it refuses, and passes plain punctuation", () => {
		for (const point of FORBIDDEN_TEXT) {
			expect(forbiddenIn("probe", `a${String.fromCodePoint(point)}b`)).toHaveLength(1);
		}
		expect(forbiddenIn("probe", `"quoted" - it's plain`)).toEqual([]);
	});
});
