import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const ANDROID_SRC = path.join(import.meta.dirname, "..", "..", "android", "app", "src");

const RETIRED =
	/\bcopy\((?:[^()]*,\s*)?error\s*=|\b_?state(?:\.value)?\.error\b|\btransientMessages\b|\bconsumeTransientMessage\b/;

function code(file: string): string {
	return fs
		.readFileSync(file, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, " ");
}

describe("notice residue", () => {
	it("refuses the retired fields and accepts a notice", () => {
		expect(RETIRED.test("state.update { it.copy(error = line) }")).toBe(true);
		expect(RETIRED.test("s.copy(provisioned = true, error = null)")).toBe(true);
		expect(RETIRED.test("repo._state.value.error ?: fallback")).toBe(true);
		expect(RETIRED.test("it.transientMessages + line")).toBe(true);
		expect(RETIRED.test("state.update { it.withNotice(line, team = team) }")).toBe(false);
		expect(RETIRED.test("launch.error?.let { LaunchErrorDock(it) }")).toBe(false);
	});

	it("no phone source writes or reads them", () => {
		const files = filesUnder(ANDROID_SRC, ".kt").filter((f) => !f.includes(`${path.sep}build${path.sep}`));
		expect(files.length).toBeGreaterThan(100);
		const offenders = files.filter((f) => RETIRED.test(code(f))).map((f) => path.relative(ANDROID_SRC, f));
		expect(offenders).toEqual([]);
	});
});
