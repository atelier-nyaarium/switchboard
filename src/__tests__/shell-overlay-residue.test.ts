import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ANDROID_MAIN = path.join(
	import.meta.dirname,
	"..",
	"..",
	"android",
	"app",
	"src",
	"main",
	"java",
	"com",
	"atelier_nyaarium",
	"switchboard",
);

// Anything drawn over a screen.
const OVERLAY = /\b([A-Z]\w*(?:Dialog|Sheet|Overlay|Editor|Viewer|Popup)|Dialog|Popup|DropdownMenu)\s*\(/g;

/** Each overlay the shell may compose itself, and why the lock cannot be drawn over. */
const ALLOWED: Record<string, string> = {
	MenuSheet: "the drawer's content, inside the screens the lock replaces",
};

const CALL = /\b([A-Z]\w*)\s*\(/g;

function code(source: string): string {
	return source
		.split("\n")
		.filter((line) => !/^\s*(?:import\s|\/\/|\/?\*)/.test(line))
		.join("\n");
}

function overlaysIn(source: string): string[] {
	return [...code(source).matchAll(OVERLAY)].map((match) => match[1]).filter((name) => !(name in ALLOWED));
}

/** What `App` composes after its screens: the lines from the screen switch's close to the function's. */
function afterScreens(source: string): string | null {
	const lines = code(source).split("\n");
	const open = lines.findIndex((line) => line === "\twhen (screen) {");
	if (open < 0) return null;
	const close = lines.findIndex((line, at) => at > open && line === "\t}");
	const end = lines.findIndex((line, at) => at > close && line === "}");
	if (close < 0 || end < 0) return null;
	return lines.slice(close + 1, end).join("\n");
}

function callsIn(text: string): string[] {
	return [...text.matchAll(CALL)].map((match) => match[1]);
}

/** The host's first statement. */
function hostOpening(source: string): string {
	const text = code(source);
	const start = text.indexOf("internal fun ShellOverlays(");
	if (start < 0) return "";
	const body = text.indexOf(") {\n", start);
	return body < 0 ? "" : (text.slice(body + 4).split("\n")[0] ?? "").trim();
}

describe("What the shell draws over a screen", () => {
	const shell = fs.readFileSync(path.join(ANDROID_MAIN, "MainActivity.kt"), "utf8");

	it("is drawn by the one host", () => {
		expect(overlaysIn(shell)).toEqual([]);
	});

	it("is the only thing the shell composes after its screens, and is handed the lock", () => {
		const tail = afterScreens(shell);
		expect(tail).not.toBeNull();
		expect(callsIn(tail ?? "")).toEqual(["ShellOverlays"]);
		expect(tail).toMatch(/\blocked = locked\b/);
	});

	it("waits for the lock before anything else", () => {
		expect(hostOpening(fs.readFileSync(path.join(ANDROID_MAIN, "ShellOverlays.kt"), "utf8"))).toBe(
			"if (locked) return",
		);
	});

	it("tells an overlay from the host and the drawer", () => {
		expect(overlaysIn("BoardEntryDialog(state, repo, id) { }")).toEqual(["BoardEntryDialog"]);
		expect(overlaysIn("ModalBottomSheet(onDismissRequest = close) { }")).toEqual(["ModalBottomSheet"]);
		expect(overlaysIn("RunbookEditor(repo, gatewayId, id)")).toEqual(["RunbookEditor"]);
		expect(overlaysIn("DropdownMenu(expanded = open) { }")).toEqual(["DropdownMenu"]);
		expect(overlaysIn("Dialog(onDismissRequest = close) { }")).toEqual(["Dialog"]);
		expect(overlaysIn("Popup(alignment = top) { }")).toEqual(["Popup"]);
		expect(overlaysIn("ShellOverlays(locked = locked)")).toEqual([]);
		expect(overlaysIn("MenuSheet(views)")).toEqual([]);
		expect(overlaysIn("openOverlay(Overlay.Manage)")).toEqual([]);
		expect(overlaysIn("// AlertDialog(onDismissRequest = {})")).toEqual([]);
		expect(
			hostOpening("internal fun ShellOverlays(\n\tlocked: Boolean,\n) {\n\tif (locked) return\n\tQueue()\n}"),
		).toBe("if (locked) return");
	});

	it("tells a second draw after the screens from the host alone", () => {
		const app = (tail: string) => `fun App() {\n\twhen (screen) {\n\t\tROOT -> Root()\n\t}\n${tail}\n}`;
		expect(callsIn(afterScreens(app("\tShellOverlays(\n\t\tlocked = locked,\n\t)")) ?? "")).toEqual([
			"ShellOverlays",
		]);
		expect(
			callsIn(afterScreens(app("\tAutomationEditorPage(repo)\n\tShellOverlays(locked = locked)")) ?? ""),
		).toEqual(["AutomationEditorPage", "ShellOverlays"]);
		expect(afterScreens("fun App() {\n\tRoot()\n}")).toBeNull();
	});
});
