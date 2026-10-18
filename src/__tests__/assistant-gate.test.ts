import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gateVerdict } from "../mcp/assistant/gate.js";
import { gateHookOutput } from "../mcp/assistant/gateHook.js";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "assistant-gate-")));
const notes = path.join(base, "notes");
const attachments = path.join(base, "attachments");
const outside = path.join(base, "outside");
const home = path.join(base, "home");
for (const dir of [".git", ".claude", "watchers", "Assistant", "sub"])
	fs.mkdirSync(path.join(notes, dir), { recursive: true });
for (const dir of [attachments, outside, home]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(notes, "AGENTS.md"), "rules");
fs.writeFileSync(path.join(outside, "secret"), "x");
fs.writeFileSync(path.join(attachments, "photo.png"), "x");
fs.symlinkSync(outside, path.join(notes, "escape"));
fs.symlinkSync(path.join(notes, "watchers"), path.join(notes, "rules"));
fs.symlinkSync(path.join(notes, "AGENTS.md"), path.join(notes, "alias.md"));
fs.symlinkSync(path.join(outside, "new.md"), path.join(notes, "dangling.md"));
fs.linkSync(path.join(outside, "secret"), path.join(notes, "twin"));
fs.symlinkSync(home, path.join(base, "home-alias"));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const SB = "mcp__plugin_switchboard_switchboard__";

function verdict(tool: string, input: Record<string, unknown> = {}, cwd = notes) {
	return gateVerdict({ tool_name: tool, tool_input: input, cwd }, { notes, attachments, home }).allow;
}

describe("the assistant gate", () => {
	it.each([
		["Read", { file_path: path.join(notes, "Assistant", "threads.md") }],
		["Read", { file_path: path.join(attachments, "photo.png") }],
		["Read", { file_path: "Assistant/threads.md" }],
		["Glob", { pattern: "**/*.md" }],
		["Glob", { pattern: "{Assistant,sub}/*.{md,txt}" }],
		["Grep", { pattern: "todo", path: path.join(notes, "sub") }],
		["Grep", { pattern: "/api/../v2" }],
		["Write", { file_path: path.join(notes, "Assistant", "threads.md") }],
		["Edit", { file_path: "threads.md" }, path.join(notes, "Assistant")],
		["NotebookEdit", { notebook_path: path.join(notes, "sub", "n.ipynb") }],
		[`${SB}channel_reply`, {}],
		[
			`${SB}channel_reply`,
			{
				attachments: [path.join(notes, "Assistant", "a.md"), path.join(attachments, "photo.png")],
				full: "See [decisions](ref://Assistant/Decisions.md#Today).",
			},
		],
		[`${SB}switchboard_capabilities`, {}],
		["ToolSearch", { query: "channel_reply" }],
	] as const)("allows %s %j", (tool, input, cwd?: string) => {
		expect(verdict(tool, input, cwd)).toBe(true);
	});

	it.each([
		["Read", { file_path: path.join(outside, "secret") }],
		["Read", { file_path: path.join(notes, "escape", "secret") }],
		["Read", { file_path: path.join(notes, ".git", "config") }],
		["Read", {}],
		["Read", { file_path: "~/.ssh/id_ed25519" }],
		["Read", { file_path: "~root/.ssh/id_ed25519" }],
		["Read", { file_path: path.join(notes, "twin") }],
		["Glob", { pattern: path.join(outside, "*") }],
		["Glob", { pattern: "../outside/*" }],
		["Glob", { pattern: "{../outside,sub}/*" }],
		["Glob", { pattern: "{/etc,sub}/*" }],
		["Grep", { pattern: "x", path: outside }],
		["Grep", { pattern: "x", glob: "{~/.ssh,sub}/*" }],
		["Write", { file_path: "~/.bashrc" }],
		["Write", { file_path: path.join(notes, "dangling.md") }],
		["Write", { file_path: path.join(notes, "twin") }],
		["Write", { file_path: path.join(notes, "AGENTS.md") }],
		["Write", { file_path: path.join(notes, "alias.md") }],
		["Write", { file_path: path.join(notes, "sub", "CLAUDE.md") }],
		["Edit", { file_path: path.join(notes, ".claude", "settings.json") }],
		["Write", { file_path: path.join(notes, "watchers", "github.yaml") }],
		["Write", { file_path: path.join(notes, "rules", "github.yaml") }],
		["Write", { file_path: path.join(notes, ".mcp.json") }],
		["Write", { file_path: path.join(notes, ".git", "hooks", "pre-commit") }],
		["Write", { file_path: path.join(notes, "escape", "planted") }],
		["Write", { file_path: path.join(attachments, "photo.png") }],
		["Write", { file_path: 7 }],
		["Bash", { command: "ls" }],
		["Agent", { prompt: "go" }],
		["WebFetch", { url: "https://example.com" }],
		[`${SB}channel_reply`, { attachments: [path.join(outside, "secret")] }],
		[`${SB}channel_reply`, { attachments: "~/.ssh/id_ed25519" }],
		[`${SB}channel_reply`, { full: "[k](ref:///etc/hosts)" }],
		[`${SB}channel_reply`, { full: "[k](<ref://~/.ssh/id_ed25519>)" }],
		[`${SB}channel_reply`, { full: "[k](ref://../outside/secret)" }],
		[`${SB}channel_reply`, { full: "[k](ref://%2Fetc%2Fhosts)" }],
		[`${SB}vault_run`, { command: "ls" }],
		[`${SB}codexStartAgent`, { prompt: "go" }],
		["mcp__plugin_lexicon_lexicon__refactor_replace", {}],
		["Frobnicate", {}],
	] as const)("refuses %s %j", (tool, input) => {
		expect(verdict(tool, input)).toBe(false);
	});

	it("refuses input that names no tool", () => {
		expect(gateVerdict({ tool_input: {} }, { notes }).allow).toBe(false);
	});

	it("refuses a pathless search from a working directory outside notes", () => {
		expect(verdict("Glob", { pattern: "**/*" }, outside)).toBe(false);
		expect(verdict("Grep", { pattern: "x" }, outside)).toBe(false);
	});
});

describe("the gate hook", () => {
	const env = { CLAUDE_PROJECT_DIR: notes, HOME: base };
	const decision = (output: string | null) =>
		output === null ? "allow" : JSON.parse(output).hookSpecificOutput.permissionDecision;

	it("answers nothing to allow and a PreToolUse deny to refuse", () => {
		const read = JSON.stringify({ tool_name: "Read", tool_input: { file_path: path.join(notes, "AGENTS.md") } });
		const bash = JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } });

		expect(decision(gateHookOutput(read, env))).toBe("allow");
		expect(decision(gateHookOutput(bash, env))).toBe("deny");
		expect(JSON.parse(gateHookOutput(bash, env) ?? "").hookSpecificOutput.hookEventName).toBe("PreToolUse");
	});

	it("denies what it cannot read", () => {
		expect(decision(gateHookOutput("not json", env))).toBe("deny");
		expect(decision(gateHookOutput(JSON.stringify({ tool_name: "Read" }), {}))).toBe("deny");
	});

	it("denies everything when the session landed in home instead of notes", () => {
		const read = JSON.stringify({ tool_name: "Read", tool_input: { file_path: path.join(notes, "AGENTS.md") } });

		expect(decision(gateHookOutput(read, { CLAUDE_PROJECT_DIR: notes, HOME: notes }))).toBe("deny");
		expect(decision(gateHookOutput(read, { CLAUDE_PROJECT_DIR: base, HOME: notes }))).toBe("deny");
		expect(decision(gateHookOutput(read, { CLAUDE_PROJECT_DIR: path.join(base, "home-alias"), HOME: home }))).toBe(
			"deny",
		);
	});
});
