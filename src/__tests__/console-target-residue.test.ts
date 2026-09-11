import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Tests
//
//  The foreign-Gateway refusal has exactly one owner (consoleTargets.ts). A second parse call
//  site in console/ is a second chance to fold a foreign address onto a same-named local
//  session, which is what merges two machines' boards under one header. The MCP door's
//  local-filling parseTarget never appears under console/: a console target is qualified.

const CONSOLE_DIR = path.join(__dirname, "..", "gateway", "console");

describe("console target resolution residue", () => {
	it("parseQualifiedTarget appears in consoleTargets.ts and nowhere else under console/, and parseTarget nowhere", () => {
		const files = fs.readdirSync(CONSOLE_DIR).filter((f) => f.endsWith(".ts"));
		// Vacuity guard: a moved directory must fail loudly, not pass an empty scan.
		expect(files.length).toBeGreaterThan(3);
		expect(files).toContain("consoleTargets.ts");

		for (const file of files) {
			const content = fs.readFileSync(path.join(CONSOLE_DIR, file), "utf8");
			expect(content, `${file} must not fill a local Domain or Gateway into a console target`).not.toMatch(
				/\bparseTarget\b/,
			);
			if (file === "consoleTargets.ts") {
				expect(content).toMatch(/\bparseQualifiedTarget\b/);
			} else {
				expect(content, `${file} must resolve targets through consoleTargets.ts`).not.toMatch(
					/\bparseQualifiedTarget\b/,
				);
			}
		}
	});
});
