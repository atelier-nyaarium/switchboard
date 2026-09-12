// The plugin's end of the workspace plane: one frame in, one frame out.
//
// Wired at startup so the socket handler needs no knowledge of where the root or the Lexicon session
// come from. Unwired, every op is refused rather than answered with a guess at the workspace.

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

/** Null for a frame this plane does not own, so the socket's other branches still see it. */
export function parseWorkspaceOpRequest(
	msg: Record<string, unknown>,
): { reqId: string; key: string; op: WorkspaceOp } | null {
	const { reqId, key, op } = msg;
	if (typeof reqId !== "string" || typeof key !== "string") return null;
	if (typeof op !== "object" || op === null) return null;
	const kind = (op as { kind?: unknown }).kind;
	const path = (op as { path?: unknown }).path;
	const symbolId = (op as { symbolId?: unknown }).symbolId;
	if (kind === "tree" || kind === "read" || kind === "outline") {
		return typeof path === "string" ? { reqId, key, op: { kind, path } } : null;
	}
	if (kind === "symbolSource" || kind === "symbolKnowledge") {
		return typeof symbolId === "string" ? { reqId, key, op: { kind, symbolId } } : null;
	}
	return null;
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
