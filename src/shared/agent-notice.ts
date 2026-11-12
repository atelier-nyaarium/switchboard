// What a session is told about its delegated agents' turns, rendered once for the Gateway and local mode.

import { type AgentBackendId, agentBackend } from "./agent-backend.js";
import { type AgentProgressCounts, formatAgentProgressCounts } from "./agent-counter.js";
import type { Ambient } from "./ambient.js";
import { neutralizeMarkup, oneLine } from "./system-reminder.js";

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

const AGENT_COLLECT_TOOL = "agentCollect";

////////////////////////////////
//  Functions & Helpers

export function isNoAckSessionId(sessionId: string): boolean {
	return sessionId.startsWith(NO_ACK_SESSION_PREFIX);
}

export function mintNoAckSessionId(ambient: Pick<Ambient, "randomBytes">): string {
	return `${NO_ACK_SESSION_PREFIX}${ambient.randomBytes(8).toString("hex")}`;
}

/** One line, markup escaped. */
const escaped = (text: string): string => neutralizeMarkup(oneLine(text));

function clipped(note: string): string {
	const line = escaped(note);
	return line.length <= NOTE_CHARS ? line : `${line.slice(0, NOTE_CHARS - 3)}...`;
}

export function progressCheckupLine(counts: AgentProgressCounts, latest: string): string {
	return `Since last check: ${formatAgentProgressCounts(counts)}. Latest: ${clipped(latest || "No new note")}`;
}

export function agentNoticeLine(notice: AgentNotice): string {
	const agent = `${agentBackend(notice.family).displayName} agent \`${escaped(notice.agentId)}\``;
	if (notice.kind === "done") {
		return `${agent} finished its turn: ${escaped(notice.outcome)}. Call \`${AGENT_COLLECT_TOOL}\` with its agentId for the result.`;
	}
	const check = progressCheckupLine(notice.counts, notice.notes.at(-1) ?? "");
	return `${check}\n${agent} is still working (${notice.minutes} min). No action needed.`;
}

export function workflowNoticeLine(state: WorkflowNoticeText): string {
	const runId = escaped(state.runId);
	if (state.status !== "running") {
		return `Workflow ${runId} ${escaped(state.status)}. Call workflowCollect with runId ${runId}.`;
	}
	const logs = state.logs.map(escaped);
	const latest = state.logs.at(-1) || "No new log line";
	const lines = [
		progressCheckupLine(state.counts, latest),
		`Workflow ${runId} is running. Phase: ${state.phase ? escaped(state.phase) : "not started"}. Steps settled: ${state.stepsSettled}; running: ${state.stepsRunning}.`,
	];
	if (state.failed > 0 && state.newestFailure) {
		lines.push(`Failed steps: ${state.failed}; newest ${escaped(state.newestFailure)}.`);
	}
	if (logs.length > 0) lines.push(`Recent script log: ${logs.join(" | ")}`);
	return lines.join("\n");
}

/** A completion asks the session to fetch its result; progress asks nothing. */
export function agentNoticeAct(notice: AgentNotice): "act_now" | "no_act" {
	return notice.kind === "done" ? "act_now" : "no_act";
}
