// Frames between the Gateway and a session's own plugin, for a CLI the plugin drives.

import type { PromptDecision, PromptOutcome } from "./host-op.js";
import { DerivedPresenceSchema } from "./schemasPresence.js";

////////////////////////////////
//  Constants

/** A plugin's report of its own session's state. A bare frame clears it. */
export const SESSION_PRESENCE_FRAME = "session_presence";
export const SESSION_CONTROL_FRAME = "session_control";
export const SESSION_CONTROL_REPLY_FRAME = "session_control_reply";

/** Inside the console's own answer wait. */
export const SESSION_CONTROL_WAIT_MS = 20_000;

/** Holds past any sane retry. */
export const SESSION_CONTROL_DEDUPE_MS = 120_000;

////////////////////////////////
//  Interfaces & Types

/** Only what the CLI's API yields; the Gateway derives the rest. */
export const SessionPresenceReportSchema = DerivedPresenceSchema.pick({
	working: true,
	needsLogin: true,
	limitBlocked: true,
	limitDetail: true,
	prompt: true,
	compacting: true,
});

export type SessionControlOp = {
	kind: "answerPrompt";
	promptId: string;
	decision: PromptDecision;
	/** Steers the session on a deny. */
	reason?: string;
};

export type SessionControlFailure = "refused" | "failed" | "timeout" | "disconnected";

export type SessionControlResult =
	| { ok: true; outcome: PromptOutcome }
	| { ok: false; failure: SessionControlFailure; detail: string };

/** `key` is the idempotency key: a replay answers the first result. */
export interface SessionControlRequest {
	type: typeof SESSION_CONTROL_FRAME;
	reqId: string;
	key: string;
	op: SessionControlOp;
}

export interface SessionControlReply {
	type: typeof SESSION_CONTROL_REPLY_FRAME;
	reqId: string;
	result: SessionControlResult;
}

////////////////////////////////
//  Functions & Helpers

/** Null when the frame names no op this build reads. */
export function parseSessionControlOp(value: unknown): SessionControlOp | null {
	if (typeof value !== "object" || value === null) return null;
	const { kind, promptId, decision, reason } = value as Record<string, unknown>;
	if (kind !== "answerPrompt" || typeof promptId !== "string") return null;
	if (decision !== "approve" && decision !== "deny") return null;
	return { kind, promptId, decision, ...(typeof reason === "string" && reason ? { reason } : {}) };
}

export function parseSessionControlResult(value: unknown): SessionControlResult | null {
	if (typeof value !== "object" || value === null) return null;
	const { ok, outcome, failure, detail } = value as Record<string, unknown>;
	if (ok === true) return outcome === "answered" || outcome === "stale" ? { ok, outcome } : null;
	if (ok !== false || typeof detail !== "string") return null;
	if (failure !== "refused" && failure !== "failed" && failure !== "timeout" && failure !== "disconnected")
		return null;
	return { ok, failure, detail };
}
