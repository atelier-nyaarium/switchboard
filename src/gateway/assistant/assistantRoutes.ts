// The assistant session's own doors. Every one checks the caller's token resolves to its record.

import { z } from "zod";
import {
	ASSISTANT_INBOX_CONFIRM_PATH,
	type InboxConfirmAnswer,
	InboxConfirmRequestSchema,
	type InboxEventWire,
	type InboxFlushAnswer,
} from "../../shared/schemasAssistantInbox.js";
import { ASSISTANT_COMMANDS } from "../../shared/session-commands.js";

const INBOX = ASSISTANT_COMMANDS.inbox;

export type Handler = (req: Request, body: unknown) => Promise<Response>;

export interface AssistantRoutesDeps {
	caller: (req: Request) => "assistant" | "not_assistant" | "unauthenticated";
	flush: (watcherIds: readonly string[] | undefined) => Promise<{
		events: InboxEventWire[];
		boundaries: Record<string, number>;
		evicted: Record<string, number>;
	}>;
	/** False when the write did not land. */
	confirm: (boundaries: Record<string, number>) => Promise<boolean>;
}

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createAssistantRoutes(deps: AssistantRoutesDeps): Map<string, Handler> {
	const flush: Handler = async (req, body) => {
		const parsed = z.object(INBOX.request).safeParse(body);
		if (!parsed.success) return json({ error: "watchers must be a list of watcher ids" }, 400);
		const caller = deps.caller(req);
		if (caller !== "assistant") return json({ kind: caller } satisfies InboxFlushAnswer, 200);
		const read = await deps.flush(parsed.data.watchers);
		return json({ kind: "events", ...read } satisfies InboxFlushAnswer, 200);
	};

	const confirm: Handler = async (req, body) => {
		const parsed = InboxConfirmRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "boundaries are required" }, 400);
		const caller = deps.caller(req);
		if (caller !== "assistant") return json({ kind: caller } satisfies InboxConfirmAnswer, 200);
		const landed = await deps.confirm(parsed.data.boundaries);
		return json({ kind: landed ? "confirmed" : "unsaved" } satisfies InboxConfirmAnswer, 200);
	};

	return new Map<string, Handler>([
		[INBOX.path, flush],
		[ASSISTANT_INBOX_CONFIRM_PATH, confirm],
	]);
}
