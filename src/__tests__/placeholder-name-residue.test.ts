import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.join(import.meta.dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(REPO, file), "utf8");

/** An entity looked up by a name, outside the one resolver. */
const LOOKUP = /\bregistry\.get\(/;
/** A scope spread together by hand. */
const MERGE = /\.\.\.\s*functionScopeOf\(|\.\.\.\s*\(?fire\.names\b/;

/** Files a placeholder's name passes through. */
const READERS = [
	"src/gateway/liveConsole/placeholders.ts",
	"src/gateway/liveConsole/evaluate.ts",
	"src/gateway/computed/automationPreview.ts",
	"src/gateway/computed/automationValidity.ts",
	"src/gateway/computed/automationText.ts",
	"src/gateway/computed/automations.ts",
];

describe("a placeholder's name has one resolver and one scope", () => {
	it("refuses a lookup and a hand merge, and takes the resolver", () => {
		expect(LOOKUP.test("if (registry.get(node.name, AUDIENCE)) return x;")).toBe(true);
		expect(LOOKUP.test("resolveName(registry, AUDIENCE, node.name, held)")).toBe(false);
		expect(MERGE.test("return { ...functionScopeOf(params, args), ...names };")).toBe(true);
		expect(MERGE.test("return { ...scope, ...(fire.names ?? {}) };")).toBe(true);
		expect(MERGE.test("return placeholderScope(fire.names, params, args, deviceName);")).toBe(false);
	});

	it("resolves a name in the registry's resolver alone", () => {
		expect(READERS.filter((file) => LOOKUP.test(read(file)))).toEqual([]);
	});

	it("builds a scope in automationScope.ts alone", () => {
		expect(READERS.filter((file) => MERGE.test(read(file)))).toEqual([]);
	});
});
