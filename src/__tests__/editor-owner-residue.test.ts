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

/** The edit model: the one owner of which editor is shown. */
const MODEL = "EditorSessions.kt";

/** The editor's edit hook. */
const HOOK = "EditorScaffold.kt";

// Disposal ends the edit on lock or rotation.
const DISPOSAL = /\b(?:DisposableEffect|onDispose)\b/;

// A second owner of the open editor.
const HELD_KEY =
	/\bmutableStateOf<[^\n]*\b(?:EditKey|AutomationDraftKey|AutomationSlot|ShownEditor)\b|\bvar\s+edit[A-Z]\w*\s+by\s+remember/;

// Ending an edit on dispose.
const DISPOSED_EDIT = /\bonDispose\s*\{[^}]*\b(?:hide|hideAll|discard|askLeave)\s*\(/;

const MINT = /\bedits\.open\(/;

const SHOW = /\bedits\.show\(/;

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

function code(source: string): string {
	return source
		.split("\n")
		.filter((line) => !/^\s*(?:import\s|\/\/|\/?\*)/.test(line))
		.join("\n");
}

/** The declarations inside `sealed interface AssistantPage`. */
function pageBody(source: string): string {
	const lines = code(source).split("\n");
	const start = lines.findIndex((line) => /^internal sealed interface AssistantPage\b/.test(line));
	if (start < 0) return "";
	const end = lines.findIndex((line, at) => at > start && line.startsWith("}"));
	return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("An editor's edit", () => {
	const files = kotlinFiles(ANDROID_MAIN).map((file) => ({
		name: path.relative(ANDROID_MAIN, file),
		text: code(fs.readFileSync(file, "utf8")),
	}));
	const offenders = (hit: (text: string) => boolean, allowed: string[] = []) =>
		files.filter(({ name, text }) => !allowed.includes(name) && hit(text)).map(({ name }) => name);

	it("is never ended by its page leaving composition", () => {
		expect(offenders((text) => /\brememberEdit\(/.test(text) && DISPOSAL.test(text))).toEqual([]);
		expect(offenders((text) => DISPOSED_EDIT.test(text))).toEqual([]);
	});

	it("has no second holder of which editor is open", () => {
		expect(offenders((text) => HELD_KEY.test(text))).toEqual([]);
		expect(pageBody(fs.readFileSync(path.join(ANDROID_MAIN, "AssistantRoot.kt"), "utf8"))).not.toMatch(
			/\b(?:EditKey|AutomationDraftKey|AutomationSlot)\b/,
		);
	});

	it("is opened by the one hook and shown through the editors", () => {
		expect(offenders((text) => MINT.test(text), [HOOK])).toEqual([]);
		expect(offenders((text) => SHOW.test(text), [MODEL])).toEqual([]);
	});

	it("tells a second owner from the model", () => {
		expect(
			HELD_KEY.test("var editRunbook by rememberSaveable { mutableStateOf<Pair<String, EditKey>?>(null) }"),
		).toBe(true);
		expect(HELD_KEY.test("var open by remember { mutableStateOf<AutomationSlot?>(null) }")).toBe(true);
		expect(
			HELD_KEY.test("var editRunbook by rememberSaveable { mutableStateOf<Pair<String, String>?>(null) }"),
		).toBe(true);
		expect(HELD_KEY.test("val open = remember { mutableStateOf<ShownEditor?>(null) }")).toBe(true);
		expect(HELD_KEY.test("var confirming by remember(key) { mutableStateOf(false) }")).toBe(false);
		expect(DISPOSED_EDIT.test("DisposableEffect(Unit) { onDispose { repo.editors.hideAll() } }")).toBe(true);
		expect(DISPOSED_EDIT.test("DisposableEffect(Unit) { onDispose { player.release() } }")).toBe(false);
		expect(DISPOSAL.test("DisposableEffect(key) { onDispose { edits.hide() } }")).toBe(true);
		expect(MINT.test("ops.edits.open(key, draft)")).toBe(true);
		expect(SHOW.test("repo.editors.show(ShownEditor.Runbook(key))")).toBe(false);
		expect(
			pageBody(
				"internal sealed interface AssistantPage {\n\tdata class Source(val gatewayId: String) : AssistantPage\n}",
			),
		).toContain("Source");
	});
});
