// The gate as a PreToolUse hook: stdin JSON in, a deny decision out, nothing to allow.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HoldAnswerSchema, type HoldDenial, holdDenial } from "../../shared/assistant-hold.js";
import { askAssistantHold, type HookEnv } from "../hookGateway.js";
import { gateVerdict } from "./gate.js";

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
		return verdict.hold ? await holdRequired(env, fetchImpl) : null;
	} catch (error) {
		return deny(`assistant gate: ${(error as Error).message}`);
	}
}

async function holdRequired(env: HookEnv, fetchImpl: typeof fetch): Promise<string | null> {
	const answer = HoldAnswerSchema.safeParse(await askAssistantHold(env, LOCK_TIMEOUT_MS, fetchImpl));
	if (!answer.success) {
		const unreadable: HoldDenial = { kind: "unreadable", reason: "the Gateway did not answer" };
		return deny(holdDenial(unreadable));
	}
	if (answer.data.kind === "held") return null;
	return deny(holdDenial(answer.data));
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
