import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = path.resolve(import.meta.dirname, "../gateway/assistant/iftttClient.ts");

describe("IFTTT logging residue", () => {
	it("keeps keys out of direct logging", () => {
		const source = fs.readFileSync(SOURCE, "utf8");
		expect(source).not.toMatch(/\bconsole\s*\./);
		expect(source).not.toMatch(/\blog\s*\(/);
	});
});
