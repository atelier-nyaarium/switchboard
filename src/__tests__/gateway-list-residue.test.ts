import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

/** Where the list type and its reads are declared. */
const HOME = "GatewayRegistry.kt";

// Unread must not read as empty.
const FLATTENED =
	/listedRows\(\)\s*(?:\.orEmpty\(\)|\.isNullOrEmpty\(\)|\?:\s*emptyList\b|\?\.size\s*\?:\s*0\b)|as\?\s*GatewayList\.Listed\b/g;

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

function code(source: string): string {
	return source
		.split("\n")
		.filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
		.join("\n");
}

function flattenedIn(source: string): number {
	return [...code(source).matchAll(FLATTENED)].length;
}

/** Members declared on the interface itself, not on a variant. */
function sharedMembers(source: string): string[] {
	const lines = code(source).split("\n");
	const start = lines.findIndex((line) => /^sealed interface GatewayList\b/.test(line));
	if (start < 0) return ["GatewayList not found"];
	const members: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith("}")) break;
		if (/^\t(?:override\s+)?(?:val|var|fun)\b/.test(line)) members.push(line.trim());
	}
	return members;
}

describe("A Gateway's list", () => {
	it("holds rows on its listed answer alone", () => {
		expect(sharedMembers(fs.readFileSync(path.join(ANDROID_MAIN, HOME), "utf8"))).toEqual([]);
	});

	it("is never flattened to an empty list by a reader", () => {
		const offenders = kotlinFiles(ANDROID_MAIN)
			.filter((file) => path.basename(file) !== HOME)
			.filter((file) => flattenedIn(fs.readFileSync(file, "utf8")) > 0)
			.map((file) => path.relative(ANDROID_MAIN, file));
		expect(offenders).toEqual([]);
	});

	it("tells a flattening read from a typed one", () => {
		expect(flattenedIn("entry.routines.listedRows().orEmpty()")).toBe(1);
		expect(flattenedIn("entry.routines.listedRows() ?: emptyList()")).toBe(1);
		expect(flattenedIn("(entry.peers as? GatewayList.Listed)?.rows")).toBe(1);
		expect(flattenedIn("if (entry.routines.listedRows().isNullOrEmpty()) none()")).toBe(1);
		expect(flattenedIn("val uses = entry.automations.listedRows()?.size ?: 0")).toBe(1);
		expect(flattenedIn("entry.routines.listedRows()?.let { usesOf(it) }")).toBe(0);
		expect(flattenedIn("// entry.routines.listedRows().orEmpty()")).toBe(0);
		expect(
			sharedMembers("sealed interface GatewayList<out T> {\n\tval rows: List<T> get() = emptyList()\n}"),
		).toHaveLength(1);
		expect(
			sharedMembers(
				"sealed interface GatewayList<out T> {\n\tdata class Listed<T>(val rows: List<T>) : GatewayList<T>\n}",
			),
		).toEqual([]);
	});
});
