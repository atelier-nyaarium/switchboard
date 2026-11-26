import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.join(import.meta.dirname, "..", "..");
const DIRS = ["src/gateway/computed", "src/gateway/compose", "src/gateway/liveConsole"];

const VALIDITY = "src/gateway/computed/automationValidity.ts";

/** Preview text, not body. */
const PREVIEW = "src/gateway/computed/automationPreview.ts";

/** Hand-written value checks. */
const JUDGES = /AutomationActionSchema\s*\.\s*(?:safeParse|parse)\s*\(|\bholes\??\s*\.\s*issue\s*\(/;

const files = DIRS.flatMap((dir) =>
	fs
		.readdirSync(path.join(REPO, dir))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => `${dir}/${name}`),
);
const read = (file: string) => fs.readFileSync(path.join(REPO, file), "utf8");

describe("the one body check", () => {
	it("judges an action's values in the assessment alone", () => {
		const judging = files.filter((file) => JUDGES.test(read(file)));

		expect(judging.sort()).toEqual([PREVIEW, VALIDITY]);
		expect(
			[
				"AutomationActionSchema.safeParse(raw)",
				"AutomationActionSchema.parse(literal)",
				"holes.issue(text, names)",
				"holes?.issue(text, names)",
				"resolved(kind, raw)",
				"this.issue(node)",
			].map((sample) => JUDGES.test(sample)),
		).toEqual([true, true, true, true, false, false]);
	});
});
