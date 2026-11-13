import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const ANDROID_SRC = path.join(import.meta.dirname, "..", "..", "android", "app", "src");
const PHONE = path.join(ANDROID_SRC, "main", "java", "com", "atelier_nyaarium", "switchboard");

/** The stored flags and the message classifier the link replaced. */
const RETIRED =
	/\b(?:pollFailStreak|enrollingSince|classifyConnError|enrollFold|retryWhileTransient|needsGateway|noGatewayState)\b/;

/** Who holds the link's feed, and why. */
const FEEDERS: Record<string, string> = {
	"ChatRepository.kt": "declares the feed and hands it to the socket",
	"RepositoryProvisioningHost.kt": "hands it to each transport it builds",
	"ConsoleClient.kt": "carries it to its transport",
	"RouterSetup.kt": "setup's own events",
	"SandboxSeeder.kt": "the emulator reaches no Router, so it states the link it draws",
};

function code(file: string): string {
	return fs
		.readFileSync(file, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, " ");
}

const phoneFiles = () => filesUnder(PHONE, ".kt").filter((file) => !file.includes(`${path.sep}proto${path.sep}`));
const named = (pattern: RegExp) =>
	phoneFiles()
		.filter((file) => pattern.test(code(file)))
		.map((file) => path.basename(file))
		.sort();

describe("router link residue", () => {
	it("no phone source names a stored connection flag", () => {
		const files = filesUnder(ANDROID_SRC, ".kt").filter((file) => !file.includes(`${path.sep}build${path.sep}`));
		expect(files.length).toBeGreaterThan(100);
		expect(
			files.filter((file) => RETIRED.test(code(file))).map((file) => path.relative(ANDROID_SRC, file)),
		).toEqual([]);
		expect(code(path.join(PHONE, "ChatState.kt"))).not.toMatch(/\bval (?:connected|status)\b/);
	});

	it("only the Router's doors and setup feed the link", () => {
		expect(named(/\bnoteRouter\b/)).toEqual(Object.keys(FEEDERS).sort());
	});

	it("one writer folds the link", () => {
		expect(named(/\bRouterLink\.Writer\(/)).toEqual(["ChatRepository.kt"]);
	});

	it("no surface reads the link's parts past the one reader", () => {
		expect(named(/\brouter\.(?:down|miss|missedAt|refusal|reached)\b/)).toEqual([]);
	});
});
