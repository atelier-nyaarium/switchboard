import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const SRC = path.join(import.meta.dirname, "..");
/** Live-memory snapshot allowlist. */
const SNAPSHOT_WRITERS = new Map([
	["shared/durable-store.ts", "the owner: `commitChecked` itself"],
	["gateway/composeGateway.ts", "the clean-shutdown session snapshot"],
	["gateway/compose/composePersistence.ts", "the persist tick"],
	["gateway/compose/composeStores.ts", "the quarantine copy of a refused restore"],
]);
const checkedCall = /\.saveChecked\(/;
/** Allowed writes and reasons. */
const DIRECT_WRITE_EXCEPTIONS = new Map([
	["gateway/federation/identity.ts", { writes: 1, reason: "exclusive identity creation" }],
	["gateway/router/transport.ts", { writes: 1, reason: "best-effort reach cache" }],
	["gateway/compose/composeBootstrap.ts", { writes: 1, reason: "schema-version sentinel" }],
	["gateway/federation/bootstrapInstall.ts", { writes: 3, reason: "staged install artifacts" }],
	["gateway/federation/enrollTls.ts", { writes: 1, reason: "temporary OpenSSL extension input" }],
]);
const directWrite = /\b(?:fs\.)?writeFileSync\s*\(|\bwriteFileAtomic\s*\(/g;
const installedCheck = /instanceof\s+DurableStoreInstalledError/;

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

	it("limits gateway file writes to reasoned exceptions", () => {
		const counts = new Map(
			filesUnder(path.join(SRC, "gateway"))
				.map((file) => path.relative(SRC, file))
				.map(
					(file) =>
						[file, readFileSync(path.join(SRC, file), "utf8").match(directWrite)?.length ?? 0] as const,
				)
				.filter(([, writes]) => writes > 0),
		);
		const offenders = [...counts]
			.filter(([file, writes]) => writes !== DIRECT_WRITE_EXCEPTIONS.get(file)?.writes)
			.map(([file]) => file);
		const stale = [...DIRECT_WRITE_EXCEPTIONS.keys()].filter((file) => !counts.has(file));
		expect(offenders).toEqual([]);
		expect(stale).toEqual([]);
	});

	it("reads installed-write errors only in the durable store", () => {
		const offenders = filesUnder(SRC)
			.map((file) => path.relative(SRC, file))
			.filter((file) => file !== "shared/durable-store.ts")
			.filter((file) => installedCheck.test(readFileSync(path.join(SRC, file), "utf8")));
		expect(offenders).toEqual([]);
	});
});
