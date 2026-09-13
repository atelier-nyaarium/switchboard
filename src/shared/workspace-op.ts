// What the Gateway may ask a session's plugin about its own workspace, and what comes back.
//
// Gateway to plugin over the bridge socket the plugin already dials out and holds. The ANSWER shapes
// live in `schemasWorkspace.ts`, since the phone reads them too and they must reach Kotlin; only the
// frames and the bounds are declared here, which never leave this pair of processes.
//
// Two writes: a span save, checked by Lexicon under its writer gate, and a file mutation, which is plain
// file work checked in the plugin.

import type { FileMutation, WorkspaceOpAnswer } from "./schemasWorkspace.js";

////////////////////////////////
//  Constants

export const WORKSPACE_OP_FRAME = "workspace_op";
export const WORKSPACE_OP_REPLY_FRAME = "workspace_op_reply";

/**
 * The phone's `ConsoleHttp.PINNED_READ_TIMEOUT_MS`. Every bound below sits inside it, or the phone gives
 * up while the work lands; `workspace-bounds.test.ts` pins both.
 */
export const CONSOLE_ANSWER_WAIT_MS = 35_000;

/** The phone to Router to Gateway hops a plane wait must leave room for. */
export const WORKSPACE_HOP_MARGIN_MS = 5_000;

/** A read is cheap; a save parses a candidate and reindexes, so it takes all the room there is. */
export type WorkspaceOpClass = "read" | "save";

export interface WorkspaceBounds {
	/** How long the Gateway waits for the plugin's reply. */
	planeWaitMs: number;
	/** The plugin's one deadline across its index calls, under the plane wait so it answers a cause. */
	handlerBudgetMs: number;
}

function boundsWithin(planeWaitMs: number): WorkspaceBounds {
	return { planeWaitMs, handlerBudgetMs: Math.floor(planeWaitMs * 0.75) };
}

export const WORKSPACE_BOUNDS: Record<WorkspaceOpClass, WorkspaceBounds> = {
	read: boundsWithin(20_000),
	save: boundsWithin(CONSOLE_ANSWER_WAIT_MS - WORKSPACE_HOP_MARGIN_MS),
};

/** Holds past any sane retry. */
export const WORKSPACE_OP_DEDUPE_MS = 120_000;

/** Under the 8 MB relay cap, leaving envelope room. */
export const MAX_WORKSPACE_OP_BYTES = 4_000_000;

/** Paged, never truncated. */
export const MAX_TREE_ENTRIES = 1_000;

/** A larger file opens read-only, since a phone text field cannot hold one. */
export const MAX_RAW_EDIT_BYTES = 256_000;

/** Larger files answer no hash, since hashing one outlasts the plane. */
export const MAX_HASHED_BYTES = 256_000_000;

////////////////////////////////
//  Interfaces & Types

export type WorkspaceOp =
	| { kind: "tree"; path: string }
	| { kind: "read"; path: string }
	| { kind: "fileState"; path: string }
	| { kind: "outline"; path: string }
	| { kind: "symbolSource"; symbolId: string }
	| { kind: "symbolKnowledge"; symbolId: string }
	| { kind: "saveSpan"; symbolId: string; expectedSpanHash: string; text: string }
	| { kind: "mutateFile"; mutation: FileMutation };

export function boundsOf(op: WorkspaceOp): WorkspaceBounds {
	return WORKSPACE_BOUNDS[unknownAnswerOf(op, "") === null ? "read" : "save"];
}

/** Writes may land; the phone rereads. */
function unknownAnswerOf(op: WorkspaceOp, reason: string): WorkspaceOpAnswer | null {
	switch (op.kind) {
		case "saveSpan":
			return { kind: "saveSpan", symbolId: op.symbolId, outcome: "unknown", reason };
		case "mutateFile":
			return { kind: "mutateFile", path: op.mutation.path, outcome: "unknown", reason };
		default:
			return null;
	}
}

/**
 * A plane result as the phone reads it. A failure rides the thrown message, which is how the phone
 * tells refused from failed. Only a refusal is known to have written nothing, so any other failure of a
 * write answers `unknown`, which the phone settles by reading back.
 */
export function answerForConsole(op: WorkspaceOp, result: WorkspaceOpResult): WorkspaceOpAnswer {
	if (result.ok) return result.answer;
	const unknown =
		result.failure === "refused" ? null : unknownAnswerOf(op, `${result.failure}: ${result.detail}`.slice(0, 2048));
	if (unknown !== null) return unknown;
	throw new Error(`${result.failure}: ${result.detail}`);
}

export type {
	FileDestination,
	FileMutation,
	FileMutationAnswer,
	FileStateAnswer,
	KnowledgeAnswer,
	OutlineAnswer,
	OutlineSymbol,
	ReadAnswer,
	SaveSpanAnswer,
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
