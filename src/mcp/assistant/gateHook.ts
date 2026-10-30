// The gate as a PreToolUse hook: stdin JSON in, a deny decision out, nothing to allow.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ASSISTANT_WRITE_LOCK_PATH, WriteLockAnswerSchema } from "../../shared/assistant-write-lock.js";
import { askGateway, type HookEnv } from "../hookGateway.js";
import { gateVerdict, writeLockReason } from "./gate.js";

const LOCK_TIMEOUT_MS = 5_000;

/** Never throws, and denies whatever it cannot read. */
export async function gateHookOutput(
	stdin: string,
	env: HookEnv,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
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
		if (!verdict.allow) return deny(verdict.reason);
		return verdict.write ? await writeLocked(env, fetchImpl) : null;
	} catch (error) {
		return deny(`assistant gate: ${(error as Error).message}`);
	}
}

/** An unread lock refuses. */
async function writeLocked(env: HookEnv, fetchImpl: typeof fetch): Promise<string | null> {
	const answer = WriteLockAnswerSchema.safeParse(
		await askGateway(env, ASSISTANT_WRITE_LOCK_PATH, LOCK_TIMEOUT_MS, fetchImpl),
	);
	if (!answer.success) return deny("assistant gate: the write lock could not be read");
	if (answer.data.kind === "open") return null;
	if (answer.data.kind === "locked") return deny(writeLockReason(answer.data.idleMs));
	return deny(`assistant gate: the write lock answered ${answer.data.kind}`);
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
