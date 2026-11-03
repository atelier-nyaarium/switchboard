import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PromptOccurrences, seePrompt } from "../mcp/devcontainer/permissionPrompt.js";
import { answerPrompt, type PromptSight, stopAutoDeny } from "../mcp/devcontainer/promptAnswer.js";
import type { PaneHands } from "../mcp/devcontainer/tmuxCore.js";

const LABELS = ["Yes", "Yes, and don't ask again", "Yes, and switch to auto mode", "No"];
const fast = { settleMs: 30, pollMs: 10, sleep: async () => {} };

const sightOver = (): PromptSight => {
	const occurrences = new PromptOccurrences("t");
	return (screen) => seePrompt(occurrences, "pane", screen);
};

/** Fake dialog: arrows move and close an amend, Tab opens one, a digit answers. */
function fakeDialog(opts: { inert?: boolean; asksAgain?: boolean } = {}) {
	const s = { cursor: 1, amend: null as string | null, chosen: 0, steer: "", keys: [] as string[], gone: 0 };
	const rule = "─".repeat(53);
	const dash = "╌".repeat(53);
	const label = (digit: number): string => {
		if (s.amend === null || s.cursor !== digit) return LABELS[digit - 1];
		const tail = digit === 4 ? "and tell Claude what to do differently" : "and tell Claude what to do next";
		return `${LABELS[digit - 1]}, ${s.amend || tail}`;
	};
	const dialog = (): string => {
		const rows = LABELS.map((_, i) => `${s.cursor === i + 1 ? " ❯ " : "   "}${i + 1}. ${label(i + 1)}`);
		const footer = s.amend === null ? " Esc to cancel · Tab to amend" : " Esc to cancel";
		return `${rule}\n Bash command\n${dash}\n rm -f out/x\n${dash}\n Do you want to proceed?\n${rows.join("\n")}\n\n${footer}`;
	};
	const pane = (): string => {
		if (!s.chosen) return dialog();
		// Asked again: one frame without it, then the same text back.
		if (opts.asksAgain && s.gone++ > 0) return dialog();
		return `❯ \n${rule}\n  ⏸ manual mode on`;
	};
	const hands: PaneHands = {
		read: async () => pane(),
		press: async (key) => {
			s.keys.push(key);
			if (opts.inert) return;
			if (key === "Down" || key === "Up") {
				s.cursor = Math.min(4, Math.max(1, s.cursor + (key === "Down" ? 1 : -1)));
				s.amend = null;
			} else if (key === "Tab") s.amend = s.amend === null ? "" : null;
			else if (key === "Enter") {
				s.chosen = s.cursor;
				s.steer = s.amend ?? "";
			}
		},
		type: async (text) => {
			s.keys.push(`type:${text}`);
			if (opts.inert) return;
			if (s.amend !== null) s.amend += text;
			else if (/^[1-4]$/.test(text)) s.chosen = Number(text);
		},
	};
	const sight = sightOver();
	const id = () => sight(pane())?.id ?? "";
	return { s, hands, sight, id };
}

describe("answerPrompt", () => {
	it("approves with 1", async () => {
		const d = fakeDialog();
		expect(await answerPrompt(d.hands, d.sight, d.id(), "approve", undefined, fast)).toBe("answered");
		expect(d.s.chosen).toBe(1);
	});

	it("denies with the No row's digit when no reason is given", async () => {
		const d = fakeDialog();
		expect(await answerPrompt(d.hands, d.sight, d.id(), "deny", "  ", fast)).toBe("answered");
		expect(d.s.keys).toEqual(["type:4"]);
	});

	it("steers a deny: walks to No, opens its field, types the reason, submits", async () => {
		const d = fakeDialog();
		expect(await answerPrompt(d.hands, d.sight, d.id(), "deny", "use rm out/a.tmp\ninstead", fast)).toBe(
			"answered",
		);
		expect(d.s.chosen).toBe(4);
		expect(d.s.steer).toBe("use rm out/a.tmp instead");
		expect(d.s.keys).toEqual(["Down", "Down", "Down", "Tab", "type:use rm out/a.tmp instead", "Enter"]);
	});

	it("counts an answer whose same text is asked again as answered", async () => {
		const d = fakeDialog({ asksAgain: true });
		const first = d.id();
		expect(await answerPrompt(d.hands, d.sight, first, "approve", undefined, fast)).toBe("answered");
		expect(d.id()).not.toBe(first);
	});

	it("presses nothing for a prompt it was not asked about", async () => {
		const d = fakeDialog();
		expect(await answerPrompt(d.hands, d.sight, "someone-else", "approve", undefined, fast)).toBe("stale");
		expect(d.s.keys).toEqual([]);
	});

	it("fails when the prompt does not leave the pane", async () => {
		const d = fakeDialog({ inert: true });
		await expect(answerPrompt(d.hands, d.sight, d.id(), "approve", undefined, fast)).rejects.toThrow(
			/still waiting/,
		);
	});
});

describe("stopAutoDeny", () => {
	const fixtures = path.join(import.meta.dirname, "..", "..", "tests", "fixtures", "permission-prompt", "panes.json");
	const { vectors } = JSON.parse(fs.readFileSync(fixtures, "utf8")) as {
		vectors: { name: string; screen: string }[];
	};
	const screen = (name: string) => vectors.find((v) => v.name === name)?.screen ?? "";
	const handsOver = (pane: string, keys: string[]): PaneHands => ({
		read: async () => pane,
		press: async (key) => {
			keys.push(key);
		},
		type: async () => {},
	});

	it("presses Down then Up only while the same prompt counts down", async () => {
		const sight = sightOver();
		const counting = screen("workflow-countdown");
		const id = sight(counting)?.id ?? "";
		const keys: string[] = [];
		expect(await stopAutoDeny(handsOver(counting, keys), sight, id)).toBe(true);
		expect(await stopAutoDeny(handsOver(screen("workflow-held"), keys), sight, id)).toBe(false);
		expect(await stopAutoDeny(handsOver(counting, keys), sight, "other")).toBe(false);
		expect(keys).toEqual(["Down", "Up"]);
	});
});
