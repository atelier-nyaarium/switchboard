// The assistant session's own doors. Every one checks the caller's token resolves to its record.

import { z } from "zod";
import { type Ambient, withinMs } from "../../shared/ambient.js";
import { ASSISTANT_HOLD_PATH, type HoldAnswer, HoldAnswerSchema } from "../../shared/assistant-hold.js";
import { ASSISTANT_TEAM } from "../../shared/assistant-session.js";
import { CONSOLE_ANSWER_WAIT_MS, CONSOLE_HOP_MARGIN_MS } from "../../shared/console-protocol.js";
import {
	ASSISTANT_ACTION_PATH,
	type AssistantActionRequest,
	AssistantActionRequestSchema,
	type AssistantActionResult,
} from "../../shared/schemasAssistantActions.js";
import type { InboxList, InboxListAnswer, InboxScope } from "../../shared/schemasAssistantInbox.js";
import {
	ASSISTANT_SEND_ROUTES,
	AssistantSendBodySchema,
	AssistantSendCollectSchema,
	AssistantSendWithdrawSchema,
} from "../../shared/schemasAssistantSend.js";
import {
	PHONE_CAPABILITY_PATH,
	PhoneCapabilityRequestSchema,
	type PhoneCapabilityResult,
	PhoneCapabilityResultSchema,
} from "../../shared/schemasPhoneCapabilities.js";
import { ASSISTANT_COMMANDS } from "../../shared/session-commands.js";
import type { GuardReply, SendCaller, SendGuard } from "./sendGuard.js";
import { ASSISTANT_WAITS } from "./waits.js";

const INBOX = ASSISTANT_COMMANDS.inbox;
const PHONE_ROUTE_WAIT_MS = ASSISTANT_WAITS.phone * 2 + CONSOLE_ANSWER_WAIT_MS + CONSOLE_HOP_MARGIN_MS;

export type Handler = (req: Request, body: unknown) => Promise<Response>;

export interface AssistantRoutesDeps {
	caller: (req: Request) => "assistant" | "not_assistant" | "unauthenticated";
	list: (scope: InboxScope, page: string | undefined) => Promise<InboxList[]>;
	dispatch: (request: AssistantActionRequest) => Promise<AssistantActionResult>;
	phone: (request: z.infer<typeof PhoneCapabilityRequestSchema>) => Promise<PhoneCapabilityResult>;
	/** The assistant holding that conversation. */
	sender: (req: Request, conversationId: string) => SendCaller | null;
	guard: Pick<SendGuard, "send" | "collect" | "withdraw">;
	hold: () => HoldAnswer;
	ambient: Pick<Ambient, "setTimer" | "clearTimer">;
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

	const action: Handler = async (req, body) => {
		const parsed = AssistantActionRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "not an action request" }, 400);
		const caller = deps.caller(req);
		if (caller !== "assistant") return json({ kind: caller } satisfies AssistantActionResult, 200);
		return json(await deps.dispatch(parsed.data), 200);
	};

	const replied = (reply: GuardReply): Response => json(reply.body, reply.status);
	const notAssistant = (): Response => json({ error: "only the assistant sends here" }, 403);

	const send: Handler = async (req, body) => {
		const parsed = AssistantSendBodySchema.safeParse(body);
		if (!parsed.success) return json({ error: `invalid send: ${parsed.error.message}` }, 400);
		const sender = deps.sender(req, parsed.data.fromConversationId);
		if (!sender) return notAssistant();
		return replied(await deps.guard.send(sender, parsed.data, req.signal));
	};

	const collect: Handler = async (req, body) => {
		const parsed = AssistantSendCollectSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid collect" }, 400);
		const caller = deps.caller(req);
		if (caller !== "assistant") return notAssistant();
		return replied(await deps.guard.collect(ASSISTANT_TEAM, parsed.data.requestId, parsed.data.waitMs, req.signal));
	};

	const withdraw: Handler = async (req, body) => {
		const parsed = AssistantSendWithdrawSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid withdraw" }, 400);
		if (deps.caller(req) !== "assistant") return notAssistant();
		return replied(deps.guard.withdraw(ASSISTANT_TEAM, parsed.data.requestId));
	};

	const hold: Handler = async (req) => {
		const caller = deps.caller(req);
		const answer: HoldAnswer = caller === "assistant" ? deps.hold() : { kind: caller };
		return json(HoldAnswerSchema.parse(answer), 200);
	};

	const phone: Handler = async (req, body) => {
		const parsed = PhoneCapabilityRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "not a phone capability request" }, 400);
		const caller = deps.caller(req);
		if (caller !== "assistant") return json({ kind: caller }, 200);
		const result = await withinMs(deps.ambient, deps.phone(parsed.data), PHONE_ROUTE_WAIT_MS);
		return json(PhoneCapabilityResultSchema.parse(result ?? { kind: "unavailable", reason: "timeout" }), 200);
	};

	return new Map<string, Handler>([
		[INBOX.path, list],
		[ASSISTANT_ACTION_PATH, action],
		[ASSISTANT_HOLD_PATH, hold],
		[PHONE_CAPABILITY_PATH, phone],
		[ASSISTANT_SEND_ROUTES.send, send],
		[ASSISTANT_SEND_ROUTES.collect, collect],
		[ASSISTANT_SEND_ROUTES.withdraw, withdraw],
	]);
}
