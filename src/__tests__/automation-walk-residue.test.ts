import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.join(import.meta.dirname, "..", "..");
const PHONE = "android/app/src/main/java/com/atelier_nyaarium/switchboard";

/** The walk itself. */
const WALK = "src/shared/automation-walk.ts";

/** The compiler-checked read shapes. */
const SAMPLES = "src/__tests__/automation-walk-seal.ts";

function filesUnder(dir: string, ext: string, skip: string | undefined, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
		const rel = `${dir}/${entry.name}`;
		if (skip !== undefined && rel === skip) continue;
		if (entry.isDirectory()) filesUnder(rel, ext, skip, acc);
		else if (entry.name.endsWith(ext) && !entry.name.endsWith(`.test${ext}`)) acc.push(rel);
	}
	return acc;
}

const read = (file: string) => fs.readFileSync(path.join(REPO, file), "utf8");

/** Casts that would unseal a list. */
const UNSEAL =
	/\bas\s+(?:readonly\s+)?AutomationAction\[\]|\bas\s+Sealed\b|\bactions\b[^\n]*\bas\s+unknown\s+as\b|\bas\s+unknown\s+as[^\n]*\bactions\b/;

describe("the one walk", () => {
	it("keeps a sample of every read shape the seal refuses", () => {
		const expected = read(SAMPLES).match(/@ts-expect-error/g) ?? [];

		expect(expected.length).toBeGreaterThanOrEqual(7);
	});

	it("names OpensWalk only where the phone's walk takes it", () => {
		const naming = filesUnder("android/app/src/main", ".kt", undefined).filter((file) =>
			/\bOpensWalk\b/.test(read(file)),
		);

		const allowed = [`${PHONE}/assistant/AutomationWalk.kt`, `${PHONE}/proto/Protocol.kt`];
		expect(naming.filter((file) => !allowed.includes(file))).toEqual([]);
		expect(naming).toContain(`${PHONE}/proto/Protocol.kt`);
	});

	it("opens a list as written only where syntax is read, and everything else through the walk", () => {
		const importers = (opener: string) =>
			filesUnder("src", ".ts", "src/__tests__").filter((file) =>
				new RegExp(
					`import\\s*\\{[^}]*\\b${opener}\\b[^}]*\\}\\s*from\\s*"[./]*shared/automation-walk\\.js"`,
				).test(read(file)),
			);

		expect(importers("written")).toEqual(["src/gateway/computed/automationText.ts"]);
		expect(importers("reached").length).toBeGreaterThan(0);
	});

	it("casts no list open outside the walk", () => {
		const casting = filesUnder("src", ".ts", "src/__tests__").filter(
			(file) => file !== WALK && UNSEAL.test(read(file)),
		);

		expect(casting).toEqual([]);
		expect(
			[
				"x as AutomationAction[]",
				"x as readonly AutomationAction[]",
				"x as Sealed<A>",
				"a.actions as unknown as B",
			].map((sample) => UNSEAL.test(sample)),
		).toEqual([true, true, true, true]);
	});
});
