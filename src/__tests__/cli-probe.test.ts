import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliProbeScript, type ProbeLauncher, parseCliProbe } from "../shared/cli-probe.js";
import { SESSION_HARNESSES } from "../shared/session-harness.js";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function stub(file: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

/** A place with Claude on PATH and OpenCode only in its installer's home directory. */
function place(): { home: string; bin: string; launcher: ProbeLauncher } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-probe-"));
	made.push(home);
	const bin = path.join(home, "bin");
	stub(path.join(bin, "claude"));
	stub(path.join(home, ".opencode", "bin", "opencode"));
	const launcher = { runtime: path.join(home, "bun"), root: path.join(home, "sb") };
	stub(launcher.runtime);
	fs.mkdirSync(path.join(launcher.root, "dist"), { recursive: true });
	fs.writeFileSync(path.join(launcher.root, "dist", "main-opencode-launch.js"), "");
	fs.writeFileSync(path.join(launcher.root, "package.json"), "{}");
	return { home, bin, launcher };
}

function probe(at: { home: string; bin: string }, launcher: ProbeLauncher | null) {
	const out = execFileSync("/bin/sh", ["-c", cliProbeScript(SESSION_HARNESSES, launcher)], {
		env: { HOME: at.home, PATH: at.bin },
		encoding: "utf8",
		timeout: 10_000,
	});
	return parseCliProbe(out, SESSION_HARNESSES);
}

describe("what a place's own shell finds installed", () => {
	it("finds a CLI on PATH or in its installer's directory, and OpenCode only beside a launcher it can run", () => {
		const at = place();

		expect(probe(at, at.launcher)).toEqual(["claude", "opencode"]);
		expect(probe(at, null)).toEqual(["claude"]);
	});

	it("offers OpenCode only when the launcher's runtime runs, its bundle exists, and its copy is whole", () => {
		const noRuntime = place();
		fs.chmodSync(noRuntime.launcher.runtime, 0o644);
		const noBundle = place();
		fs.rmSync(path.join(noBundle.launcher.root, "dist"), { recursive: true });
		const halfCopied = place();
		fs.rmSync(path.join(halfCopied.launcher.root, "package.json"));

		expect(probe(noRuntime, noRuntime.launcher)).toEqual(["claude"]);
		expect(probe(noBundle, noBundle.launcher)).toEqual(["claude"]);
		expect(probe(halfCopied, halfCopied.launcher)).toEqual(["claude"]);
	});

	it("lists what it finds in offer order, whatever order the shell printed", () => {
		const at = place();
		stub(path.join(at.bin, "copilot"));

		expect(probe(at, at.launcher)).toEqual(["claude", "opencode", "copilot"]);
		expect(parseCliProbe("copilot\nnot-a-cli\nclaude\n", SESSION_HARNESSES)).toEqual(["claude", "copilot"]);
	});
});
