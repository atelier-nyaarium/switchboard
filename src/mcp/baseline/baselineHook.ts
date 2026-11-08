// Compact session baseline hook.

import {
	baselineLines,
	SESSION_BASELINE_PATH,
	type SessionBaseline,
	SessionBaselineSchema,
} from "../../shared/session-baseline.js";
import { reminderBlock } from "../../shared/system-reminder.js";
import { askGateway, type HookEnv } from "../hookGateway.js";

export type { HookEnv } from "../hookGateway.js";

////////////////////////////////
//  Constants

const FETCH_TIMEOUT_MS = 8_000;

////////////////////////////////
//  Functions & Helpers

/** Empty when the session holds nothing. */
export function renderBaseline(baseline: SessionBaseline): string {
	const lines = baselineLines(baseline);
	return lines.length === 0 ? "" : reminderBlock(lines);
}

/** The hook's stdout, or null to print nothing. Never throws. */
export async function baselineHookOutput(env: HookEnv, fetchImpl: typeof fetch = fetch): Promise<string | null> {
	const parsed = SessionBaselineSchema.safeParse(
		await askGateway(env, SESSION_BASELINE_PATH, FETCH_TIMEOUT_MS, fetchImpl),
	);
	if (!parsed.success) return null;
	const context = renderBaseline(parsed.data);
	if (!context) return null;
	return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } });
}
