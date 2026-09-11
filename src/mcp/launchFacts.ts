import fs from "node:fs";

////////////////////////////////
//  Functions & Helpers

/**
 * The id `--resume` asked for, read from the parent's NUL-separated cmdline.
 *
 * Only the resume value is ever read out. The session token is exported by the wrapping shell and
 * never reaches this argv, and nothing here emits the line it parsed.
 */
export function resumeArgOf(cmdline: string): string | null {
	const parts = cmdline.split("\0").filter(Boolean);
	const at = parts.indexOf("--resume");
	const value = at === -1 ? undefined : parts[at + 1];
	return value && /^[0-9a-fA-F-]{8,}$/.test(value) ? value : null;
}

/** Absent off Linux, or when the parent cannot be read. */
export function readResumeArg(ppid: number): string | null {
	try {
		return resumeArgOf(fs.readFileSync(`/proc/${ppid}/cmdline`, "utf8"));
	} catch {
		return null;
	}
}

export interface LaunchFacts {
	team: string;
	envPinned: boolean;
	sessionId?: string;
	resumedFrom: string | null;
}

/**
 * How this session came up, in one line, so a thread that went quiet can be traced to its bring-up.
 *
 * Two facts decide whether the phone's thread still addresses this session, and both are here:
 * a DERIVED identity is computed from the session id, and `--resume` mints a fresh session id, so a
 * derived resume comes up under a name nothing was addressing. `forked` marks that new id whether
 * the identity was pinned or not, since it is also what repoints the gateway's transcript record.
 */
export function bringUpLine(facts: LaunchFacts): string {
	const identity = facts.envPinned ? "env-pinned" : "derived - manual launch?";
	const line = [`[bridge] identity ${facts.team} (${identity})`];
	if (facts.resumedFrom) {
		const forked = facts.sessionId !== undefined && facts.sessionId !== facts.resumedFrom;
		line.push(`resumed ${facts.resumedFrom}${forked ? ` as ${facts.sessionId} (forked)` : ""}`);
	} else if (facts.sessionId) {
		line.push(`fresh ${facts.sessionId}`);
	}
	return line.join(", ");
}
