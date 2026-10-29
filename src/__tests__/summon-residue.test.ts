import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Tests
//
//  Keyguard and voice input stay system-owned.

const MAIN = path.join(__dirname, "..", "..", "android", "app", "src", "main");
const MANIFEST = path.join(MAIN, "AndroidManifest.xml");
const KOTLIN = path.join(MAIN, "java");

const REFUSED = [/showWhenLocked/i, /turnScreenOn/i, /RECORD_AUDIO/];

function kotlinFiles(dir: string): string[] {
	return fs
		.readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".kt"))
		.map((f) => path.join(dir, f));
}

function activities(manifest: string): { name: string; body: string }[] {
	return [...manifest.matchAll(/<activity\b([\s\S]*?)<\/activity>/g)].map((match) => ({
		name: /android:name="([^"]+)"/.exec(match[1])?.[1] ?? "",
		body: match[1],
	}));
}

describe("summon residue", () => {
	it("pins ACTION_ASSIST with DEFAULT to MainActivity alone", () => {
		const declared = activities(fs.readFileSync(MANIFEST, "utf8"));
		const assist = declared.filter((a) => a.body.includes("android.intent.action.ASSIST"));
		expect(assist.map((a) => a.name)).toEqual([".MainActivity"]);
		const filter = [...assist[0].body.matchAll(/<intent-filter>([\s\S]*?)<\/intent-filter>/g)]
			.map((m) => m[1])
			.find((f) => f.includes("android.intent.action.ASSIST"));
		expect(filter).toContain("android.intent.category.DEFAULT");
	});

	it("hands a locked summon to the app before the panel draws", () => {
		const manifest = fs.readFileSync(MANIFEST, "utf8");
		const service = /<service[^>]*AssistantVoiceService[\s\S]*?<\/service>/.exec(manifest)?.[0] ?? "";
		expect(service).toContain("android.permission.BIND_VOICE_INTERACTION");
		expect(service).toContain('android:resource="@xml/assistant_session"');
		const xml = fs.readFileSync(path.join(MAIN, "res", "xml", "assistant_session.xml"), "utf8");
		expect(xml).toContain('android:supportsLaunchVoiceAssistFromKeyguard="false"');
		const session = fs.readFileSync(
			path.join(KOTLIN, "com", "atelier_nyaarium", "switchboard", "assistant", "AssistantPanelSession.kt"),
			"utf8",
		);
		const prepare = /override fun onPrepareShow[\s\S]*?\n\t}\n/.exec(session)?.[0] ?? "";
		expect(prepare).toContain("isKeyguardLocked");
		expect(prepare).toContain("appLockAsks(");
		const decided = prepare.indexOf("panelShow(");
		expect(decided).toBeGreaterThan(-1);
		expect(decided).toBeLessThan(prepare.indexOf("setUiEnabled(true)"));
	});

	it("refuses drawing over the keyguard and the microphone", () => {
		const files = [MANIFEST, ...kotlinFiles(KOTLIN)];
		// Prevent vacuous file scans.
		expect(files.length).toBeGreaterThan(50);
		for (const file of files) {
			const content = fs.readFileSync(file, "utf8");
			for (const pattern of REFUSED) {
				expect(content, `${path.relative(MAIN, file)} uses ${pattern}`).not.toMatch(pattern);
			}
		}
	});
});
