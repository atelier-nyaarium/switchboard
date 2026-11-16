import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { unescapedBrace } from "../shared/icu-pattern.js";

const ANDROID_MAIN = path.join(
	import.meta.dirname,
	"..",
	"..",
	"android",
	"app",
	"src",
	"main",
	"java",
	"com",
	"atelier_nyaarium",
	"switchboard",
);

// OpenJDK tests cannot see an ICU refusal.

/** Regex literals, raw and quoted, with their patterns. */
function patternsIn(source: string): string[] {
	const found: string[] = [];
	for (const [, raw] of source.matchAll(/Regex\(\s*"""([\s\S]*?)"""/g)) found.push(raw);
	for (const [, quoted] of source.matchAll(/Regex\(\s*"((?:[^"\\\n]|\\.)*)"/g)) found.push(quoted);
	return found;
}

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

describe("ICU regex compatibility", () => {
	it("has no phone pattern carrying a brace ICU would refuse", () => {
		const offenders = kotlinFiles(ANDROID_MAIN).filter((file) =>
			patternsIn(fs.readFileSync(file, "utf8")).some(unescapedBrace),
		);
		expect(offenders).toEqual([]);
	});

	it("tells a literal brace from a quantifier", () => {
		expect(unescapedBrace("^\\{\\{[A-Za-z]+\\}\\}")).toBe(false);
		expect(unescapedBrace("[a-z]{0,126}/[a-z]")).toBe(false);
		expect(unescapedBrace("\\u2500{3,}")).toBe(false);
		expect(unescapedBrace("^\\{\\{[ \\t]*([A-Za-z][A-Za-z0-9_]*)[ \\t]*\\}\\}")).toBe(false);
		// The form that crashed the phone: a closing brace nothing opened.
		expect(unescapedBrace("^\\{\\{[A-Za-z]+}}")).toBe(true);
		expect(unescapedBrace("a}b")).toBe(true);
	});
});
