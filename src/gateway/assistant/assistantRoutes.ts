// The assistant session's own doors. Every one checks the caller's token resolves to its record.

import { z } from "zod";
import { type Ambient, withinMs } from "../../shared/ambient.js";
import { ASSISTANT_HOLD_PATH, type HoldAnswer, HoldAnswerSchema } from "../../shared/assistant-hold.js";
import { ASSISTANT_TEAM } from "../../shared/assistant-session.js";
import { CONSOLE_ANSWER_WAIT_MS, CONSOLE_HOP_MARGIN_MS } from "../../shared/console-protocol.js";
import {
	ACTION_FRONT_LEGACY_ROUTES,
	ACTION_FRONT_ROUTES,
	type ActionListAnswer,
	type ActionListing,
	ActionRunRequestSchema,
	type ActionRunResult,
	ActionRunResultSchema,
	actionRef,
	type DeviceRunRequest,
	runResultOfWatcher,
} from "../../shared/schemasActionFront.js";
import {
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
	type PhoneCapabilityRequest,
	PhoneCapabilityRequestSchema,
	type PhoneCapabilityResult,
} from "../../shared/schemasPhoneCapabilities.js";
import { ASSISTANT_COMMANDS } from "../../shared/session-commands.js";
import type { GuardReply, SendCaller, SendGuard } from "./sendGuard.js";
import { ASSISTANT_WAITS } from "./waits.js";

const INBOX = ASSISTANT_COMMANDS.inbox;
const PHONE_ROUTE_WAIT_MS = ASSISTANT_WAITS.phone * 2 + CONSOLE_ANSWER_WAIT_MS + CONSOLE_HOP_MARGIN_MS;
const WATCHER_ROUTE_WAIT_MS = ASSISTANT_WAITS.action + CONSOLE_HOP_MARGIN_MS;
const LATE = "the Gateway did not answer in time; read the inbox before sending it again";

export type Handler = (req: Request, body: unknown) => Promise<Response>;

export interface AssistantRoutesDeps {
	caller: (req: Request) => "assistant" | "not_assistant" | "unauthenticated";
	list: (scope: InboxScope, page: string | undefined) => Promise<InboxList[]>;
	listActions: () => ActionListing[];
	dispatch: (request: AssistantActionRequest) => Promise<AssistantActionResult>;
	phone: (request: PhoneCapabilityRequest) => Promise<PhoneCapabilityResult>;
	device: (request: DeviceRunRequest) => Promise<ActionRunResult>;
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

	const actions: Handler = async (req) => {
		const caller = deps.caller(req);
		if (caller !== "assistant") return json({ kind: caller } satisfies ActionListAnswer, 200);
		return json({ kind: "listed", actions: deps.listActions() } satisfies ActionListAnswer, 200);
	};

	const run: Handler = async (req, body) => {
		const parsed = ActionRunRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "not an action run" }, 400);
		const caller = deps.caller(req);
		if (caller !== "assistant") return json({ kind: caller } satisfies ActionRunResult, 200);
		if ("device" in parsed.data) return json(await runDevice(parsed.data), 200);
		const { callId, params } = parsed.data;
		const ref = actionRef(parsed.data.id);
		if (ref.family === "watcher") return json(await runWatcher({ action: ref.key, callId, params }), 200);
		return json(await runPhone({ key: ref.key, callId, params }), 200);
	};

	const runDevice = async (request: DeviceRunRequest): Promise<ActionRunResult> => {
		const result = await withinMs(deps.ambient, deps.device(request), PHONE_ROUTE_WAIT_MS);
		return result ?? { kind: "unavailable", reason: "timeout" };
	};

	const runWatcher = async (request: AssistantActionRequest): Promise<ActionRunResult> => {
		const result = await withinMs(deps.ambient, deps.dispatch(request), WATCHER_ROUTE_WAIT_MS);
		return result ? runResultOfWatcher(result) : { kind: "refused", reason: LATE };
	};

	const runPhone = async (request: PhoneCapabilityRequest): Promise<ActionRunResult> => {
		const result = await withinMs(deps.ambient, deps.phone(request), PHONE_ROUTE_WAIT_MS);
		return ActionRunResultSchema.parse(result ?? { kind: "unavailable", reason: "timeout" });
	};

	// Remove after 2026-11-16: an older plugin's doors.
	const legacyAction: Handler = async (req, body) => {
		const parsed = AssistantActionRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "not an action request" }, 400);
		const caller = deps.caller(req);
		if (caller !== "assistant") return json({ kind: caller } satisfies AssistantActionResult, 200);
		const result = await runWatcher(parsed.data);
		return json(
			result.kind === "ok" ? { kind: "ran", answer: result.answer, recorded: result.recorded } : result,
			200,
		);
	};

	const legacyPhone: Handler = async (req, body) => {
		const parsed = PhoneCapabilityRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "not a phone capability request" }, 400);
		const caller = deps.caller(req);
		if (caller !== "assistant") return json({ kind: caller }, 200);
		return json(await runPhone(parsed.data), 200);
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

	return new Map<string, Handler>([
		[INBOX.path, list],
		[ACTION_FRONT_ROUTES.list, actions],
		[ACTION_FRONT_ROUTES.run, run],
		[ACTION_FRONT_LEGACY_ROUTES.action, legacyAction],
		[ACTION_FRONT_LEGACY_ROUTES.phone, legacyPhone],
		[ASSISTANT_HOLD_PATH, hold],
		[ASSISTANT_SEND_ROUTES.send, send],
		[ASSISTANT_SEND_ROUTES.collect, collect],
		[ASSISTANT_SEND_ROUTES.withdraw, withdraw],
	]);
}
