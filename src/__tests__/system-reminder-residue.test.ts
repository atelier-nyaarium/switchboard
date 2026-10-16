import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const SRC = path.join(import.meta.dirname, "..");
// The builder composes it from `REMINDER_TAG`; only its tests spell it.
const ALLOWED = new Set(["__tests__/system-reminder.test.ts"]);
// Built from pieces, so this file does not spell the tag.
const LITERAL_TAG = new RegExp(["<\\s*\\/?\\s*system", "[-_]reminder"].join(""), "i");

describe("system reminder residue", () => {
	it("builds the tag nowhere by hand", () => {
		const offenders = filesUnder(SRC)
			.map((file) => path.relative(SRC, file))
			.filter((rel) => !ALLOWED.has(rel) && LITERAL_TAG.test(readFileSync(path.join(SRC, rel), "utf8")));
		expect(offenders).toEqual([]);
	});

	it("catches a hand-built tag and passes the builder's constant", () => {
		expect(LITERAL_TAG.test(["`<", "system-reminder>`"].join(""))).toBe(true);
		expect(LITERAL_TAG.test(["</ ", "System_Reminder>"].join(""))).toBe(true);
		expect(LITERAL_TAG.test(["`<", "$", "{REMINDER_TAG}>`"].join(""))).toBe(false);
	});

	it("keeps every allowlist entry real", () => {
		for (const rel of ALLOWED) expect(LITERAL_TAG.test(readFileSync(path.join(SRC, rel), "utf8"))).toBe(true);
	});
});
