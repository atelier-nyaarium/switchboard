// What a session is told about its delegated agents' turns, rendered once for the Gateway and local mode.

import type { AgentBackendId } from "./agent-backend.js";
import { type AgentProgressCounts, formatAgentProgressCounts } from "./agent-counter.js";
import type { Ambient } from "./ambient.js";

////////////////////////////////
//  Interfaces & Types

export type AgentNotice =
	| {
			kind: "progress";
			family: AgentBackendId;
			agentId: string;
			minutes: number;
			notes: readonly string[];
			counts: AgentProgressCounts;
	  }
	| { kind: "done"; family: AgentBackendId; agentId: string; outcome: string };

export interface WorkflowNoticeText {
	runId: string;
	status: string;
	phase: string | null;
	stepsSettled: number;
	stepsRunning: number;
	failed: number;
	newestFailure: string | null;
	logs: readonly string[];
	counts: AgentProgressCounts;
}

////////////////////////////////
//  Constants

export const AGENT_PROGRESS_EVERY_MS = 10 * 60_000;

/** The awareness source both roads stamp. */
export const AGENT_NOTICE_SOURCE = "agents";

/** A reply to this session id is absorbed rather than delivered. */
const NO_ACK_SESSION_PREFIX = "na-";

const NOTE_CHARS = 300;

export const AGENT_AWAIT_TOOL: Record<AgentBackendId, string> = {
	codex: "codexCollectAgent",
	copilot: "copilotCollectAgent",
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

export function progressCheckupLine(counts: AgentProgressCounts, latest: string): string {
	return `Since last check: ${formatAgentProgressCounts(counts)}. Latest: ${clipped(latest || "No new note")}`;
}

export function agentNoticeLine(notice: AgentNotice): string {
	const agent = `${LABEL[notice.family]} agent \`${notice.agentId}\``;
	if (notice.kind === "done") {
		return `${agent} finished its turn: ${notice.outcome}. Call \`${AGENT_AWAIT_TOOL[notice.family]}\` with its agentId for the result.`;
	}
	const check = progressCheckupLine(notice.counts, notice.notes.at(-1) ?? "");
	return `${check}\n${agent} is still working (${notice.minutes} min). No action needed.`;
}

export function workflowNoticeLine(state: WorkflowNoticeText): string {
	if (state.status !== "running") {
		return `Workflow ${state.runId} ${state.status}. Call workflowCollect with runId ${state.runId}.`;
	}
	const latest = state.logs.at(-1)?.replace(/\s+/g, " ").trim() || "No new log line";
	const lines = [
		progressCheckupLine(state.counts, latest),
		`Workflow ${state.runId} is running. Phase: ${state.phase ?? "not started"}. Steps settled: ${state.stepsSettled}; running: ${state.stepsRunning}.`,
	];
	if (state.failed > 0 && state.newestFailure) {
		lines.push(`Failed steps: ${state.failed}; newest ${state.newestFailure}.`);
	}
	if (state.logs.length > 0) lines.push(`Recent log: ${state.logs.join(" | ")}`);
	return lines.join("\n");
}

/** A completion asks the session to fetch its result; progress asks nothing. */
export function agentNoticeAct(notice: AgentNotice): "act_now" | "no_act" {
	return notice.kind === "done" ? "act_now" : "no_act";
}
