// The gate as a PreToolUse hook: stdin JSON in, a deny decision out, nothing to allow.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gateVerdict } from "./gate.js";

type HookEnv = Readonly<Record<string, string | undefined>>;

/** Never throws, and denies whatever it cannot read. */
export function gateHookOutput(stdin: string, env: HookEnv): string | null {
	let input: unknown;
	try {
		input = JSON.parse(stdin);
	} catch {
		return deny("assistant gate: unreadable hook input");
	}
	const root = env.CLAUDE_PROJECT_DIR;
	if (!root) return deny("assistant gate: no project directory");
	const home = env.HOME || os.homedir();
	try {
		// The host falls back to home for a workdir it cannot find.
		if (holds(fs.realpathSync.native(root), fs.realpathSync.native(home))) {
			return deny(`assistant gate: ${root} is not a notes folder`);
		}
		const verdict = gateVerdict(input, { notes: root, home });
		return verdict.allow ? null : deny(verdict.reason);
	} catch (error) {
		return deny(`assistant gate: ${(error as Error).message}`);
	}
}

function holds(root: string, inner: string): boolean {
	const relative = path.relative(root, inner);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function deny(reason: string): string {
	return JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	});
}
