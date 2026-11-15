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

// A record page removes through `RemoveMenu`, which takes its label as an argument.
const DRAWN = /\bText\(\s*"(?:Delete|Remove)\b/g;

/** Each exempt file, and why its removal is not a record page's. */
const ALLOWED: Record<string, string> = {
	"HostNetworks.kt": "a Domain's removal, on its settings page",
	"SettingsSections.kt": "the Domain's own removal and its confirmation",
	"Management.kt": "a list row's inline action",
	"vault/VaultEntryDialog.kt": "a dialogue, which has no top bar",
	"board/BoardAttachments.kt": "an attachment's chip",
};

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

const drawnIn = (source: string): number =>
	[
		...source
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("//"))
			.join("\n")
			.matchAll(DRAWN),
	].length;

describe("Delete and Remove buttons", () => {
	it("are drawn by the top bar's menu on a record page", () => {
		const offenders = kotlinFiles(ANDROID_MAIN)
			.map((file) => path.relative(ANDROID_MAIN, file))
			.filter((file) => !(file in ALLOWED))
			.filter((file) => drawnIn(fs.readFileSync(path.join(ANDROID_MAIN, file), "utf8")) > 0);
		expect(offenders).toEqual([]);
	});

	it("names no exemption that draws none", () => {
		const idle = Object.keys(ALLOWED).filter(
			(file) => drawnIn(fs.readFileSync(path.join(ANDROID_MAIN, file), "utf8")) === 0,
		);
		expect(idle).toEqual([]);
	});

	it("tells a drawn button from a menu's label and a comment", () => {
		expect(drawnIn('TextButton(onClick = remove) { Text("Delete routine") }')).toBe(1);
		expect(drawnIn('Text("Remove", color = MaterialTheme.colorScheme.error)')).toBe(1);
		expect(drawnIn('RemoveMenu("Delete routine") { confirming = true }')).toBe(0);
		expect(drawnIn('// Text("Delete routine")')).toBe(0);
		expect(drawnIn('Text("Deleted elsewhere")')).toBe(0);
	});
});
