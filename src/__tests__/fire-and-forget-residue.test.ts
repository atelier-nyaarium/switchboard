import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const SRC = path.join(import.meta.dirname, "..", "gateway");
const ALLOWLIST = new Map([
	["codexRelay.ts", "serialize answers its own failure"],
	["copilotRelay.ts", "serialize answers its own failure"],
	["sessionRegistryReporter.ts", "a refused write stays pending and retries"],
	["keyRequester.ts", "the batch reports its own failure"],
	["relay.ts", "tryOnce catches every attempt and resolves the outcome"],
]);
// Fences the gateway only, where the owner lives. The Router and the MCP plugin answer failure
// their own way and are not covered. A multi-line `void` and a chain that rejects after its
// `.then(` are not caught either.
const discardedWork = /^[ \t]*void[ \t]+(?!0\b)[^(\s][^;\n]*;[ \t]*$/gm;

function hasResidue(source: string): boolean {
	for (const [statement] of source.matchAll(discardedWork)) {
		if (!statement.includes(".then(") && !statement.includes(".catch(")) return true;
	}
	return false;
}

describe("discarded work ownership", () => {
	it("has no unwatched background work outside the shared owner", () => {
		const offenders = filesUnder(SRC).filter((file) => {
			// Skip owner and controls.
			if (path.basename(file) === "fireAndForget.ts" || file === import.meta.filename) return false;
			if (ALLOWLIST.has(path.basename(file))) return false;
			return hasResidue(readFileSync(file, "utf8"));
		});
		expect(offenders).toEqual([]);
	});

	it("matches a discarded promise and spares the forms that answer for themselves", () => {
		expect(hasResidue(["\tvoid ", "drainOutbox();"].join(""))).toBe(true);
		expect(hasResidue(["\tvoid ", "this.serialize(key, id);"].join(""))).toBe(true);
		expect(hasResidue(["\tvoid ", "pump?.resendReceipts();"].join(""))).toBe(true);
		expect(hasResidue(["\tfireAndForget(", '"drain", drainOutbox());'].join(""))).toBe(false);
		// Spare chained work and values.
		expect(hasResidue(["\tvoid ", "wake"].join(""))).toBe(false);
		expect(hasResidue(["\tvoid ", "(async () => {"].join(""))).toBe(false);
		expect(hasResidue(["\tvoid ", "work.then("].join(""))).toBe(false);
		expect(hasResidue(["\tvoid ", "0;"].join(""))).toBe(false);
	});
});
