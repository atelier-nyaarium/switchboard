// The plugin's end of the workspace plane: one frame in, one frame out.
//
// Wired at startup so the socket handler needs no knowledge of where the root or the Lexicon session
// come from. Unwired, every op is refused rather than answered with a guess at the workspace.

import { FileMutationSchema } from "../../shared/schemasWorkspace.js";
import {
	WORKSPACE_OP_DEDUPE_MS,
	WORKSPACE_OP_REPLY_FRAME,
	type WorkspaceOp,
	type WorkspaceOpReply,
	type WorkspaceOpResult,
} from "../../shared/workspace-op.js";
import { answerWorkspaceOp, type HandlerDeps } from "./handlers.js";
import { createOpDedupe, type OpDedupe } from "./opDedupe.js";

////////////////////////////////
//  Functions & Helpers

let deps: HandlerDeps | null = null;
let dedupe: OpDedupe | null = null;

/** Null disables the plane, which is how a session without the capability refuses every op. */
export function setWorkspacePlane(wired: HandlerDeps | null): void {
	deps = wired;
	dedupe = wired === null ? null : createOpDedupe({ now: Date.now, holdMs: WORKSPACE_OP_DEDUPE_MS });
}

export type ParsedWorkspaceOp =
	| { reqId: string; key: string; op: WorkspaceOp }
	/** Answered at once: an op this build cannot read would otherwise hold the Gateway to its timeout. */
	| { reqId: string; refused: string };

/** Null only when there is no request id to answer. */
export function parseWorkspaceOpRequest(msg: Record<string, unknown>): ParsedWorkspaceOp | null {
	const { reqId, key, op } = msg;
	if (typeof reqId !== "string") return null;
	const malformed = { reqId, refused: "this session's plugin cannot read that workspace op; update it" };
	if (typeof key !== "string" || typeof op !== "object" || op === null) return malformed;
	const { kind, path, symbolId, expectedSpanHash, text, mutation } = op as Record<string, unknown>;
	if (kind === "tree" || kind === "read" || kind === "outline" || kind === "fileState") {
		return typeof path === "string" ? { reqId, key, op: { kind, path } } : malformed;
	}
	if (kind === "symbolSource" || kind === "symbolKnowledge") {
		return typeof symbolId === "string" ? { reqId, key, op: { kind, symbolId } } : malformed;
	}
	if (kind === "saveSpan") {
		if (typeof symbolId !== "string" || typeof expectedSpanHash !== "string" || typeof text !== "string") {
			return malformed;
		}
		return { reqId, key, op: { kind, symbolId, expectedSpanHash, text } };
	}
	if (kind === "mutateFile") {
		// Unknown preconditions refuse.
		const parsed = FileMutationSchema.safeParse(mutation);
		return parsed.success ? { reqId, key, op: { kind, mutation: parsed.data } } : malformed;
	}
	return malformed;
}

export function refusedOnPlane(reqId: string, detail: string): WorkspaceOpReply {
	return { type: WORKSPACE_OP_REPLY_FRAME, reqId, result: { ok: false, failure: "refused", detail } };
}

/** Always answers. A thrown handler becomes a failure the phone can read, never a dropped request. */
export async function answerOnPlane(reqId: string, key: string, op: WorkspaceOp): Promise<WorkspaceOpReply> {
	const wired = deps;
	const pool = dedupe;
	const result: WorkspaceOpResult =
		wired === null || pool === null
			? { ok: false, failure: "refused", detail: "this session does not serve workspace reads" }
			: await pool
					.once(key, () => answerWorkspaceOp(wired, op))
					.catch((error: unknown) => ({
						ok: false as const,
						failure: "failed" as const,
						detail: error instanceof Error ? error.message : String(error),
					}));
	return { type: WORKSPACE_OP_REPLY_FRAME, reqId, result };
}
