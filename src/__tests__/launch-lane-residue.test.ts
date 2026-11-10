import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const SRC = path.join(import.meta.dirname, "..");
const ROOT = path.join("mcp", "devcontainer", "hostDaemon.ts");
/** What makes a session: the launch and the tmux primitives under it. */
const MAKERS: Record<string, string[]> = {
	"sessionLaunch.js": ["createSessionLaunch"],
	"tmuxCore.js": ["createSession", "ensureSession"],
};

/** Names a file imports from each maker module. */
function importedMakers(source: string): string[] {
	const found: string[] = [];
	for (const [module, names] of Object.entries(MAKERS)) {
		const pattern = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"[^"]*/${module.replace(".", "\\.")}"`, "g");
		for (const [, list = ""] of source.matchAll(pattern)) {
			const imported = list.split(",").map((name) => name.trim().replace(/^type\s+/, ""));
			found.push(...names.filter((name) => imported.includes(name)));
		}
	}
	return found;
}

describe("only the launch lane makes a session", () => {
	const sources = filesUnder(SRC)
		.filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
		.map((file) => ({ rel: path.relative(SRC, file), source: readFileSync(file, "utf8") }));

	it("imports the session makers in the composition root alone", () => {
		const importers = sources.filter(({ source }) => importedMakers(source).length > 0).map(({ rel }) => rel);
		expect(importers).toEqual([ROOT]);
	});

	it("hands the root's launch to the lane and binds it nowhere else", () => {
		const root = sources.find(({ rel }) => rel === ROOT)?.source ?? "";
		const lane = root.indexOf("createLaunchLane({");
		const launch = root.indexOf("createSessionLaunch({");
		expect(lane).toBeGreaterThan(-1);
		expect(launch).toBeGreaterThan(lane);
		expect(root.match(/createSessionLaunch\(/g)).toHaveLength(1);
		expect(root.match(/\bensureSession\b/g)).toHaveLength(2);
	});

	it("reads an import list the way the sweep needs", () => {
		const imports = `import { a, ensureSession, type b } from "./tmuxCore.js";`;
		expect(importedMakers(imports)).toEqual(["ensureSession"]);
		expect(importedMakers(`import { ensureSessionLater } from "./tmuxCore.js";`)).toEqual([]);
	});
});
