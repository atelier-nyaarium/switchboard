import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const SRC = path.join(import.meta.dirname, "..");
/** Live-memory snapshot allowlist. */
const SNAPSHOT_WRITERS = new Map([
	["shared/durable-store.ts", "the owner: `commitChecked` itself"],
	["gateway/composeGateway.ts", "the session snapshot after an assistant placement"],
	["gateway/compose/composeListener.ts", "the shutdown flush"],
	["gateway/compose/composePersistence.ts", "the persist tick"],
	["gateway/compose/composeSessions.ts", "the session snapshot behind an agent catalog commit"],
	["gateway/compose/composeStores.ts", "the quarantine copy of a refused restore"],
]);
const checkedCall = /\.saveChecked\(/;

describe("checked commit ownership", () => {
	it("routes every store's checked write through commitChecked", () => {
		const offenders = filesUnder(SRC)
			.map((file) => path.relative(SRC, file))
			.filter((file) => !file.startsWith("__tests__") && !file.startsWith("testing"))
			.filter((file) => !SNAPSHOT_WRITERS.has(file))
			.filter((file) => checkedCall.test(readFileSync(path.join(SRC, file), "utf8")));
		expect(offenders).toEqual([]);
	});

	it("names only files that still write a checked snapshot", () => {
		const stale = [...SNAPSHOT_WRITERS.keys()].filter(
			(file) => !checkedCall.test(readFileSync(path.join(SRC, file), "utf8")),
		);
		expect(stale).toEqual([]);
	});
});
