import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const SRC = path.resolve(import.meta.dirname, "..", "gateway");
const FORGET = /\b(?:[$\w]+\.)*inboxClaims(?:\?\.|\.)forget\s*\(/g;

const calls = (source: string): number => [...source.matchAll(FORGET)].length;

describe("inbox claim deletion residue", () => {
	it("finds calls on an inboxClaims receiver", () => {
		expect(calls("stores.inboxClaims.forget(address)")).toBe(1);
		expect(calls("stores.inboxClaims.at(address)")).toBe(0);
	});

	it("forgets a claim only through dropOrphans", () => {
		const gateway = readFileSync(path.join(SRC, "composeGateway.ts"), "utf8");
		const dropOrphans = gateway.match(/dropOrphans:\s*\(found\)\s*=>\s*\{[\s\S]*?\n\t\t\},/)?.[0] ?? "";
		const found = filesUnder(SRC)
			.filter((file) => file.endsWith(".ts") && !file.includes(`${path.sep}__tests__${path.sep}`))
			.map((file) => ({ file: path.relative(SRC, file), count: calls(readFileSync(file, "utf8")) }))
			.filter(({ count }) => count > 0);
		expect(found).toEqual([{ file: path.join("composeGateway.ts"), count: 1 }]);
		expect(calls(dropOrphans)).toBe(1);
	});
});
