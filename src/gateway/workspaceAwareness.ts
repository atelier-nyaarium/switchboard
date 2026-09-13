// Files the owner changed from the phone, banked at `no_act` to ride the session's next message.

import type { AwarenessSubscriber, Change } from "../shared/awareness-types.js";
import {
	answerForConsole,
	type WorkspaceOp,
	type WorkspaceOpAnswer,
	type WorkspaceOpResult,
} from "../shared/workspace-op.js";

////////////////////////////////
//  Interfaces & Types

export interface WorkspaceChange {
	path: string;
	change: "edited" | "created" | "deleted" | "moved" | "copied";
	/** Where a move or copy landed. */
	to?: string;
	/** False for an `unknown` answer, which may have landed; only the phone's read back knows. */
	confirmed: boolean;
}

////////////////////////////////
//  Functions & Helpers

/** Null for a read, and for any write known to have written nothing. */
export function workspaceChangeOf(op: WorkspaceOp, answer: WorkspaceOpAnswer): WorkspaceChange | null {
	if (op.kind === "saveSpan" && answer.kind === "saveSpan") {
		if (answer.outcome !== "saved" && answer.outcome !== "unknown") return null;
		// The id embeds its module when the span could not be read back.
		return {
			path: answer.current?.module ?? answer.symbolId,
			change: "edited",
			confirmed: answer.outcome === "saved",
		};
	}
	if (op.kind !== "mutateFile" || answer.kind !== "mutateFile") return null;
	if (answer.outcome !== "done" && answer.outcome !== "unknown") return null;
	const confirmed = answer.outcome === "done";
	const { mutation } = op;
	switch (mutation.kind) {
		case "write":
			return { path: mutation.path, change: "edited", confirmed };
		case "create":
			return { path: mutation.path, change: "created", confirmed };
		case "delete":
			return { path: mutation.path, change: "deleted", confirmed };
		case "move":
			return { path: mutation.path, change: "moved", to: mutation.to, confirmed };
		case "copy":
			return { path: mutation.path, change: "copied", to: mutation.to, confirmed };
	}
}

/** The console's answer to a workspace op, telling `noted` of any change it may have made. */
export function workspaceAnswerNoting(
	op: WorkspaceOp,
	result: WorkspaceOpResult,
	noted: (change: WorkspaceChange) => void,
): WorkspaceOpAnswer {
	const answer = answerForConsole(op, result);
	const change = workspaceChangeOf(op, answer);
	if (change !== null) noted(change);
	return answer;
}

function lineOf(change: WorkspaceChange): string {
	const verb = change.confirmed ? change.change : `may have ${change.change}`;
	return change.to === undefined ? `${verb} ${change.path}` : `${verb} ${change.path} to ${change.to}`;
}

/** Lines past this are counted, not listed. */
const MAX_NOTICE_LINES = 40;

/** One line per path, its latest change. */
function render(_sessionKey: string, changes: readonly Change<WorkspaceChange>[]): string {
	const lines = changes.flatMap((change) => (change.post ? [`- ${lineOf(change.post)}`] : []));
	if (lines.length === 0) return "";
	const listed = lines.slice(0, MAX_NOTICE_LINES);
	if (lines.length > MAX_NOTICE_LINES) listed.push(`- and ${lines.length - MAX_NOTICE_LINES} more`);
	return `
The owner changed files in this workspace from their phone. They will tell you if it needs your attention.
${listed.join("\n")}
	`.trim();
}

export const workspaceAwarenessSubscriber: AwarenessSubscriber<WorkspaceChange> = {
	source: "files",
	act: () => "no_act",
	render,
};
