import crypto from "node:crypto";
import { basename } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import WebSocket from "ws";
import packageJson from "../../../package.json";
import { mintNoAckSessionId } from "../../shared/agent-notice.js";
import { processAmbient } from "../../shared/ambient.js";
import { isGatewayLongWaitRoute, resendsAfterFailure } from "../../shared/gateway-long-waits.js";
import { createOpDedupe } from "../../shared/op-dedupe.js";
import { createReconnector } from "../../shared/reconnect.js";
import { OP_LEDGER_PROTOCOL } from "../../shared/schemas.js";
import type { DerivedPresence } from "../../shared/schemasPresence.js";
import {
	parseSessionControlOp,
	SESSION_CONTROL_DEDUPE_MS,
	SESSION_CONTROL_FRAME,
	SESSION_CONTROL_REPLY_FRAME,
	SESSION_PRESENCE_FRAME,
	type SessionControlReply,
	type SessionControlResult,
} from "../../shared/session-control.js";
import {
	type ChannelPushPayload,
	type ConnectionMode,
	MAX_PENDING_DELIVERIES,
	type ResponsePushPayload,
	type RidingAwareness,
} from "../../shared/types.js";
import { WORKSPACE_OP_FRAME } from "../../shared/workspace-op.js";
import { emitChannelNotification, emitResponseNotification, renderChannelTag } from "../channel/channelNotify.js";
import type { ApiSession } from "../opencode/session.js";
import { OTHER_AGENT, type PluginProfile } from "../sessionCli.js";
import { answerOnPlane, parseWorkspaceOpRequest, refusedOnPlane } from "../workspace/plane.js";
import { createChannelPushDelivery } from "./channelPushDelivery.js";

export interface BridgeConfig {
	routerUrl: string;
	projectName: string;
	profile: PluginProfile;
}

interface RouterPostOptions {
	retries?: number;
	retryDelayMs?: number;
}

const MAX_ROUTER_ERROR_BODY = 4096;

export class RouterHttpError extends Error {
	constructor(
		readonly status: number,
		body: string,
	) {
		super(`HTTP ${status}: ${body.slice(0, MAX_ROUTER_ERROR_BODY)}`);
	}
}

async function readResponseBody(res: Response, maxBytes: number): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytesRead = 0;
	try {
		while (bytesRead < maxBytes) {
			const { done, value } = await reader.read();
			if (done || !value) break;
			const chunk = value.subarray(0, maxBytes - bytesRead);
			chunks.push(chunk);
			bytesRead += chunk.byteLength;
			if (chunk.byteLength < value.byteLength) await reader.cancel();
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(bytesRead);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

let ROUTER_URL = "";
let PROJECT_NAME = "";
let cli: PluginProfile = OTHER_AGENT;

const CONVERSATION_ID: string = crypto.randomUUID();

let routerWs: WebSocket | null = null;
let suppressReconnect = false;
const reconnector = createReconnector(() => connectToRouter());

let channelServer: Server | null = null;

/** Set when driven over the CLI's own API. */
let apiSession: ApiSession | null = null;
const controlDedupe = createOpDedupe<SessionControlResult>({ now: Date.now, holdMs: SESSION_CONTROL_DEDUPE_MS });

export function setApiSession(session: ApiSession | null): void {
	apiSession = session;
}

/** What the Gateway last took, and whether a compaction ran while it could not hear. */
let presenceSent: DerivedPresence | undefined;
let compactedUnheard = false;

/** A plugin-read session's state, for the Gateway. A bare frame clears. */
export function reportSessionPresence(derived: DerivedPresence | undefined): void {
	if (routerWs?.readyState !== WebSocket.OPEN) {
		if (derived?.compacting) compactedUnheard = true;
		return;
	}
	routerWs.send(JSON.stringify({ type: SESSION_PRESENCE_FRAME, ...derived }));
	presenceSent = derived;
}

/** A closed socket clears the Gateway's report and compaction. */
function resendPresence(): void {
	const held = apiSession?.current();
	const owed = compactedUnheard && !held?.compacting;
	compactedUnheard = false;
	if (owed && held) reportSessionPresence({ ...held, compacting: true });
	if (held) reportSessionPresence(held);
}

const TYPED_RETRY_MS = 1000;
const TYPED_BACKOFF_MAX_MS = 30_000;
const TYPED_GIVE_UP_MS = 15 * 60_000;
let queuedDeliveryTail = Promise.resolve();

function serializeQueuedDelivery<T>(work: () => Promise<T>): Promise<T> {
	const run = queuedDeliveryTail.then(work);
	queuedDeliveryTail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** A daemon or Gateway that is down may come back; anything else answered is final. */
const typingRetries = (err: unknown): boolean =>
	!(err instanceof RouterHttpError) || err.status === 503 || err.status === 504;

/**
 * Types `payload` once its pane is idle. `key` makes a retry after a lost answer replay rather
 * than type twice. A pane busy for a long turn is waited out; a daemon down past the deadline
 * gives up, leaving the row held for the next connection.
 */
async function emitTypedChannelTag(payload: ChannelPushPayload | ResponsePushPayload, key: string): Promise<void> {
	const text = await renderChannelTag(payload);
	let retries = 0;
	let failures = 0;
	let failingSince: number | null = null;
	for (;;) {
		let result: { typed?: unknown; reason?: unknown };
		try {
			result = (await routerPost("/session/type", { text, key }, { retries: 0 })) as typeof result;
		} catch (err) {
			failingSince ??= Date.now();
			if (!typingRetries(err) || Date.now() - failingSince > TYPED_GIVE_UP_MS) throw err;
			const wait = Math.min(TYPED_RETRY_MS * 2 ** ++failures, TYPED_BACKOFF_MAX_MS);
			console.error(`[channel] typed delivery failed (${(err as Error).message}), retry in ${wait}ms`);
			await new Promise((resolve) => setTimeout(resolve, wait));
			continue;
		}
		failures = 0;
		failingSince = null;
		if (result?.typed === true) return;
		if (result?.typed !== false || result.reason !== "busy") {
			throw new Error("typed delivery was refused");
		}
		retries++;
		console.error(`[channel] pane busy, retry ${retries} in ${TYPED_RETRY_MS}ms`);
		await new Promise((resolve) => setTimeout(resolve, TYPED_RETRY_MS));
	}
}

/** How a pushed row enters the session. */
interface Transport {
	/** Each waits for the one before. */
	queued: boolean;
	ready(): boolean;
	push(push: ChannelPushPayload): Promise<void>;
	response(push: ResponsePushPayload): Promise<void>;
}

const TRANSPORTS: Record<PluginProfile["delivery"], Transport> = {
	channel: {
		queued: false,
		ready: () => channelServer !== null,
		push: (push) =>
			channelServer
				? emitChannelNotification(channelServer, push)
				: Promise.reject(new Error("no channel server")),
		response: (push) =>
			channelServer
				? emitResponseNotification(channelServer, push)
				: Promise.reject(new Error("no channel server")),
	},
	typed: {
		queued: true,
		ready: () => true,
		push: (push) =>
			emitTypedChannelTag(push, typeof push.delivery_id === "string" ? push.delivery_id : crypto.randomUUID()),
		response: (push) => emitTypedChannelTag(push, crypto.randomUUID()),
	},
	api: {
		queued: true,
		ready: () => apiSession !== null,
		push: (push) => apiSession?.deliver(push) ?? Promise.reject(new Error("no API session")),
		response: (push) => apiSession?.respond(push) ?? Promise.reject(new Error("no API session")),
	},
	none: {
		queued: false,
		ready: () => false,
		push: () => Promise.reject(new Error("no channel server")),
		response: () => Promise.reject(new Error("no channel server")),
	},
};

function transport(): Transport {
	return TRANSPORTS[cli.delivery];
}

/** Dedupe ids across reconnects. */
const deliverChannelPush = createChannelPushDelivery({
	emit: (push) => transport().push(push),
	ack: (deliveryId) => routerWs?.send(JSON.stringify({ type: "channel_delivery_ack", delivery_id: deliveryId })),
	maxRemembered: MAX_PENDING_DELIVERIES,
});

/** Confirm only received ids. */
function createHandshakeRoleCache() {
	let role: boolean | null = null;
	let lastReceivedId: string | null = null;
	const receivedIds = new Set<string>();
	return {
		noteReceived(hsSessionId: string): void {
			receivedIds.add(hsSessionId);
			lastReceivedId = hsSessionId;
		},
		confirm(hsSessionId: string, value: boolean): boolean {
			if (!receivedIds.has(hsSessionId)) return false;
			role = value;
			return true;
		},
		get(): boolean | null {
			return role;
		},
		/** Pending handshake id. */
		unanswered(): string | null {
			return role === null ? lastReceivedId : null;
		},
		/** Clear the stale pending id. */
		resetUnanswered(): void {
			lastReceivedId = null;
		},
	};
}
const handshakeRole = createHandshakeRoleCache();

export function initBridge(config: BridgeConfig): void {
	ROUTER_URL = config.routerUrl;
	PROJECT_NAME = config.projectName;
	cli = config.profile;
}

export function setChannelServer(server: Server): void {
	channelServer = server;
}

/** Pushes local awareness notices. */
export async function emitLocalAwareness(
	awareness: RidingAwareness,
	stillWanted: () => boolean = () => true,
): Promise<boolean> {
	const push: ChannelPushPayload = {
		type: "channel_push",
		from: awareness.from,
		body: "",
		awareness,
		session_id: mintNoAckSessionId(processAmbient()),
		no_ack: true,
		act: awareness.act,
	};
	const via = transport();
	if (!via.ready()) return false;
	if (!via.queued) {
		await via.push(push);
		return true;
	}
	// Rechecked once the queue reaches it.
	return serializeQueuedDelivery(async () => {
		if (!stillWanted()) return false;
		await via.push(push);
		return true;
	});
}

/** Unknown ids are no-ops. */
export function confirmHandshakeRole(hsSessionId: string, value: boolean): boolean {
	return handshakeRole.confirm(hsSessionId, value);
}

/** Return the pending handshake id. */
export function unansweredHandshakeId(): string | null {
	return handshakeRole.unanswered();
}

export function bridgeProjectName(): string {
	return PROJECT_NAME;
}

export function bridgeConversationId(): string {
	return CONVERSATION_ID;
}

/** Read the token per call. */
function sessionTokenHeader(): Record<string, string> {
	const token = process.env.SWITCHBOARD_SESSION_TOKEN;
	return token ? { "x-session-token": token } : {};
}

/** Read string and object errors. */
export function routerErrorText(failure: unknown): string | undefined {
	if (typeof failure === "string") return failure;
	const message = (failure as { message?: unknown } | null)?.message;
	return typeof message === "string" ? message : undefined;
}

export async function routerPost(
	path: string,
	body: unknown,
	{ retries = 4, retryDelayMs = 1500 }: RouterPostOptions = {},
): Promise<unknown> {
	return routerRequest(
		`${ROUTER_URL}${path}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", ...sessionTokenHeader() },
			body: JSON.stringify(body),
		},
		retries,
		retryDelayMs,
		"routerPost",
	);
}

async function routerRequest(
	url: string,
	init: RequestInit,
	retries: number,
	retryDelayMs: number,
	label: string,
): Promise<unknown> {
	let lastErr: Error | undefined;
	const method = init.method ?? "GET";
	const { pathname } = new URL(url);
	const longWait = isGatewayLongWaitRoute(method, pathname);
	const resends = resendsAfterFailure(method, pathname);
	const requestInit = longWait ? { ...init, timeout: false } : init;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(url, requestInit);
			const body = res.ok ? await res.text() : await readResponseBody(res, MAX_ROUTER_ERROR_BODY);
			let json: unknown;
			try {
				json = JSON.parse(body) as unknown;
			} catch {
				throw new RouterHttpError(res.status, body);
			}
			if (!res.ok) throw new RouterHttpError(res.status, routerErrorText(json) ?? body);
			return json;
		} catch (err) {
			lastErr = err instanceof Error ? err : new Error(String(err));
			if (err instanceof RouterHttpError) throw err;
			if (attempt >= retries || (!resends && !isConnectionRefused(err))) break;
			const delay = retryDelayMs * 2 ** attempt;
			console.error(
				`[bridge] ${label} ${url} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${lastErr.message}`,
			);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
	throw lastErr!;
}

function isConnectionRefused(error: unknown): boolean {
	const seen = new Set<object>();
	let current: unknown = error;
	while (current !== null && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		const failure = current as { cause?: unknown; code?: unknown };
		// Bun, then Node.
		if (failure.code === "ConnectionRefused" || failure.code === "ECONNREFUSED") return true;
		current = failure.cause;
	}
	return false;
}

/** Post a self-scoped action. */
export async function postPluginAction(
	pluginId: string,
	actionType: string,
	payload?: Record<string, unknown>,
): Promise<{ delivered?: boolean }> {
	return (await routerPost("/plugin-action", {
		from: PROJECT_NAME,
		pluginId,
		actionType,
		...(payload ? { payload } : {}),
	})) as { delivered?: boolean };
}

/** Post a self-scoped board action. */
export async function postBoard(body: Record<string, unknown>): Promise<unknown> {
	// Force the caller identity.
	return routerPost("/task-board", { ...body, from: PROJECT_NAME });
}

export async function routerGet(
	path: string,
	{ retries = 2, retryDelayMs = 1000 }: RouterPostOptions = {},
): Promise<unknown> {
	return routerRequest(`${ROUTER_URL}${path}`, { headers: sessionTokenHeader() }, retries, retryDelayMs, "routerGet");
}

let opLedgerProtocol = 0;

/** Refuse sends without op-ledger support. */
export function opLedgerRefusal(): string | null {
	if (opLedgerProtocol >= OP_LEDGER_PROTOCOL) return null;
	return opLedgerProtocol === 0
		? `The gateway has not advertised an op-ledger version. Update the gateway before the plugin.`
		: `The gateway's op-ledger version ${opLedgerProtocol} is older than this plugin's ${OP_LEDGER_PROTOCOL}.`;
}

export function buildRegisterMsg(
	subId: string,
	mode: ConnectionMode = "channel",
): Record<string, string | boolean | number> {
	const registerMsg: Record<string, string | boolean | number> = {
		type: "register",
		team: PROJECT_NAME,
		mode,
		subId,
		conversationId: CONVERSATION_ID,
		version: packageJson.version,
	};
	if (process.env.PROJECT_HOST_PATH) {
		registerMsg.projectPath = process.env.PROJECT_HOST_PATH;
	}
	if (process.env.CLAUDE_CODE_SESSION_ID) {
		registerMsg.claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;
	}
	if (cli.harness !== null) registerMsg.harness = cli.harness;
	const cwdName = basename(process.cwd());
	if (cwdName) registerMsg.cwdName = cwdName;
	registerMsg.agentPid = process.ppid;
	if (process.env.SWITCHBOARD_SESSION_TOKEN) {
		registerMsg.sessionToken = process.env.SWITCHBOARD_SESSION_TOKEN;
	}
	if (handshakeRole.get() === true) registerMsg.isMainOrLead = true;
	return registerMsg;
}

export function connectToRouter(): void {
	const wsUrl = `${ROUTER_URL.replace(/^http/, "ws")}/bridge`;
	// Reset capabilities per connection.
	opLedgerProtocol = 0;
	routerWs = new WebSocket(wsUrl);

	const mode: ConnectionMode = "channel";

	routerWs.on("open", () => {
		console.error(`[bridge] connected to router (mode: ${mode})`);
		reconnector.reset();
		// Discard the stale handshake id.
		handshakeRole.resetUnanswered();
		routerWs!.send(JSON.stringify(buildRegisterMsg(crypto.randomUUID().slice(0, 8), mode)));
	});

	routerWs.on("message", (raw: WebSocket.Data) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		if (
			msg.type === "channel_push" &&
			msg.from === "gateway" &&
			msg.replyJsonSchema &&
			typeof msg.session_id === "string" &&
			msg.session_id.startsWith("hs-")
		) {
			const hsSessionId = msg.session_id as string;
			handshakeRole.noteReceived(hsSessionId);
			const role = handshakeRole.get();
			if (role !== null && cli.answersHandshake) {
				const refusal = opLedgerRefusal();
				if (refusal) {
					console.error(`[bridge] handshake reply withheld: ${refusal}`);
					return;
				}
				console.error(`[bridge] handshake auto-reply [${hsSessionId}], isMainOrLead=${role}`);
				routerPost("/respond", {
					opId: crypto.randomUUID(),
					session_id: hsSessionId,
					status: "completed",
					replyAsJson: { isMainOrLead: role },
				}).catch((err: Error) => {
					console.error(`[bridge] handshake reply failed: ${err.message}`);
				});
				return;
			}
		}

		if (msg.type === "register_ok") {
			opLedgerProtocol = typeof msg.opLedgerProtocol === "number" ? msg.opLedgerProtocol : 0;
			// A new socket holds no report.
			resendPresence();
			return;
		}

		// This process's credentials never change, so retrying is a loop; a held reserved name may free up.
		if (msg.type === "register_reject" && msg.reason === "unauthorized") {
			console.error(`[bridge] registration refused as unauthorized - not reconnecting`);
			suppressReconnect = true;
			routerWs?.close();
			return;
		}

		if (msg.type === "handshake_reject") {
			console.error(`[bridge] handshake rejected - this is a worker, disconnecting permanently`);
			suppressReconnect = true;
			routerWs?.close();
			return;
		}

		const via = transport();
		if (msg.type === "channel_push" && via.ready()) {
			const delivery = () => deliverChannelPush(msg as unknown as ChannelPushPayload);
			const queued = via.queued ? serializeQueuedDelivery(delivery) : delivery();
			queued.catch((err: Error) => {
				// Retain failed deliveries.
				console.error(`[channel] notification error: ${err.message}`);
			});
		}

		if (msg.type === "response_push" && via.ready()) {
			const emit = () => via.response(msg as unknown as ResponsePushPayload);
			const queued = via.queued ? serializeQueuedDelivery(emit) : emit();
			queued.catch((err: Error) => {
				console.error(`[channel] response notification error: ${err.message}`);
			});
		}

		if (msg.type === SESSION_CONTROL_FRAME && typeof msg.reqId === "string") {
			const reqId = msg.reqId;
			const reply = (result: SessionControlResult): void => {
				const frame: SessionControlReply = { type: SESSION_CONTROL_REPLY_FRAME, reqId, result };
				routerWs?.send(JSON.stringify(frame));
			};
			const op = parseSessionControlOp(msg.op);
			const session = apiSession;
			if (op === null || typeof msg.key !== "string" || session === null) {
				reply({ ok: false, failure: "refused", detail: "this session's plugin cannot answer that" });
				return;
			}
			controlDedupe
				.once(msg.key, () => session.control(op))
				.then(reply)
				.catch((err: Error) => reply({ ok: false, failure: "failed", detail: err.message }));
		}

		// Answered off the agent's turn: this callback shares the process but not its thread of control.
		if (msg.type === WORKSPACE_OP_FRAME) {
			const request = parseWorkspaceOpRequest(msg);
			if (request === null) {
				console.error(`[workspace] op frame without a request id`);
				return;
			}
			if ("refused" in request) {
				routerWs?.send(JSON.stringify(refusedOnPlane(request.reqId, request.refused)));
				return;
			}
			answerOnPlane(request.reqId, request.key, request.op)
				.then((reply) => routerWs?.send(JSON.stringify(reply)))
				.catch((err: Error) => {
					console.error(`[workspace] op failed to answer: ${err.message}`);
				});
		}
	});

	routerWs.on("close", () => {
		console.error(`[bridge] disconnected`);
		opLedgerProtocol = 0;
		// Its end goes unheard.
		if (presenceSent?.compacting) compactedUnheard = true;
		presenceSent = undefined;
		if (!suppressReconnect) {
			reconnector.schedule();
		}
	});

	routerWs.on("error", (err: Error) => {
		console.error(`[bridge] ws error: ${err.message}`);
	});
}

export function closeRouter(): void {
	// Cancel reconnect before closing.
	reconnector.cancel();
	opLedgerProtocol = 0;
	if (routerWs) routerWs.close();
}
