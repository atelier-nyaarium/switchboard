import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { noOption, PromptOccurrences, permissionPrompt, seePrompt } from "../mcp/devcontainer/permissionPrompt.js";

const FIXTURES = path.join(import.meta.dirname, "..", "..", "tests", "fixtures");
const { vectors } = JSON.parse(fs.readFileSync(path.join(FIXTURES, "permission-prompt", "panes.json"), "utf8")) as {
	vectors: { name: string; screen: string }[];
};
const screen = (name: string): string => {
	const vector = vectors.find((v) => v.name === name);
	if (!vector) throw new Error(`no vector ${name}`);
	return vector.screen;
};
const read = (name: string) => {
	const prompt = permissionPrompt(screen(name));
	if (!prompt) throw new Error(`${name} read no prompt`);
	return prompt;
};

describe("permissionPrompt over live captures", () => {
	it("reads a workflow agent's prompt and its countdown", () => {
		const prompt = read("workflow-countdown");
		expect(prompt.title).toBe('Bash command · from the "a4-red-team" workflow');
		expect(prompt.body[0]).toBe("cd /tmp/claude-1000/-home-nyaarium-projects-nyaac");
		expect(prompt.body).toHaveLength(10);
		expect(prompt.question).toBe("Do you want to proceed?");
		expect(prompt.options.map((o) => o.label)).toEqual(["Yes", "No"]);
		expect(prompt.cursor).toBe(1);
		expect(prompt.autoDeny).toBe(true);
	});

	it("keeps one id while the countdown stops and the pane rewraps", () => {
		const held = read("workflow-held");
		expect(held.autoDeny).toBe(false);
		expect(held.contentId).toBe(read("workflow-countdown").contentId);
	});

	it("keeps one id through the cursor moving and the amend field", () => {
		const id = read("bash-manual").contentId;
		const yes = read("bash-amend-yes");
		const no = read("bash-amend-no-typed");
		expect([yes.contentId, no.contentId]).toEqual([id, id]);
		expect(yes.options[0].label).toBe("Yes, and tell Claude what to do next");
		expect(no.cursor).toBe(4);
		expect(no.options[3].label).toBe("No, use rm out/a.tmp instead");
	});

	it("takes the body between the dashed rules, and finds No by label", () => {
		const bash = read("bash-manual");
		expect(bash.title).toBe("Bash command");
		expect(bash.body).toEqual(["mkdir -p out && rm -f out/*.tmp && echo done"]);
		expect(noOption(bash.options)).toBe(4);
		const write = read("write-file");
		expect(write.question).toBe("Do you want to create note.txt?");
		expect(noOption(write.options)).toBe(3);
	});

	it("reads a prompt with no dashed body", () => {
		const mcp = read("mcp-tool");
		expect(mcp.title).toBe("Tool use");
		expect(mcp.body.length).toBeGreaterThan(0);
		expect(noOption(mcp.options)).toBe(2);
	});

	it("gives different prompts different ids", () => {
		const ids = ["workflow-countdown", "bash-manual", "write-file", "mcp-tool"].map((name) => read(name).contentId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("names the same text asked again as a new prompt, and the same sighting as one", () => {
		const occurrences = new PromptOccurrences("e1");
		const see = (name: string) => seePrompt(occurrences, "pane", screen(name))?.id ?? null;
		const first = see("bash-manual");
		expect(see("bash-amend-yes")).toBe(first);
		expect(see("idle-workflow")).toBeNull();
		const again = see("bash-manual");
		expect(again).not.toBe(first);
		expect(seePrompt(new PromptOccurrences("e2"), "pane", screen("bash-manual"))?.id).not.toBe(first);
	});

	it("reads no prompt from panes without one", () => {
		expect(permissionPrompt(screen("idle-workflow"))).toBeNull();
		expect(permissionPrompt(screen("limit-dialog"))).toBeNull();
		for (const corpus of ["agent-screen", "limit-notice"]) {
			const file = JSON.parse(fs.readFileSync(path.join(FIXTURES, corpus, "vectors.json"), "utf8"));
			const all = (file.vectors ?? file) as { name: string; screen?: unknown }[];
			for (const v of all) {
				if (typeof v.screen === "string") expect(permissionPrompt(v.screen), `${corpus}/${v.name}`).toBeNull();
			}
		}
	});
});

describe("permissionPrompt refuses a dialog it could not answer", () => {
	const rule = "─".repeat(40);
	const dialog = (menu: string, footer = " Esc to cancel · Tab to amend") =>
		`${rule}\n Bash command\n Do you want to proceed?\n${menu}\n\n${footer}`;

	it("needs a Yes first and a No", () => {
		expect(permissionPrompt(dialog(" ❯ 1. Yes\n   2. No"))).not.toBeNull();
		expect(permissionPrompt(dialog(" ❯ 1. Yes\n   2. Maybe"))).toBeNull();
		expect(permissionPrompt(dialog(" ❯ 1. Stop\n   2. No"))).toBeNull();
	});

	it("needs one cursor, consecutive digits and the cancel footer", () => {
		expect(permissionPrompt(dialog("   1. Yes\n   2. No"))).toBeNull();
		expect(permissionPrompt(dialog(" ❯ 1. Yes\n   3. No"))).toBeNull();
		expect(
			permissionPrompt(
				dialog(" ❯ 1. Yes, I trust this folder\n   2. No, exit", " Enter to confirm · Esc to cancel"),
			),
		).toBeNull();
	});
});
