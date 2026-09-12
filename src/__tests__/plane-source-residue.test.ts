import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const SRC = path.join(import.meta.dirname, "..");

/**
 * Presence derives "online" from this socket field, and the registration announcement fires before
 * the handshake resolves. A bare assignment therefore publishes "verifying" and leaves the phone
 * there until the tripwire. `confirmHandshake` in websocket.ts owns the flip and its announcement.
 */
const setsTrue = /\bhandshakeConfirmed\s*=\s*true\b/;

function assignmentsIn(source: string): number[] {
	return source
		.split("\n")
		.map((line, index) => (setsTrue.test(line) ? index : -1))
		.filter((index) => index >= 0);
}

/** Inside the owner, meaning the nearest function opened above it is confirmHandshake. */
function ownedByConfirmHandshake(source: string, line: number): boolean {
	const above = source.split("\n").slice(0, line).reverse();
	const opener = above.find((text) => /^\t*(?:async )?function \w+/.test(text));
	return opener !== undefined && /function confirmHandshake\b/.test(opener);
}

describe("plane source ownership", () => {
	it("only confirmHandshake raises handshakeConfirmed", () => {
		const offenders: string[] = [];
		for (const file of filesUnder(SRC)) {
			if (file === import.meta.filename) continue;
			const source = readFileSync(file, "utf8");
			for (const line of assignmentsIn(source)) {
				const owned = path.basename(file) === "websocket.ts" && ownedByConfirmHandshake(source, line);
				if (!owned) offenders.push(`${path.relative(SRC, file)}:${line + 1}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("reads an assignment inside the owner and one outside it", () => {
		const owner = ["\tfunction confirmHandshake(ws) {", "\t\tws.data.handshakeConfirmed = true;", "\t}"].join("\n");
		expect(assignmentsIn(owner)).toEqual([1]);
		expect(ownedByConfirmHandshake(owner, 1)).toBe(true);

		const stray = ["\tfunction register(ws) {", "\t\tws.data.handshakeConfirmed = true;", "\t}"].join("\n");
		expect(ownedByConfirmHandshake(stray, 1)).toBe(false);

		// Initialising to false on a fresh socket is not the flip presence reads.
		expect(assignmentsIn("ws.data.handshakeConfirmed = false;")).toEqual([]);
	});
});
