// The assistant session's own doors. Every one checks the caller's token resolves to its record.

import { z } from "zod";
import type { InboxList, InboxListAnswer, InboxScope } from "../../shared/schemasAssistantInbox.js";
import { ASSISTANT_COMMANDS } from "../../shared/session-commands.js";

const INBOX = ASSISTANT_COMMANDS.inbox;

export type Handler = (req: Request, body: unknown) => Promise<Response>;

export interface AssistantRoutesDeps {
	caller: (req: Request) => "assistant" | "not_assistant" | "unauthenticated";
	list: (scope: InboxScope, page: string | undefined) => Promise<InboxList[]>;
}

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createAssistantRoutes(deps: AssistantRoutesDeps): Map<string, Handler> {
	const list: Handler = async (req, body) => {
		const parsed = z.object(INBOX.request).safeParse(body);
		if (!parsed.success) return json({ error: "scope must be new or all" }, 400);
		const caller = deps.caller(req);
		if (caller !== "assistant") return json({ kind: caller } satisfies InboxListAnswer, 200);
		const lists = await deps.list(parsed.data.scope, parsed.data.page);
		return json({ kind: "listed", lists } satisfies InboxListAnswer, 200);
	};

	return new Map<string, Handler>([[INBOX.path, list]]);
}
