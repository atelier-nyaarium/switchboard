// The daemon's `windows` spawn point: availability probe and PowerShell paths.
// Measured on a WSL box.

import { execFileSync } from "node:child_process";
import { placeCandidates } from "../../shared/cli-resolve.js";
import { type HostListDirsResult, isSpawnWorkdirPath } from "../../shared/host-op.js";
import { isUncPath, WINDOWS_SPAWN } from "../../shared/host-spawn.js";
import { HARNESS, type SessionHarness } from "../../shared/session-harness.js";

////////////////////////////////
//  Interfaces & Types

export interface WindowsSpawnAvailability {
	available: boolean;
	/** `$env:USERPROFILE`; never fall back to the WSL home (a UNC path). */
	userProfile?: string;
	/** The CLIs that resolve there. */
	harnesses?: SessionHarness[];
	/** For the log only. */
	reason?: string;
}

////////////////////////////////
//  Functions & Helpers

const PROBE_TIMEOUT_MS = 20_000;

function run(file: string, args: string[]): string | null {
	try {
		return execFileSync(file, args, {
			encoding: "utf8",
			timeout: PROBE_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

/**
 * Probes for an agent CLI, not just the shell, so a wake never fails after tmux state exists.
 * Full Windows names: bare `claude` does not resolve from PowerShell.
 * One invocation, since startup dominates; `-NoProfile` keeps the answer stable.
 */
export function probeWindowsSpawn(): WindowsSpawnAvailability {
	const candidates = placeCandidates({ place: "windows", assistant: false });
	const finds = candidates.map(
		(harness) =>
			`$c = Get-Command ${HARNESS[harness].binary.windows} -ErrorAction SilentlyContinue; if ($c) { Write-Output "${harness}=$($c.Source)" }`,
	);
	const out = run("powershell.exe", [
		"-NoLogo",
		"-NoProfile",
		"-Command",
		`${finds.join("; ")}; Write-Output "profile=$env:USERPROFILE"`,
	]);
	if (out == null) return { available: false, reason: `powershell.exe did not run` };
	const harnesses = candidates.filter((harness) => new RegExp(`^${harness}=.+$`, "m").test(out));
	if (harnesses.length === 0) return { available: false, reason: `no session CLI is on the Windows PATH` };
	const userProfile = /^profile=(.+)$/m.exec(out)?.[1]?.trim();
	if (!userProfile || isUncPath(userProfile)) {
		return { available: false, reason: `unusable Windows home ${userProfile ?? "(none)"}` };
	}
	return { available: true, userProfile, harnesses };
}

/** Refuses a UNC result: PowerShell cannot hand a UNC cwd to legacy console apps. */
export function resolveWindowsWorkdir(
	hint: string | undefined,
	userProfile: string,
): { workdir: string } | { error: string } {
	// A hint may be a session label, which means nothing to Windows.
	if (!hint || !isPathShaped(hint)) return { workdir: userProfile };
	// A drive-letter path skips `wslpath -w`, which is not a reliable no-op.
	const translated = WINDOWS_DRIVE_PATH.test(hint) ? hint : run("wslpath", ["-w", hint])?.trim();
	if (!translated) return { error: `"${hint}" could not be translated to a Windows path` };
	if (isUncPath(translated)) {
		return {
			error: `"${hint}" is on the Linux side of this machine (${translated}). A windows session needs a Windows directory, such as /mnt/c/Users/you/project.`,
		};
	}
	// A quote would break the Set-Location argument.
	if (translated.includes("'") || translated.includes('"')) {
		return { error: `"${hint}" translates to a path containing a quote, which cannot be launched` };
	}
	return { workdir: translated };
}

/** The spawn ids this machine offers beyond the always-available ones. */
export function detectedHostSpawns(probe: WindowsSpawnAvailability): string[] {
	return probe.available ? [WINDOWS_SPAWN] : [];
}

/** A wire bound, matching listHostDirs'. */
const MAX_DIR_ENTRIES = 5000;

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** A path, not a label. */
function isPathShaped(hint: string): boolean {
	return WINDOWS_DRIVE_PATH.test(hint) || hint.startsWith("/") || hint === "~" || hint.startsWith("~/");
}

/** The Windows home with forward slashes. */
export function windowsHome(userProfile: string): string {
	return userProfile.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Subdirectories of a Windows directory, listed by PowerShell so network drives show and Linux
 * paths do not. `-Force` shows hidden ones; unreadable ones are skipped. Blank is the Windows home.
 * Empty on failure.
 */
export function listWindowsDirs(rawPath: string, userProfile?: string): HostListDirsResult {
	if (rawPath.length === 0) {
		if (!userProfile) return { entries: [] };
		const home = windowsHome(userProfile);
		return { ...listWindowsDirs(home), path: home };
	}
	// The daemon re-guards with the SAME rule the gateway boundary applied, rather than a narrower
	// hand-rolled quote check: the convention here is that a path is gateway-validated and the daemon
	// re-guards, and two different rules for one question is what this whole change spent the day
	// removing. It rejects quotes, control characters and the rest of WORKDIR_PATH_FORBIDDEN.
	//
	// PowerShell single quotes do not interpolate, so `$(...)`, backtick and `$var` inside them are
	// already literal, and `-LiteralPath` stops the remainder being read as a wildcard pattern. The
	// one character that WOULD end the string early is `'`, which the shared rule forbids. No shell is
	// involved on this side: execFile passes argv directly, never through sh.
	if (!isSpawnWorkdirPath(WINDOWS_SPAWN, rawPath)) return { entries: [] };
	const out = run("powershell.exe", [
		"-NoLogo",
		"-NoProfile",
		"-Command",
		`Get-ChildItem -LiteralPath '${rawPath}' -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }`,
	]);
	if (out == null) return { entries: [] };
	const entries = out
		// Only the line ending is stripped, never leading whitespace: a directory may legitimately
		// begin with a space on Windows, and trimming both ends would hand back a name that does not
		// exist. `listHostDirs` does not trim at all, and this is as close to that as a line-oriented
		// reader can get.
		.split("\n")
		.map((line) => line.replace(/\r$/, "").replace(/\s+$/, ""))
		.filter((line) => line.length > 0)
		.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
	if (entries.length > MAX_DIR_ENTRIES) return { entries: entries.slice(0, MAX_DIR_ENTRIES), truncated: true };
	return { entries };
}
