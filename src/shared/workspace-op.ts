// What the Gateway may ask a session's plugin about its own workspace, and what comes back.
//
// Gateway to plugin over the bridge socket the plugin already dials out and holds. TS on both ends,
// so these are interfaces rather than Zod: nothing here crosses to Kotlin.
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

export interface TreeEntry {
	name: string;
	directory: boolean;
	/** A directory carries a child count instead. */
	bytes?: number;
	children?: number;
}

export interface TreeAnswer {
	kind: "tree";
	/** Empty is the workspace root. */
	path: string;
	entries: TreeEntry[];
	/** The phone says so rather than implying the end. */
	truncated: boolean;
}

export interface ReadAnswer {
	kind: "read";
	path: string;
	text: string;
	lines: number;
}

export interface OutlineSymbol {
	symbolId: string;
	name: string;
	symbolKind: string;
	/** Absent at the top level; the phone nests by it. */
	containerId?: string;
	signature?: string;
	startLine?: number;
}

export interface OutlineAnswer {
	kind: "outline";
	path: string;
	symbols: OutlineSymbol[];
}

export interface SymbolSourceAnswer {
	kind: "symbolSource";
	symbolId: string;
	module: string;
	name: string;
	text: string;
	startLine: number;
	endLine: number;
	/** Of the SPAN, not the file, so an edit elsewhere does not invalidate a window. */
	spanHash: string;
}

export interface KnowledgeAnswer {
	kind: "symbolKnowledge";
	symbolId: string;
	/** Opaque to the phone. */
	text: string;
}

export type WorkspaceOpAnswer = TreeAnswer | ReadAnswer | OutlineAnswer | SymbolSourceAnswer | KnowledgeAnswer;

/**
 * `refused` is the plugin answering properly; `failed` is the plane itself. The phone shows the first
 * and retries the second, so collapsing them would make a withheld file look like a dropped socket.
 */
export type WorkspaceOpFailure = "refused" | "failed" | "timeout" | "disconnected" | "stale" | "too_large";

export type WorkspaceOpResult =
	| { ok: true; answer: WorkspaceOpAnswer }
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
