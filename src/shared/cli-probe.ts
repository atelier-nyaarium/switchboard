// What a place's own shell finds installed.

import { LAUNCHERS } from "./launcher-spec.js";
import { HARNESS, type SessionHarness } from "./session-harness.js";

////////////////////////////////
//  Interfaces & Types

/** Where an API row's launcher runs, as the place sees it. */
export interface ProbeLauncher {
	runtime: string;
	root: string;
}

////////////////////////////////
//  Functions & Helpers

function foundTest(harness: SessionHarness, launcher: ProbeLauncher | null): string {
	const { binary, road } = HARNESS[harness];
	const finds = [`command -v ${binary.posix} >/dev/null 2>&1`];
	if (binary.homeDir) finds.push(`[ -x "$HOME/${binary.homeDir}/${binary.posix}" ]`);
	const tests = [`{ ${finds.join(" || ")}; }`];
	if (road.kind === "api") {
		// No launcher here, so never offered.
		if (!launcher) return "false";
		tests.push(`[ -x "${launcher.runtime}" ]`, `[ -f "${launcher.root}/dist/${LAUNCHERS[road.server].bundle}" ]`);
	}
	return tests.join(" && ");
}

/** A posix script printing each candidate it finds, one per line. */
export function cliProbeScript(candidates: readonly SessionHarness[], launcher: ProbeLauncher | null): string {
	return candidates.map((harness) => `if ${foundTest(harness, launcher)}; then echo ${harness}; fi`).join("; ");
}

/** The candidates the script printed, in offer order. */
export function parseCliProbe(out: string, candidates: readonly SessionHarness[]): SessionHarness[] {
	const said = new Set(out.split("\n").map((line) => line.trim()));
	return candidates.filter((harness) => said.has(harness));
}
