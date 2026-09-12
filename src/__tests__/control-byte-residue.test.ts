import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..", "..");

// A control byte written into source, rather than as an escape, makes the file BINARY to every tool
// that reads it: grep skips it, a diff will not show it, and the Lexicon index refuses it. It compiles,
// so no gate here sees it. An escape sequence in source is text and is fine; a raw byte is not.
// Built from escaped text, so this guard does not have to exempt itself.
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]");

/** Deliberate: both assert on terminal escapes, so the byte IS the subject. */
const ALLOWED = new Set([
	"android/app/src/test/java/com/atelier_nyaarium/switchboard/AgentScreenVectorsTest.kt",
	"src/__tests__/agent-screen-vectors.test.ts",
]);

function tracked(): string[] {
	return execFileSync("git", ["ls-files", "*.kt", "*.ts", "*.tsx"], { cwd: ROOT, encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
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
