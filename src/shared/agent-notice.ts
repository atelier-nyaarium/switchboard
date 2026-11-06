// What a session is told about its delegated agents' turns, rendered once for the Gateway and local mode.

import type { AgentBackendId } from "./agent-backend.js";
import type { Ambient } from "./ambient.js";

////////////////////////////////
//  Interfaces & Types

export type AgentNotice =
	| { kind: "progress"; family: AgentBackendId; agentId: string; minutes: number; notes: readonly string[] }
	| { kind: "done"; family: AgentBackendId; agentId: string; outcome: string };

////////////////////////////////
//  Constants

export const AGENT_PROGRESS_EVERY_MS = 10 * 60_000;

/** The awareness source both roads stamp. */
export const AGENT_NOTICE_SOURCE = "agents";

/** A reply to this session id is absorbed rather than delivered. */
const NO_ACK_SESSION_PREFIX = "na-";

const NOTES_SHOWN = 3;

const NOTE_CHARS = 300;

export const AGENT_AWAIT_TOOL: Record<AgentBackendId, string> = {
	codex: "codexAwaitAgent",
	copilot: "copilotAwaitAgent",
};

const LABEL: Record<AgentBackendId, string> = { codex: "Codex", copilot: "Copilot" };

////////////////////////////////
//  Functions & Helpers

export function isNoAckSessionId(sessionId: string): boolean {
	return sessionId.startsWith(NO_ACK_SESSION_PREFIX);
}

export function mintNoAckSessionId(ambient: Pick<Ambient, "randomBytes">): string {
	return `${NO_ACK_SESSION_PREFIX}${ambient.randomBytes(8).toString("hex")}`;
}

function clipped(note: string): string {
	const line = note.replace(/\s+/g, " ").trim();
	return line.length <= NOTE_CHARS ? line : `${line.slice(0, NOTE_CHARS - 3)}...`;
}

export function agentNoticeLine(notice: AgentNotice): string {
	const agent = `${LABEL[notice.family]} agent \`${notice.agentId}\``;
	if (notice.kind === "done") {
		return `${agent} finished its turn: ${notice.outcome}. Call \`${AGENT_AWAIT_TOOL[notice.family]}\` with its agentId for the result.`;
	}
	const head = `${agent} is still working (${notice.minutes} min). No action needed.`;
	const notes = notice.notes.slice(-NOTES_SHOWN).map((note) => `- ${clipped(note)}`);
	return notes.length === 0 ? head : `${head} Latest notes:\n${notes.join("\n")}`;
}

/** A completion asks the session to fetch its result; progress asks nothing. */
export function agentNoticeAct(notice: AgentNotice): "act_now" | "no_act" {
	return notice.kind === "done" ? "act_now" : "no_act";
}
