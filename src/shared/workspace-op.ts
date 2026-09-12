// What the Gateway may ask a session's plugin about its own workspace, and what comes back.
//
// Gateway to plugin over the bridge socket the plugin already dials out and holds. The ANSWER shapes
// live in `schemasWorkspace.ts`, since the phone reads them too and they must reach Kotlin; only the
// frames and the bounds are declared here, which never leave this pair of processes.
//
// READS ONLY. A mutation needs the preconditions this plane does not yet carry.

////////////////////////////////
//  Constants

export const WORKSPACE_OP_FRAME = "workspace_op";
export const WORKSPACE_OP_REPLY_FRAME = "workspace_op_reply";

export const WORKSPACE_OP_TIMEOUT_MS = 20_000;

/** Holds past any sane retry. */
export const WORKSPACE_OP_DEDUPE_MS = 120_000;

/** Under the 8 MB relay cap, leaving envelope room. */
export const MAX_WORKSPACE_OP_BYTES = 4_000_000;

/** Paged, never truncated. */
export const MAX_TREE_ENTRIES = 1_000;

////////////////////////////////
//  Interfaces & Types

export type WorkspaceOp =
	| { kind: "tree"; path: string }
	| { kind: "read"; path: string }
	| { kind: "outline"; path: string }
	| { kind: "symbolSource"; symbolId: string }
	| { kind: "symbolKnowledge"; symbolId: string };

export type {
	KnowledgeAnswer,
	OutlineAnswer,
	OutlineSymbol,
	ReadAnswer,
	SymbolSourceAnswer,
	TreeAnswer,
	TreeEntry,
	WorkspaceOpAnswer,
} from "./schemasWorkspace.js";

/**
 * `refused` is the plugin answering properly; `failed` is the plane itself. The phone shows the first
 * and retries the second, so collapsing them would make a withheld file look like a dropped socket.
 */
export type WorkspaceOpFailure = "refused" | "failed" | "timeout" | "disconnected" | "stale" | "too_large";

export type WorkspaceOpResult =
	| { ok: true; answer: import("./schemasWorkspace.js").WorkspaceOpAnswer }
	| { ok: false; failure: WorkspaceOpFailure; detail: string };

/** `key` is the idempotency key; a replay of it answers the first result rather than acting again. */
export interface WorkspaceOpRequest {
	type: typeof WORKSPACE_OP_FRAME;
	reqId: string;
	key: string;
	op: WorkspaceOp;
}

export interface WorkspaceOpReply {
	type: typeof WORKSPACE_OP_REPLY_FRAME;
	reqId: string;
	result: WorkspaceOpResult;
}
