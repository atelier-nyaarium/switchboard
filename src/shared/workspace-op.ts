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

/** Long enough for a cold Lexicon daemon to answer, short enough that the phone is not left hanging. */
export const WORKSPACE_OP_TIMEOUT_MS = 20_000;

/** A replayed key answers the first result instead of acting twice. Holds past any sane retry. */
export const WORKSPACE_OP_DEDUPE_MS = 120_000;

/** Bounds what one answer may carry, under the 8 MB relay frame cap with room for the envelope. */
export const MAX_WORKSPACE_OP_BYTES = 4_000_000;

/** A tree answer is paged rather than truncated, so a huge directory is still navigable. */
export const MAX_TREE_ENTRIES = 1_000;

////////////////////////////////
//  Interfaces & Types

/** Every op names a workspace-relative path. The plugin decides what that means; the phone never does. */
export type WorkspaceOp =
	| { kind: "tree"; path: string }
	| { kind: "read"; path: string }
	| { kind: "outline"; path: string }
	| { kind: "symbolSource"; symbolId: string }
	| { kind: "symbolKnowledge"; symbolId: string };

export interface TreeEntry {
	name: string;
	directory: boolean;
	/** Absent for a directory, where a child count is what the phone shows instead. */
	bytes?: number;
	children?: number;
}

export interface TreeAnswer {
	kind: "tree";
	/** Workspace-relative, empty at the root, so the phone renders a path it did not compose. */
	path: string;
	entries: TreeEntry[];
	/** True when `MAX_TREE_ENTRIES` cut the list, so the phone says so rather than implying the end. */
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
	/** Absent at the top level. The phone nests by this rather than by indentation in a string. */
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
	/** Rendered by Lexicon. The phone displays it and parses nothing out of it. */
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
