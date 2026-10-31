import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ANDROID = path.resolve(import.meta.dirname, "../../android");
const ALLOWLIST = [{ file: "CapabilityLog.kt", why: "Canonical logging seam." }];
const DEBUG_LOG_CALL = /\bDebugLog\s*\.\s*log\s*\(/;

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

function code(file: string): string {
	return fs
		.readFileSync(file, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, " ")
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

const relative = (file: string) => path.relative(ANDROID, file).split(path.sep).join("/");

function isCapabilityFile(file: string): boolean {
	const rel = relative(file);
	const name = path.posix.basename(rel);
	return rel.includes("/phone/") || /^(PhoneCapabilit|CapabilityLog|AssistantNotificationListener)/.test(name);
}

describe("capability logging residue", () => {
	const files = kotlinFiles(ANDROID).filter(isCapabilityFile);

	it("keeps direct logging inside its seam", () => {
		const allowed = new Set(ALLOWLIST.map(({ file }) => file));
		const offenders = files
			.filter((file) => !allowed.has(path.posix.basename(relative(file))) && DEBUG_LOG_CALL.test(code(file)))
			.map(relative);
		expect(offenders).toEqual([]);
	});

	it("keeps allowlist entries justified", () => {
		expect(ALLOWLIST.every(({ file, why }) => file.length > 0 && why.trim().length > 0)).toBe(true);
	});
});
