// What the Gateway may ask a session's plugin about its own workspace, and what comes back.
//
// Gateway to plugin over the bridge socket the plugin already dials out and holds. The ANSWER shapes
// live in `schemasWorkspace.ts`, since the phone reads them too and they must reach Kotlin; only the
// frames and the bounds are declared here, which never leave this pair of processes.
//
// One write: a span save, whose precondition is the span hash Lexicon checks under its writer gate.

import type { WorkspaceOpAnswer } from "./schemasWorkspace.js";

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

////////////////////////////////
//  Interfaces & Types

export type WorkspaceOp =
	| { kind: "tree"; path: string }
	| { kind: "read"; path: string }
	| { kind: "outline"; path: string }
	| { kind: "symbolSource"; symbolId: string }
	| { kind: "symbolKnowledge"; symbolId: string }
	| { kind: "saveSpan"; symbolId: string; expectedSpanHash: string; text: string };

export function boundsOf(op: WorkspaceOp): WorkspaceBounds {
	return WORKSPACE_BOUNDS[op.kind === "saveSpan" ? "save" : "read"];
}

/**
 * A plane result as the phone reads it. A failure rides the thrown message, which is how the phone
 * tells refused from failed. Only a refusal is known to have written nothing, so any other failure of a
 * save answers `unknown`, which the phone settles by reading the span back.
 */
export function answerForConsole(op: WorkspaceOp, result: WorkspaceOpResult): WorkspaceOpAnswer {
	if (result.ok) return result.answer;
	if (op.kind === "saveSpan" && result.failure !== "refused") {
		const reason = `${result.failure}: ${result.detail}`.slice(0, 2048);
		return { kind: "saveSpan", symbolId: op.symbolId, outcome: "unknown", reason };
	}
	throw new Error(`${result.failure}: ${result.detail}`);
}

export type {
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
