// The SessionStart compact hook: the session's baseline, as one reminder block of hook context.

import { isInsideContainer } from "../../shared/env.js";
import {
	MAX_BASELINE_CHARS,
	SESSION_BASELINE_PATH,
	type SessionBaseline,
	SessionBaselineSchema,
} from "../../shared/session-baseline.js";
import { oneLine as flat, neutralizeMarkup, reminderBlock } from "../../shared/system-reminder.js";

////////////////////////////////
//  Interfaces & Types

export type HookEnv = Readonly<Record<string, string | undefined>>;

////////////////////////////////
//  Constants

const FETCH_TIMEOUT_MS = 8_000;

/** The tags around the lines. */
const WRAPPER_CHARS = reminderBlock(["-"]).length - 1;

////////////////////////////////
//  Functions & Helpers

/** Board last: `taskBoardList` recovers what a cut drops. */
function linesOf(baseline: SessionBaseline): string[] {
	return [
		...baseline.conversations.map(({ sessionId, peer }) =>
			peer.kind === "owner"
				? `conversation: ${sessionId} owner`
				: `conversation: ${sessionId} ${flat(peer.name)}`,
		),
		...baseline.routines.map(({ occurrenceId, routine }) => `routine: ${occurrenceId} ${flat(routine)}`),
		...baseline.agents.map(({ family, agentId }) => `agent: ${family} ${agentId} turn running`),
		...(baseline.assistant?.watchers ?? []).map(
			({ label, unread, evicted, stopped, waiting }) =>
				`watcher: ${flat(label)} ${unread} in inbox` +
				(stopped === undefined ? "" : `, stopped: ${flat(stopped)}`) +
				(waiting === undefined ? "" : `, waiting: ${flat(waiting)}`) +
				(evicted > 0 ? `, ${evicted} lost unread` : ""),
		),
		...(baseline.board === null
			? ["board: unavailable"]
			: baseline.board.map(
					({ id, title, state, parent }) =>
						`board: ${id} ${state}${parent === undefined ? "" : ` parent ${parent}`} ${flat(title)}`,
				)),
	];
}

/** Empty when the session holds nothing. */
export function renderBaseline(baseline: SessionBaseline): string {
	// Measured as sent: escaped, then wrapped.
	const lines = linesOf(baseline).map(neutralizeMarkup);
	if (lines.length === 0) return "";
	const kept = ["baseline: compaction"];
	let size = WRAPPER_CHARS + kept[0].length;
	for (const [index, line] of lines.entries()) {
		const left = lines.length - index;
		const note = `truncated: ${left} more`;
		if (size + line.length + note.length + 2 > MAX_BASELINE_CHARS) {
			kept.push(note);
			break;
		}
		kept.push(line);
		size += line.length + 1;
	}
	return reminderBlock(kept);
}

/** The hook's stdout, or null to print nothing. Never throws. */
export async function baselineHookOutput(env: HookEnv, fetchImpl: typeof fetch = fetch): Promise<string | null> {
	const token = env.SWITCHBOARD_SESSION_TOKEN;
	if (!token) return null;
	const base = env.BRIDGE_ROUTER_URL ?? (isInsideContainer() ? "http://switchboard:20000" : "http://localhost:20000");
	try {
		const res = await fetchImpl(`${base}${SESSION_BASELINE_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-session-token": token },
			body: "{}",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const parsed = SessionBaselineSchema.safeParse(await res.json());
		if (!parsed.success) return null;
		const context = renderBaseline(parsed.data);
		if (!context) return null;
		return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } });
	} catch {
		return null;
	}
}
