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

// A long-lived scope outlives the call that made it, so a throw inside one has no caller to catch
// it. A SupervisorJob only stops a sibling from being cancelled; the process still goes down. These
// scopes reach the Router, where a dead network throws, and no gate here runs the phone.
const SCOPE = /=\s*CoroutineScope\(/g;

/** Where a `CoroutineScope(` declaration ends, by paren depth. */
function declarationAt(source: string, from: number): string {
	let depth = 0;
	for (let i = source.indexOf("(", from); i < source.length; i++) {
		if (source[i] === "(") depth++;
		else if (source[i] === ")" && --depth === 0) return source.slice(from, i + 1);
	}
	return source.slice(from);
}

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

/** Handlers the file names, since a scope may reference one rather than inline it. */
function handlerNamesIn(source: string): string[] {
	return [...source.matchAll(/val\s+(\w+)\s*=\s*CoroutineExceptionHandler/g)].map((match) => match[1] as string);
}

function bareScopesIn(source: string): string[] {
	const named = handlerNamesIn(source);
	const found: string[] = [];
	for (const match of source.matchAll(SCOPE)) {
		const declaration = declarationAt(source, match.index);
		const handled =
			declaration.includes("CoroutineExceptionHandler") || named.some((name) => declaration.includes(name));
		if (!handled) found.push(declaration.replace(/\s+/g, " "));
	}
	return found;
}

describe("long-lived coroutine scopes", () => {
	it("has none that would take the process down", () => {
		const offenders = kotlinFiles(ANDROID_MAIN).flatMap((file) =>
			bareScopesIn(fs.readFileSync(file, "utf8")).map((scope) => `${path.basename(file)}: ${scope}`),
		);
		expect(offenders).toEqual([]);
	});

	it("tells a handled scope from a bare one", () => {
		expect(bareScopesIn("val s = CoroutineScope(Dispatchers.IO)")).toHaveLength(1);
		expect(bareScopesIn("val s = CoroutineScope(SupervisorJob() + Dispatchers.Main)")).toHaveLength(1);
		expect(
			bareScopesIn(
				"val s = CoroutineScope(SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, e -> log(e) })",
			),
		).toEqual([]);
		// A composition scope is scoped to its caller, so it is not what this reads.
		expect(bareScopesIn("val scope = rememberCoroutineScope()")).toEqual([]);
		// A handler the file names counts as much as one written in place.
		expect(
			bareScopesIn(
				"private val h = CoroutineExceptionHandler { _, e -> log(e) }\nval s = CoroutineScope(SupervisorJob() + Dispatchers.Default + h)",
			),
		).toEqual([]);
	});
});
