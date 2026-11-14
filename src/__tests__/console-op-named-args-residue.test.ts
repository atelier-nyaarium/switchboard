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

// Positional calls risk swaps.
const CALL = /\bConsoleOp\.[A-Z]\w*\(/g;
const NAMED = /^\s*\w+\s*=(?!=)/;

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) {
			if (entry !== "proto") kotlinFiles(full, acc);
		} else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

/** Top-level call arguments. */
function argumentsAt(source: string, open: number): string[] {
	const args: string[] = [];
	let depth = 0;
	let start = open + 1;
	for (let i = open; i < source.length; i++) {
		const char = source[i];
		if (char === '"') {
			const raw = source.startsWith('"""', i);
			const close = raw ? '"""' : '"';
			let j = i + close.length;
			while (j < source.length && !source.startsWith(close, j)) j += !raw && source[j] === "\\" ? 2 : 1;
			i = j + close.length - 1;
			continue;
		}
		if (char === "(" || char === "[" || char === "{") depth++;
		else if (char === ")" || char === "]" || char === "}") {
			depth--;
			if (depth === 0) {
				args.push(source.slice(start, i));
				return args.filter((arg) => arg.trim() !== "");
			}
		} else if (char === "," && depth === 1) {
			args.push(source.slice(start, i));
			start = i + 1;
		}
	}
	return args;
}

function positionalCalls(source: string): string[] {
	const found: string[] = [];
	for (const match of source.matchAll(CALL)) {
		const open = match.index + match[0].length - 1;
		const args = argumentsAt(source, open);
		if (args.length >= 2 && args.some((arg) => !NAMED.test(arg))) {
			found.push(`${match[0]}${args.map((arg) => arg.trim()).join(", ")})`.replace(/\s+/g, " "));
		}
	}
	return found;
}

describe("console op constructors", () => {
	it("name every argument when they take two or more", () => {
		const offenders = kotlinFiles(ANDROID_MAIN).flatMap((file) =>
			positionalCalls(fs.readFileSync(file, "utf8")).map((call) => `${path.basename(file)}: ${call}`),
		);
		expect(offenders).toEqual([]);
	});

	it("reads arguments by syntax, not by substring", () => {
		expect(positionalCalls('ConsoleOp.DeviceRename(id = id, name = "a, b", revision = r)')).toEqual([]);
		expect(positionalCalls("ConsoleOp.Wake(target = t, harness = listOf(a, b))")).toEqual([]);
		expect(positionalCalls("ConsoleOp.DeviceRead(id)")).toEqual([]);
		expect(positionalCalls("ConsoleOp.DeviceSet(id, verb = v)")).toHaveLength(1);
		expect(positionalCalls("ConsoleOp.VaultAnswer(x, note?.trim()?.ifEmpty { null })")).toHaveLength(1);
	});
});
