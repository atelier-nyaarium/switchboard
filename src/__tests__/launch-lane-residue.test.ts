import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const SRC = path.join(import.meta.dirname, "..");
const ROOT = path.join("mcp", "devcontainer", "hostDaemon.ts");
const TMUX = path.join("mcp", "devcontainer", "tmuxCore.ts");
/** What makes a session: the launch and the tmux primitives under it. */
const MAKERS: Record<string, string[]> = {
	sessionLaunch: ["createSessionLaunch"],
	tmuxCore: ["createSession", "ensureSession"],
};

/** Line-leading comments only. */
function strip(source: string): string {
	return source.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Makers a file reaches by import, re-export, namespace or dynamic import. */
function importedMakers(source: string): string[] {
	const code = strip(source);
	const found = new Set<string>();
	for (const [module, names] of Object.entries(MAKERS)) {
		const from = `["'][^"']*/${module}\\.js["']`;
		for (const [, list = ""] of code.matchAll(
			new RegExp(`(?:import|export)\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*${from}`, "g"),
		)) {
			const named = list.split(",").map(
				(item) =>
					item
						.trim()
						.replace(/^type\s+/, "")
						.split(/\s+as\s+/)[0],
			);
			for (const name of names) if (named.includes(name)) found.add(name);
		}
		const whole = new RegExp(
			`(?:import\\s*\\*\\s*as\\s+\\w+\\s*from|export\\s*\\*\\s*(?:as\\s+\\w+\\s*)?from|import\\s*\\()\\s*${from}`,
		);
		if (whole.test(code)) for (const name of names) found.add(name);
	}
	return [...found];
}

/** The text between a call's opening paren and its match. */
function callSpan(code: string, opener: string): { start: number; end: number } | undefined {
	const start = code.indexOf(opener);
	if (start < 0) return undefined;
	let depth = 0;
	for (let i = start + opener.length - 1; i < code.length; i += 1) {
		if (code[i] === "(") depth += 1;
		if (code[i] === ")" && --depth === 0) return { start, end: i };
	}
	return undefined;
}

describe("only the launch lane makes a session", () => {
	const sources = filesUnder(SRC)
		.filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
		.map((file) => ({ rel: path.relative(SRC, file), source: readFileSync(file, "utf8") }));

	it("reaches the session makers from the composition root alone", () => {
		const importers = sources.filter(({ source }) => importedMakers(source).length > 0).map(({ rel }) => rel);
		expect(importers).toEqual([ROOT]);
	});

	it("builds tmux's new-session nowhere but tmuxCore", () => {
		const builders = sources.filter(({ source }) => strip(source).includes("new-session")).map(({ rel }) => rel);
		expect(builders).toEqual([TMUX]);
	});

	it("hands the root's launch to the lane and calls the makers nowhere else", () => {
		const code = strip(sources.find(({ rel }) => rel === ROOT)?.source ?? "");
		const lane = callSpan(code, "createLaunchLane(");
		expect(lane).toBeDefined();
		const outside = code.slice(0, lane?.start) + code.slice(lane?.end);
		const inside = code.slice(lane?.start, lane?.end);
		expect(inside.match(/\bcreateSessionLaunch\(/g)).toHaveLength(1);
		expect(outside.match(/\bcreateSessionLaunch\(/g)).toBeNull();
		// Outside the lane's argument, only the import names it.
		expect(outside.match(/\bensureSession\b/g)).toHaveLength(1);
	});

	it("reads every road in, and only the names it means", () => {
		const reaches = (code: string) => importedMakers(code).sort();
		expect(reaches(`import { a, ensureSession, type b } from "./tmuxCore.js";`)).toEqual(["ensureSession"]);
		expect(reaches(`import { createSession as makePane } from "./tmuxCore.js";`)).toEqual(["createSession"]);
		expect(reaches(`export { createSessionLaunch } from "./sessionLaunch.js";`)).toEqual(["createSessionLaunch"]);
		expect(reaches(`import * as tmux from "./tmuxCore.js";`)).toEqual(["createSession", "ensureSession"]);
		expect(reaches(`export * from "./tmuxCore.js";`)).toEqual(["createSession", "ensureSession"]);
		expect(reaches(`const tmux = await import("./tmuxCore.js");`)).toEqual(["createSession", "ensureSession"]);
		expect(reaches(`import { ensureSessionLater } from "./tmuxCore.js";`)).toEqual([]);
		expect(reaches(`// import { ensureSession } from "./tmuxCore.js";`)).toEqual([]);
		const behindString = `const opens = s.startsWith("/*");\nimport { ensureSession } from "./tmuxCore.js";\n// */`;
		expect(reaches(behindString)).toEqual(["ensureSession"]);
	});
});
