// OpenCode's local server, as Switchboard drives it.

import crypto from "node:crypto";
import { z } from "zod";
import type { DerivedPresence, SessionPrompt } from "./schemasPresence.js";

////////////////////////////////
//  Constants

/** Names the file the launcher leaves the plugin. */
export const OPENCODE_SERVER_ENV = "SWITCHBOARD_OPENCODE_SERVER";

export const OPENCODE_API_USER = "opencode";

/** The MCP server's name in OpenCode's config. */
export const OPENCODE_MCP_NAME = "switchboard";

/** One per session, so a relaunch greets once. */
export const OPENCODE_GREETING_ID = "msg_sbgreeting";

/** Event types the plugin follows. */
export const OPENCODE_EVENT_TYPES = [
	"session.execution.started",
	"session.execution.succeeded",
	"session.execution.failed",
	"session.execution.interrupted",
	"session.step.started",
	"session.compaction.started",
	"session.compaction.ended",
	"session.compaction.failed",
	"permission.asked",
	"permission.replied",
] as const;

const LIMIT_ERRORS: ReadonlySet<string> = new Set([
	"provider.rate-limit",
	"provider.quota",
	"provider.go-limit",
	"provider.budget-limit",
	"provider.model-budget-limit",
	"provider.chatgpt-limit",
]);
// The free tier spent: connect a provider.
const LOGIN_ERRORS: ReadonlySet<string> = new Set(["provider.auth", "provider.free-limit"]);

////////////////////////////////
//  Interfaces & Types

/** What the launcher leaves the plugin. */
export const OpencodeServerFileSchema = z
	.object({
		url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/),
		password: z.string().min(16).max(256),
		sessionId: z.string().regex(/^ses_[0-9A-Za-z_]{1,64}$/),
		directory: z.string().min(1).max(4096),
	})
	.strict();

export type OpencodeServerFile = z.infer<typeof OpencodeServerFileSchema>;

export interface OpencodeError {
	type: string;
	message: string;
}

export interface OpencodePermission {
	id: string;
	/** The session that asked, a subagent's included. */
	sessionId: string;
	action: string;
	resources: string[];
}

/** What the plugin holds of one session's state. */
export interface OpencodeView {
	/** An execution is open. */
	executing: boolean;
	/** A step ran inside it. */
	working: boolean;
	compacting: boolean;
	/** The running compaction's message id, when known. */
	compactionId?: string;
	/** The last turn's failure, until another starts. */
	error?: OpencodeError;
	/** Oldest first. */
	permissions: OpencodePermission[];
}

export interface OpencodeEvent {
	type: string;
	data: Record<string, unknown>;
}

/** A snapshot's compactions: the one running and the newest finished. */
export interface CompactionRead {
	inProgress?: string;
	newestDone?: string;
}

/** One row of the message list. */
export interface OpencodeMessageRow {
	id: string;
	type: string;
	error?: OpencodeError;
}

////////////////////////////////
//  Functions & Helpers

export const EMPTY_VIEW: OpencodeView = { executing: false, working: false, compacting: false, permissions: [] };

export function opencodeAuth(password: string): string {
	return `Basic ${Buffer.from(`${OPENCODE_API_USER}:${password}`).toString("base64")}`;
}

/** `opencode --version` prints `opencode v2.2.5`. */
export function parseOpencodeVersion(text: string): string | undefined {
	return /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/m.exec(text.trim())?.[1];
}

/** The same id for every retry of one delivery. */
export function promptIdOf(deliveryId: string): string {
	return `msg_sb${crypto.createHash("sha256").update(deliveryId).digest("hex").slice(0, 40)}`;
}

export function locationQuery(directory: string): string {
	return `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
}

function errorOf(value: unknown): OpencodeError | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { type, message } = value as Record<string, unknown>;
	if (typeof type !== "string") return undefined;
	return { type, message: typeof message === "string" ? message : "" };
}

export function permissionOf(value: unknown): OpencodePermission | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { id, sessionID, action, resources } = value as Record<string, unknown>;
	if (typeof id !== "string" || typeof sessionID !== "string") return undefined;
	return {
		id,
		sessionId: sessionID,
		action: typeof action === "string" ? action : "use a tool",
		resources: Array.isArray(resources)
			? resources.filter((entry): entry is string => typeof entry === "string")
			: [],
	};
}

/** Returns the same view when the event changes nothing. */
export function applyOpencodeEvent(view: OpencodeView, event: OpencodeEvent, sessionId: string): OpencodeView {
	// A subagent asks under its own session.
	if (event.type === "permission.asked") {
		const asked = permissionOf(event.data);
		if (!asked || view.permissions.some((held) => held.id === asked.id)) return view;
		return { ...view, permissions: [...view.permissions, asked] };
	}
	if (event.type === "permission.replied") {
		const id = event.data.requestID;
		if (!view.permissions.some((held) => held.id === id)) return view;
		return { ...view, permissions: view.permissions.filter((held) => held.id !== id) };
	}
	if (event.data.sessionID !== sessionId) return view;
	switch (event.type) {
		// A repeated prompt id opens an execution with no step, so only a step is a turn.
		case "session.execution.started":
			return view.executing ? view : { ...view, executing: true };
		case "session.step.started": {
			if (view.working && !view.error) return view;
			const { error: _cleared, ...rest } = view;
			return { ...rest, executing: true, working: true };
		}
		case "session.execution.succeeded":
		case "session.execution.interrupted":
			return view.executing || view.working || view.compacting ? settle(view) : view;
		case "session.execution.failed": {
			const error = errorOf(event.data.error);
			return { ...settle(view), ...(error ? { error } : {}) };
		}
		case "session.compaction.started": {
			const id = typeof event.data.inputID === "string" ? event.data.inputID : undefined;
			if (view.compacting && view.compactionId === id) return view;
			const { compactionId: _prior, ...rest } = view;
			return { ...rest, compacting: true, ...(id ? { compactionId: id } : {}) };
		}
		case "session.compaction.ended":
		case "session.compaction.failed": {
			if (!view.compacting) return view;
			const { compactionId: _done, ...rest } = view;
			return { ...rest, compacting: false };
		}
		default:
			return view;
	}
}

/** An execution's end ends whatever ran inside it. */
function settle(view: OpencodeView): OpencodeView {
	const { compactionId: _done, ...rest } = view;
	return { ...rest, executing: false, working: false, compacting: false };
}

/** The newest compaction that did not fail, running or not. */
export function newestCompactionRow(rows: readonly OpencodeMessageRow[]): string | undefined {
	return rows.find((row) => row.type === "compaction" && !row.error)?.id;
}

/** Rows the model's work writes; an input row above a compaction does not end it. */
const OUTPUT_ROWS: ReadonlySet<string> = new Set(["assistant", "idle", "system", "compaction"]);

/** Rows newest first. A running session's newest compaction with no output above it is still going. */
export function compactionsOf(snapshot: { running: boolean; rows: readonly OpencodeMessageRow[] }): CompactionRead {
	const index = snapshot.rows.findIndex((row) => row.type === "compaction" && !row.error);
	if (index < 0) return {};
	const newest = snapshot.rows[index].id;
	const going = snapshot.running && !snapshot.rows.slice(0, index).some((row) => OUTPUT_ROWS.has(row.type));
	if (!going) return { newestDone: newest };
	const older = snapshot.rows.slice(index + 1).find((row) => row.type === "compaction" && !row.error)?.id;
	return { inProgress: newest, ...(older ? { newestDone: older } : {}) };
}

/** Switches written between a turn and its idle row. */
const SWITCH_ROWS: ReadonlySet<string> = new Set(["model-switched", "agent-switched", "location-switched"]);

/** The idle row ending the newest turn with a step; a stepless execution's idle settles nothing. */
function turnSettling(rows: readonly OpencodeMessageRow[]): OpencodeMessageRow | undefined {
	for (let index = 0; index < rows.length; index += 1) {
		if (rows[index].type !== "idle") continue;
		const before = rows.slice(index + 1).find((row) => !SWITCH_ROWS.has(row.type));
		if (before?.type === "assistant") return rows[index];
	}
	return undefined;
}

/** A view rebuilt from three reads. `rows` are newest first. */
export function viewFromSnapshot(snapshot: {
	running: boolean;
	permissions: readonly OpencodePermission[];
	rows: readonly OpencodeMessageRow[];
}): OpencodeView {
	const error = snapshot.running ? undefined : turnSettling(snapshot.rows)?.error;
	const { inProgress } = compactionsOf(snapshot);
	return {
		executing: snapshot.running,
		working: snapshot.running,
		compacting: inProgress !== undefined,
		...(inProgress ? { compactionId: inProgress } : {}),
		...(error ? { error } : {}),
		permissions: [...snapshot.permissions],
	};
}

function promptOf(permission: OpencodePermission): SessionPrompt {
	return {
		id: permission.id.slice(0, 64),
		title: `Permission required: ${permission.action}`.slice(0, 512),
		body: permission.resources.slice(0, 80).map((resource) => resource.slice(0, 512)),
	};
}

/** The fields the API yields; the Gateway derives the rest. */
export function derivedFromView(view: OpencodeView): DerivedPresence {
	const limit = view.error && LIMIT_ERRORS.has(view.error.type) ? view.error : undefined;
	const waiting = view.permissions[0];
	return {
		working: view.working,
		needsLogin: view.error !== undefined && LOGIN_ERRORS.has(view.error.type),
		limitBlocked: limit !== undefined,
		...(limit?.message ? { limitDetail: limit.message.slice(0, 512) } : {}),
		...(waiting ? { prompt: promptOf(waiting) } : {}),
		...(view.compacting ? { compacting: true } : {}),
	};
}
