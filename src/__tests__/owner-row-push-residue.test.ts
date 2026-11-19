import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const SRC = path.resolve(import.meta.dirname, "..");
const CALL = /\bpushOwnerRow\(/g;

/** Calls, outside its own definition. */
function calls(source: string): number {
	return [...source.matchAll(CALL)].length - (source.includes("function pushOwnerRow(") ? 1 : 0);
}

describe("owner row push residue", () => {
	it("pushes an owner row from the inbox's one listener alone", () => {
		const callers = filesUnder(SRC)
			.filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
			.map((file) => ({ file: path.relative(SRC, file), count: calls(readFileSync(file, "utf8")) }))
			.filter(({ count }) => count > 0);
		expect(callers).toEqual([{ file: path.join("federation-server", "ownerServices.ts"), count: 1 }]);
	});

	it("counts a call and spares the definition", () => {
		expect(calls("sockets.pushOwnerRow(domainId, row);")).toBe(1);
		expect(calls("function pushOwnerRow(domainId: string) {}")).toBe(0);
	});
});
