import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SKEW_WINDOWS } from "../shared/skew-windows.js";

const root = resolve(import.meta.dirname, "../..");
const DATE = /\b20\d\d-\d\d-\d\d\b/;
const TAG = /skew:([a-z0-9-]+)/g;

const files = execFileSync("git", ["ls-files", "src/*.ts", "scripts/*.ts", "android/app/src/main/*.kt"], {
	cwd: root,
	encoding: "utf8",
})
	.split("\n")
	.filter((file) => file !== "" && !file.startsWith("src/__tests__/") && !file.endsWith("skew-windows.ts"));

/** The comment part of a line; a string's `://` is not one. */
function commentOf(line: string): string | null {
	const trimmed = line.trimStart();
	if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return trimmed;
	const at = line.search(/(?<!:)\/\/|\/\*/);
	return at < 0 ? null : line.slice(at);
}

const comments = files.flatMap((file) =>
	readFileSync(join(root, file), "utf8")
		.split("\n")
		.map((line, index) => ({ where: `${file}:${index + 1}`, text: commentOf(line) }))
		.filter((row): row is { where: string; text: string } => row.text !== null),
);

const today = (): string => {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

describe("skew windows", () => {
	it("tags every dated comment with a window instead of a date", () => {
		const dated = comments.filter((row) => DATE.test(row.text) && !row.text.includes("skew:"));
		expect(dated.map((row) => `${row.where}: ${row.text.trim()}`)).toEqual([]);
	});

	it("names only windows the table holds, and every window has a site", () => {
		const used = new Set<string>();
		const unknown: string[] = [];
		for (const row of comments) {
			for (const [, id] of row.text.matchAll(TAG)) {
				used.add(id as string);
				if (!Object.hasOwn(SKEW_WINDOWS, id as string)) unknown.push(`${row.where}: ${id}`);
			}
		}
		expect(unknown).toEqual([]);
		expect(Object.keys(SKEW_WINDOWS).filter((id) => !used.has(id))).toEqual([]);
	});

	it("holds no window past its date: close it, or move it and say why", () => {
		const passed = Object.entries(SKEW_WINDOWS)
			.filter(([, row]) => row.closes < today())
			.map(([id, row]) => `${id} closed ${row.closes}`);
		expect(Object.values(SKEW_WINDOWS).every((row) => DATE.test(row.closes))).toBe(true);
		expect(passed).toEqual([]);
	});

	it("reads a comment after code, and never a URL in a string", () => {
		expect([
			commentOf("\tfoo(); // skew:x"),
			commentOf('\tconst u = "https://a";'),
			commentOf("\t * text"),
		]).toEqual(["// skew:x", null, "* text"]);
	});
});
