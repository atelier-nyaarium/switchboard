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

// Handler order follows composition, not the surface it closes. The shell's `backLayer` keeps
// handlers from outranking drawers or sheets drawn over them.
const HANDLER = /\b(?:Predictive)?BackHandler\s*[({]/g;

/** Each exempt file, and why its handler cannot outrank anything drawn over it. */
const ALLOWED: Record<string, string> = {
	"MainActivity.kt": "the one authority, dispatching backLayer",
	"AttachmentViewer.kt": "full screen, composed after the shell and over everything",
	"Onboarding.kt": "the host help screen, drawn in place of the shell",
};

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

function handlersIn(source: string): number {
	const code = source
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("import ") && !line.trimStart().startsWith("//"))
		.join("\n");
	return [...code.matchAll(HANDLER)].length;
}

describe("Back handlers", () => {
	it("live only where the shell's order cannot be outranked", () => {
		const offenders = kotlinFiles(ANDROID_MAIN)
			.filter((file) => !(path.basename(file) in ALLOWED))
			.filter((file) => handlersIn(fs.readFileSync(file, "utf8")) > 0)
			.map((file) => path.relative(ANDROID_MAIN, file));
		expect(offenders).toEqual([]);
	});

	it("tells a handler from its import and a comment", () => {
		expect(handlersIn("BackHandler(enabled = open) { close() }")).toBe(1);
		expect(handlersIn("BackHandler { close() }")).toBe(1);
		expect(handlersIn("PredictiveBackHandler(enabled) { progress -> }")).toBe(1);
		expect(handlersIn("import androidx.activity.compose.BackHandler")).toBe(0);
		expect(handlersIn("// BackHandler { close() }")).toBe(0);
	});
});
