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

// The emulator build exists to look at the console with no Gateway and no network, and its Router
// address resolves to nothing. A door opened without consulting `isSandbox` reaches for that
// address: at best a wasted lookup, at worst an uncaught throw. Four were missed on the first pass
// and an auditor found them, not a gate.
const OUTBOUND = /\.(?:newCall|newWebSocket)\(/;

/** Why a file may open a socket without asking whether this is the sandbox. */
const ALLOWLIST: Record<string, string> = {
	"ConsoleHttp.kt": "a helper the callers drive; each one decides for itself",
	"ConsoleSocketClient.kt": "reached only through ConsoleSocketDriver.connect, which asks",
	"GatewayEnrollment.kt": "enrollment only, and the sandbox boots past onboarding",
	"SttsClient.kt": "a speech provider rather than the Router, and the sandbox has no client",
	"AppUpdater.kt": "the release download, not the Router",
};

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

function unguardedDoors(files: string[]): string[] {
	const found: string[] = [];
	for (const file of files) {
		const name = path.basename(file);
		if (name in ALLOWLIST) continue;
		const source = fs.readFileSync(file, "utf8");
		if (OUTBOUND.test(source) && !source.includes("isSandbox")) found.push(name);
	}
	return found;
}

describe("outbound doors on the phone", () => {
	it("has none the sandbox could walk through unasked", () => {
		expect(unguardedDoors(kotlinFiles(ANDROID_MAIN))).toEqual([]);
	});

	it("names a reason for every door it lets past", () => {
		const named = Object.keys(ALLOWLIST);
		const present = kotlinFiles(ANDROID_MAIN).map((file) => path.basename(file));
		// An allowlist entry for a file that no longer exists hides the next door added under that name.
		expect(named.filter((name) => !present.includes(name))).toEqual([]);
		expect(Object.values(ALLOWLIST).every((reason) => reason.length > 0)).toBe(true);
	});
});
