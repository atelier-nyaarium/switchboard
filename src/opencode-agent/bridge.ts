// One OpenCode server and the JSON-lines bridge a driver speaks to over stdio.

import { findBinary, type ServerHandle } from "../opencode-launch/launcher.js";
import { counterKindOfTool } from "../shared/agent-counter.js";
import { opencodeAuth, parseOpencodeVersion } from "../shared/opencode.js";
import {
	type BridgeErrorCode,
	type BridgeEvent,
	type BridgeMessage,
	type BridgeRequest,
	BridgeRequestSchema,
	type BridgeResult,
	type OpencodeTerminal,
	splitOpencodeModel,
} from "../shared/opencode-agent.js";
import { versionRefusal } from "../shared/session-harness.js";

////////////////////////////////
//  Interfaces & Types

export interface BridgePorts {
	env: Readonly<Record<string, string | undefined>>;
	home: string;
	isExecutable(file: string): boolean;
	readVersion(binary: string): Promise<string | undefined>;
	startServer(binary: string, env: Record<string, string>): ServerHandle;
	fetch: typeof fetch;
	/** Bounds one call, never the event stream. */
	abortAfter(ms: number, route: string): AbortSignal;
	randomHex(bytes: number): string;
	sleep(ms: number): Promise<void>;
	write(line: string): void;
	log(line: string): void;
}

export interface BridgeOptions {
	/** A steer is refused after this long without delivery. */
	steerWaitMs?: number;
}

export interface Bridge {
	receive(line: string): void;
	/** Stdin closed, or the host is going away. */
	closed(): void;
	done: Promise<void>;
}

interface Row {
	id: string;
	type: string;
	content?: Array<{
		type?: string;
		text?: string;
		id?: string;
		name?: string;
		state?: { status?: string };
	}>;
	text?: string;
	error?: { message?: string };
	outcome?: string;
}

interface TurnRows {
	turnId: string;
	assistant: Row[];
	rows: Row[];
	idle?: Row;
}

interface ActiveTurn {
	turnId: string;
	sawStep: boolean;
	interrupted: boolean;
	/** Progress sent recently. */
	heard?: boolean;
	seenTools: Set<string>;
	pendingMessageId?: string;
	pendingTexts: Map<number, string>;
}

interface SteerWaiter {
	turnId: string;
	resolve(): void;
	reject(error: Error): void;
}

interface ThreadState {
	id: string;
	cwd: string;
	active?: ActiveTurn;
	waiters: Map<string, SteerWaiter>;
}

class BridgeFailure extends Error {
	constructor(
		readonly code: BridgeErrorCode,
		message: string,
	) {
		super(message);
	}
}

////////////////////////////////
//  Constants

const SERVER_START_MS = 30_000;
const STREAM_CONNECT_MS = 10_000;
const EVENT_RETRY_MIN_MS = 1_000;
const EVENT_RETRY_MAX_MS = 15_000;
const STEER_WAIT_MS = 120_000;
const HISTORY_LIMIT = 200;
const HISTORY_MAX_PAGES = 200;
const HTTP_CALL_MS = 20_000;
const PROGRESS_EVERY_MS = 15_000;
const EVENT_TYPES = [
	"session.execution.started",
	"session.execution.succeeded",
	"session.execution.failed",
	"session.execution.interrupted",
	"session.step.started",
	"session.text.ended",
	"session.tool.input.started",
	"session.inbox.delivered",
	// Unknown types reject streams.
	"session.step.ended",
	"session.step.failed",
	"session.text.started",
	"session.reasoning.started",
	"session.reasoning.ended",
	"session.tool.input.ended",
	"session.tool.called",
	"session.tool.progress",
	"session.tool.success",
	"session.tool.failed",
];

////////////////////////////////
//  Functions & Helpers

function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
	return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function safeMessage(message: string): string {
	return message.replace(/https?:\/\/\S+/g, "[server]").slice(0, 2048);
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function responseMessage(data: unknown): string | undefined {
	const message = stringOf(recordOf(data)?.message);
	return message === undefined ? undefined : safeMessage(message).slice(0, 512);
}

function httpFailure(action: string, status: number, data: unknown): BridgeFailure {
	const message = responseMessage(data);
	return new BridgeFailure("http", `OpenCode answered HTTP ${status} ${action}${message ? `: ${message}` : ""}`);
}

function rowOf(value: unknown): Row | undefined {
	const record = recordOf(value);
	if (!record) return undefined;
	const id = stringOf(record.id);
	const type = stringOf(record.type);
	if (!id || !type) return undefined;
	const content = Array.isArray(record.content)
		? record.content.flatMap((part) => {
				const held = recordOf(part);
				const kind = stringOf(held?.type);
				if (!kind) return [];
				const text = stringOf(held?.text);
				const id = stringOf(held?.id);
				const name = stringOf(held?.name);
				const state = recordOf(held?.state);
				const status = stringOf(state?.status);
				return [
					{
						type: kind,
						...(text !== undefined ? { text } : {}),
						...(id !== undefined ? { id } : {}),
						...(name !== undefined ? { name } : {}),
						...(status !== undefined ? { state: { status } } : {}),
					},
				];
			})
		: undefined;
	const error = recordOf(record.error);
	const message = stringOf(error?.message);
	return {
		id,
		type,
		...(content ? { content } : {}),
		...(stringOf(record.text) !== undefined ? { text: stringOf(record.text) } : {}),
		...(message !== undefined ? { error: { message } } : {}),
		...(stringOf(record.outcome) !== undefined ? { outcome: stringOf(record.outcome) } : {}),
	};
}

function rowsOf(value: unknown): Row[] {
	const data = recordOf(value)?.data;
	return Array.isArray(data) ? data.flatMap((row) => rowOf(row) ?? []) : [];
}

function textParts(row: Row): Array<{ ordinal: number; text: string }> {
	if (row.content) {
		const parts: Array<{ ordinal: number; text: string }> = [];
		for (const part of row.content) {
			if (part.type === "text" && typeof part.text === "string")
				parts.push({ ordinal: parts.length, text: part.text });
		}
		return parts;
	}
	return typeof row.text === "string" ? [{ ordinal: 0, text: row.text }] : [];
}

function turnsOf(rows: readonly Row[]): TurnRows[] {
	const turns: TurnRows[] = [];
	let current: TurnRows | undefined;
	for (const row of rows) {
		if (row.type === "user" || row.type === "synthetic") {
			if (!current) current = { turnId: row.id, assistant: [], rows: [row] };
			else current.rows.push(row);
			continue;
		}
		if (!current) continue;
		current.rows.push(row);
		if (row.type === "assistant") current.assistant.push(row);
		if (row.type === "idle") {
			current.idle = row;
			turns.push(current);
			current = undefined;
		}
	}
	if (current) turns.push(current);
	return turns;
}

function terminalOf(turn: TurnRows): OpencodeTerminal {
	const idle = turn.idle;
	if (idle?.outcome === "failed") {
		return { status: "failed", error: idle.error?.message?.trim() || "OpenCode turn failed" };
	}
	if (idle?.outcome === "interrupted") return { status: "interrupted" };
	const last = turn.assistant.at(-1);
	if (!last) return { status: "completed", finalResponse: "" };
	const texts = textParts(last);
	const finalResponse = texts.map((part) => part.text).join("\n");
	const finalItemId = texts.length > 0 ? `${last.id}:${texts.at(-1)?.ordinal ?? 0}` : undefined;
	return { status: "completed", finalResponse, ...(finalItemId ? { finalItemId } : {}) };
}

function turnById(turns: readonly TurnRows[], turnId: string): TurnRows | undefined {
	return turns.find((turn) => turn.turnId === turnId);
}

function turnWithPrompt(turns: readonly TurnRows[], promptId: string): TurnRows | undefined {
	return turns.find((turn) =>
		turn.rows.some((row) => row.id === promptId && (row.type === "user" || row.type === "synthetic")),
	);
}

function activeTurn(turnId: string): ActiveTurn {
	return { turnId, sawStep: false, interrupted: false, seenTools: new Set(), pendingTexts: new Map() };
}

////////////////////////////////
//  Bridge

export async function startBridge(ports: BridgePorts, options: BridgeOptions = {}): Promise<Bridge> {
	const threads = new Map<string, ThreadState>();
	const steerWaitMs = options.steerWaitMs ?? STEER_WAIT_MS;
	let closed = false;
	let server: ServerHandle | undefined;
	let streamAbort: AbortController | undefined;
	let resolveDone: () => void = () => undefined;
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});

	const send = (message: BridgeMessage): void => {
		ports.write(JSON.stringify(message));
	};

	const failReady = (code: "binary_missing" | "version_refused" | "server_failed", message: string): Bridge => {
		send({ type: "ready", ok: false, code, message: safeMessage(message) });
		server?.stop();
		resolveDone();
		return { receive: () => undefined, closed: () => undefined, done };
	};

	const binary = findBinary(ports);
	if (!binary) return failReady("binary_missing", "OpenCode is not installed");
	const version = parseOpencodeVersion((await ports.readVersion(binary)) ?? "");
	const refusal = versionRefusal("opencode", version);
	if (refusal) return failReady("version_refused", refusal);

	const password = ports.randomHex(24);
	let baseUrl: string;
	try {
		server = ports.startServer(binary, {
			...definedEnv(ports.env),
			OPENCODE_PASSWORD: password,
			OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable" }),
		});
	} catch {
		return failReady("server_failed", "the OpenCode server did not start");
	}
	const started = await Promise.race([server.url, ports.sleep(SERVER_START_MS).then(() => undefined)]);
	if (!started) return failReady("server_failed", "the OpenCode server did not start");
	baseUrl = started;

	const headers = { authorization: opencodeAuth(password), "content-type": "application/json" };
	const call = async (method: string, route: string, body?: unknown): Promise<{ status: number; data: unknown }> => {
		let response: Response;
		try {
			response = await ports.fetch(`${baseUrl}${route}`, {
				method,
				headers,
				signal: ports.abortAfter(HTTP_CALL_MS, route),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			throw new BridgeFailure("http", "the OpenCode server is unavailable");
		}
		const text = await response.text().catch(() => "");
		let data: unknown = text;
		try {
			data = JSON.parse(text);
		} catch {
			// Not JSON.
		}
		return { status: response.status, data };
	};

	const readModels = async (): Promise<Array<{ id: string }>> => {
		const { status, data } = await call("GET", "/api/model");
		if (status !== 200) throw httpFailure("listing models", status, data);
		const rows = recordOf(data)?.data;
		if (!Array.isArray(rows)) return [];
		const ids: string[] = [];
		for (const row of rows) {
			const held = recordOf(row);
			const id = stringOf(held?.id);
			const providerID = stringOf(held?.providerID);
			if (id && providerID) ids.push(`${providerID}/${id}`);
		}
		return [...new Set(ids)].map((id) => ({ id }));
	};

	const readPage = async (threadId: string, cursor?: string): Promise<{ rows: Row[]; next?: string }> => {
		const route = cursor
			? `/api/session/${threadId}/message?limit=${HISTORY_LIMIT}&cursor=${encodeURIComponent(cursor)}`
			: `/api/session/${threadId}/message?limit=${HISTORY_LIMIT}&order=desc`;
		const { status, data } = await call("GET", route);
		if (status === 404) throw new BridgeFailure("not_found", "the OpenCode session was not found");
		if (status !== 200) throw httpFailure("reading messages", status, data);
		const next = stringOf(recordOf(recordOf(data)?.cursor)?.next);
		return { rows: rowsOf(data), ...(next ? { next } : {}) };
	};

	/** Newest first until the turn, or the newest turn for no `turnId`. */
	const readRows = async (threadId: string, turnId?: string): Promise<Row[]> => {
		const pages: Row[][] = [];
		let cursor: string | undefined;
		for (let index = 0; index < HISTORY_MAX_PAGES; index += 1) {
			const page = await readPage(threadId, cursor);
			if (page.rows.length === 0) break;
			pages.unshift([...page.rows].reverse());
			const turns = turnsOf(pages.flat());
			if (turnId ? turns.some((turn) => turn.turnId === turnId) : turns.some((turn) => turn.idle)) break;
			if (!page.next) break;
			cursor = page.next;
		}
		return pages.flat();
	};

	const readActive = async (): Promise<Set<string>> => {
		const { status, data } = await call("GET", "/api/session/active");
		if (status !== 200) throw httpFailure("reading active sessions", status, data);
		const held = recordOf(data)?.data;
		return new Set(held ? Object.keys(held) : []);
	};

	const readInbox = async (threadId: string): Promise<string[]> => {
		const { status, data } = await call("GET", `/api/session/${threadId}/inbox`);
		if (status !== 200) return [];
		const rows = recordOf(data)?.data;
		if (!Array.isArray(rows)) return [];
		return rows.flatMap((row) => stringOf(recordOf(row)?.id) ?? []);
	};

	/** Undefined when the inbox cannot be read. */
	const queuedIn = async (threadId: string, promptId: string): Promise<boolean | undefined> => {
		const { status, data } = await call("GET", `/api/session/${threadId}/inbox`);
		if (status !== 200) return undefined;
		const rows = recordOf(data)?.data;
		return Array.isArray(rows) && rows.some((row) => stringOf(recordOf(row)?.id) === promptId);
	};

	const threadFor = (threadId: string): ThreadState => {
		const held = threads.get(threadId);
		if (!held) throw new BridgeFailure("not_found", "the OpenCode session is not open");
		return held;
	};

	const sendEvent = (event: BridgeEvent): void => {
		send(event);
	};

	const flushCommentary = (thread: ThreadState, active: ActiveTurn): void => {
		if (!active.pendingMessageId || active.pendingTexts.size === 0) {
			active.pendingMessageId = undefined;
			active.pendingTexts.clear();
			return;
		}
		const messageId = active.pendingMessageId;
		for (const [ordinal, text] of [...active.pendingTexts].sort(([left], [right]) => left - right)) {
			if (!text) continue;
			sendEvent({
				type: "event",
				event: "activity",
				threadId: thread.id,
				turnId: active.turnId,
				text,
				itemId: `${messageId}:${ordinal}`,
			});
		}
		active.pendingMessageId = undefined;
		active.pendingTexts.clear();
	};

	const settle = (
		thread: ThreadState,
		active: ActiveTurn,
		terminal: OpencodeTerminal,
		rejectWaiters = true,
	): void => {
		if (thread.active !== active) return;
		thread.active = undefined;
		sendEvent({ type: "event", event: "terminal", threadId: thread.id, turnId: active.turnId, terminal });
		if (!rejectWaiters) return;
		for (const [promptId, waiter] of [...thread.waiters]) {
			if (waiter.turnId === active.turnId) void withdrawAndReject(thread, promptId, waiter);
		}
	};

	const cancelPrompt = async (threadId: string, promptId: string): Promise<void> => {
		try {
			await call("DELETE", `/api/session/${threadId}/inbox/${promptId}`);
		} catch {
			// A prompt already taken has no inbox item.
		}
	};

	const emitToolCounters = (thread: ThreadState, active: ActiveTurn, turn: TurnRows | undefined): void => {
		if (!turn) return;
		for (const row of turn.assistant) {
			for (const part of row.content ?? []) {
				if (part.type !== "tool" || !part.id || !part.name) continue;
				if (active.seenTools.has(part.id)) continue;
				active.seenTools.add(part.id);
				sendEvent({
					type: "event",
					event: "counter",
					threadId: thread.id,
					turnId: active.turnId,
					counterKind: counterKindOfTool(part.name),
					itemId: part.id,
				});
			}
		}
	};

	const adoptTurn = (thread: ThreadState, turn: TurnRows): void => {
		const adopted = activeTurn(turn.turnId);
		adopted.sawStep = turn.assistant.length > 0;
		emitToolCounters(thread, adopted, turn);
		thread.active = adopted;
	};

	const withdrawAndReject = async (thread: ThreadState, promptId: string, waiter: SteerWaiter): Promise<void> => {
		if (thread.waiters.get(promptId) !== waiter) return;
		thread.waiters.delete(promptId);
		if (thread.active?.turnId === waiter.turnId) {
			// A turn that still runs is left running: a long step takes no prompt until it ends.
			let ended: OpencodeTerminal | undefined;
			try {
				const old = turnById(turnsOf(await readRows(thread.id, waiter.turnId)), waiter.turnId);
				if (old?.idle) ended = terminalOf(old);
				else if (!(await readActive()).has(thread.id))
					ended = { status: "failed", error: "the OpenCode turn was lost" };
			} catch {
				// Unread: the next stream connection settles it.
			}
			// Its other steers are answered with it.
			if (ended && thread.active?.turnId === waiter.turnId) settle(thread, thread.active, ended);
		}
		await cancelPrompt(thread.id, promptId);
		// Unread counts as still queued.
		let queued = true;
		try {
			const turns = turnsOf(await readRows(thread.id, waiter.turnId));
			const landed = turnWithPrompt(turns, promptId);
			if (landed?.turnId === waiter.turnId) {
				waiter.resolve();
				return;
			}
			if (landed && !landed.idle && !thread.active) adoptTurn(thread, landed);
			queued = (await queuedIn(thread.id, promptId)) !== false;
		} catch {
			// Reject below.
		}
		if (thread.active?.turnId !== waiter.turnId) {
			waiter.reject(new BridgeFailure("turn_ended", "the OpenCode turn ended before the prompt was taken"));
			return;
		}
		waiter.reject(
			new BridgeFailure(
				"not_taken",
				queued
					? "the OpenCode turn did not take the prompt in time, and it could not be withdrawn, so it may still land"
					: "the OpenCode turn did not take the prompt in time and is still working",
			),
		);
	};

	/** The prompt row, not the local pointer, decides where a steer landed. */
	const decideWaiter = async (thread: ThreadState, promptId: string, waiter: SteerWaiter): Promise<void> => {
		let turns: TurnRows[];
		let inbox: string[];
		try {
			turns = turnsOf(await readRows(thread.id, waiter.turnId));
			inbox = await readInbox(thread.id);
		} catch {
			return;
		}
		const turn = turnWithPrompt(turns, promptId);
		if (turn) {
			thread.waiters.delete(promptId);
			if (turn.turnId === waiter.turnId) {
				waiter.resolve();
				return;
			}
			if (thread.active?.turnId === waiter.turnId) {
				const old = turnById(turns, waiter.turnId);
				settle(
					thread,
					thread.active,
					old?.idle ? terminalOf(old) : { status: "failed", error: "the OpenCode turn was lost" },
				);
			}
			if (!turn.idle && !thread.active) adoptTurn(thread, turn);
			waiter.reject(new BridgeFailure("turn_ended", "the OpenCode turn ended before the prompt was taken"));
			return;
		}
		if (thread.active?.turnId === waiter.turnId) {
			// Still running: parked, or its row is not visible yet.
			if (inbox.includes(promptId)) return;
			return;
		}
		thread.waiters.delete(promptId);
		await cancelPrompt(thread.id, promptId);
		try {
			const after = turnsOf(await readRows(thread.id, waiter.turnId));
			const landed = turnWithPrompt(after, promptId);
			if (landed?.turnId === waiter.turnId) {
				waiter.resolve();
				return;
			}
			if (landed && !landed.idle && !thread.active) adoptTurn(thread, landed);
		} catch {
			// Reject below.
		}
		waiter.reject(new BridgeFailure("turn_ended", "the OpenCode turn ended before the prompt was taken"));
	};

	const fallbackTerminal = (type: string, active: ActiveTurn, data: Record<string, unknown>): OpencodeTerminal => {
		if (active.interrupted || type === "session.execution.interrupted") return { status: "interrupted" };
		if (type === "session.execution.failed") {
			const error = recordOf(data.error);
			return { status: "failed", error: stringOf(error?.message)?.trim() || "OpenCode turn failed" };
		}
		const texts = [...active.pendingTexts].sort(([left], [right]) => left - right).map(([, text]) => text);
		return { status: "completed", finalResponse: texts.join("\n") };
	};

	const finishActive = async (
		thread: ThreadState,
		active: ActiveTurn,
		type: string,
		data: Record<string, unknown>,
	): Promise<void> => {
		let terminal: OpencodeTerminal | undefined;
		try {
			const turns = turnsOf(await readRows(thread.id, active.turnId));
			const turn = turns.find((candidate) => candidate.turnId === active.turnId);
			if (turn?.idle) terminal = terminalOf(turn);
			else if (!active.sawStep) {
				const nowActive = await readActive();
				if (!nowActive.has(thread.id)) {
					const elsewhere = turns.find((candidate) => candidate.turnId === active.turnId);
					if (elsewhere?.idle) terminal = terminalOf(elsewhere);
					else {
						await cancelPrompt(thread.id, active.turnId);
						terminal = { status: "failed", error: "the OpenCode turn did not start" };
					}
				}
			}
		} catch {
			// A cut stream still settles from the event.
		}
		if (thread.active !== active) return;
		settle(thread, active, terminal ?? fallbackTerminal(type, active, data));
	};

	const adoptRunning = async (thread: ThreadState): Promise<void> => {
		if (thread.active) return;
		try {
			const active = await readActive();
			if (!active.has(thread.id) || thread.active) return;
			const turns = turnsOf(await readRows(thread.id));
			const current = turns.at(-1);
			if (!current || current.idle || thread.active) return;
			const adopted = activeTurn(current.turnId);
			adopted.sawStep = current.assistant.length > 0;
			emitToolCounters(thread, adopted, current);
			thread.active = adopted;
		} catch {
			// The next event or reconnect asks again.
		}
	};

	const decideDelivered = async (thread: ThreadState, inboxId: string): Promise<void> => {
		const waiter = thread.waiters.get(inboxId);
		if (!waiter) return;
		await decideWaiter(thread, inboxId, waiter);
	};

	const onTextEnded = (thread: ThreadState, active: ActiveTurn, data: Record<string, unknown>): void => {
		const messageId = stringOf(data.assistantMessageID);
		const text = stringOf(data.text);
		if (!messageId || text === undefined) return;
		const ordinal = numberOf(data.ordinal) ?? 0;
		if (active.pendingMessageId !== messageId) {
			flushCommentary(thread, active);
			active.pendingMessageId = messageId;
		}
		active.pendingTexts.set(ordinal, text);
	};

	const onToolStarted = (thread: ThreadState, active: ActiveTurn, data: Record<string, unknown>): void => {
		const id = stringOf(data.id);
		const name = stringOf(data.name);
		flushCommentary(thread, active);
		if (!id || !name || active.seenTools.has(id)) return;
		active.seenTools.add(id);
		sendEvent({
			type: "event",
			event: "counter",
			threadId: thread.id,
			turnId: active.turnId,
			counterKind: counterKindOfTool(name),
			itemId: id,
		});
	};

	const apply = (event: { type: string; data: Record<string, unknown> }): void => {
		const thread = threads.get(stringOf(event.data.sessionID) ?? "");
		if (!thread) return;
		const active = thread.active;
		if (active && !active.heard) {
			active.heard = true;
			sendEvent({ type: "event", event: "progress", threadId: thread.id, turnId: active.turnId });
			void ports.sleep(PROGRESS_EVERY_MS).then(() => {
				active.heard = false;
			});
		}
		switch (event.type) {
			case "session.execution.started":
				if (!active) void adoptRunning(thread);
				return;
			case "session.step.started":
				if (!active) return;
				active.sawStep = true;
				flushCommentary(thread, active);
				return;
			case "session.text.ended":
				if (active) onTextEnded(thread, active, event.data);
				return;
			case "session.tool.input.started":
				if (active) onToolStarted(thread, active, event.data);
				return;
			case "session.inbox.delivered": {
				const inboxId = stringOf(event.data.inboxID);
				if (!inboxId) return;
				void decideDelivered(thread, inboxId);
				return;
			}
			case "session.execution.succeeded":
			case "session.execution.failed":
			case "session.execution.interrupted":
				if (active) void finishActive(thread, active, event.type, event.data);
				return;
			default:
				return;
		}
	};

	const resync = async (
		buffered: Array<{ type: string; data: Record<string, unknown> }>,
		signal: AbortSignal,
	): Promise<void> => {
		for (const thread of threads.values()) {
			if (signal.aborted) return;
			let turns: TurnRows[];
			try {
				turns = turnsOf(await readRows(thread.id, thread.active?.turnId));
			} catch {
				continue;
			}
			if (signal.aborted) return;
			for (const [promptId, waiter] of [...thread.waiters]) {
				if (signal.aborted) return;
				await decideWaiter(thread, promptId, waiter);
			}
			const active = await readActive();
			if (signal.aborted) return;
			if (active.has(thread.id)) {
				const current = turns.at(-1);
				if (current && !current.idle) {
					if (thread.active?.turnId !== current.turnId) {
						if (thread.active) {
							const old = turnById(turns, thread.active.turnId);
							settle(
								thread,
								thread.active,
								old?.idle ? terminalOf(old) : { status: "failed", error: "the OpenCode turn was lost" },
							);
						}
						adoptTurn(thread, current);
					} else {
						emitToolCounters(thread, thread.active, current);
					}
				}
				continue;
			}
			if (!thread.active) continue;
			const held = thread.active;
			const turn = turnById(turns, held.turnId);
			settle(
				thread,
				held,
				turn?.idle ? terminalOf(turn) : { status: "failed", error: "the OpenCode turn was lost" },
			);
		}
		for (const event of buffered.splice(0)) apply(event);
	};

	const readEvents = async (
		signal: AbortSignal,
		onEvent: (event: { type: string; data: Record<string, unknown> }) => void,
	): Promise<void> => {
		const query = EVENT_TYPES.map((type) => `types=${encodeURIComponent(type)}`).join("&");
		const response = await ports.fetch(`${baseUrl}/api/event?${query}`, { headers, signal });
		if (!response.ok || !response.body)
			throw new BridgeFailure("http", `OpenCode answered HTTP ${response.status} to the event stream`);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done: ended, value } = await reader.read();
			if (ended) return;
			buffer += decoder.decode(value, { stream: true });
			for (;;) {
				const cut = buffer.indexOf("\n\n");
				if (cut < 0) break;
				const frame = buffer.slice(0, cut);
				buffer = buffer.slice(cut + 2);
				for (const line of frame.split("\n")) {
					if (!line.startsWith("data:")) continue;
					try {
						const event = JSON.parse(line.slice(5)) as { type?: unknown; data?: unknown };
						const type = stringOf(event.type);
						if (type) onEvent({ type, data: recordOf(event.data) ?? {} });
					} catch {
						// A frame this build cannot read.
					}
				}
			}
		}
	};

	let firstConnected: (() => void) | undefined;
	const streamReady = new Promise<void>((resolve) => {
		firstConnected = resolve;
	});
	const runStream = async (): Promise<void> => {
		let wait = EVENT_RETRY_MIN_MS;
		while (!closed) {
			const controller = new AbortController();
			streamAbort = controller;
			const buffered: Array<{ type: string; data: Record<string, unknown> }> = [];
			const live = { on: false };
			try {
				await readEvents(controller.signal, (event) => {
					if (event.type === "server.connected") {
						live.on = false;
						firstConnected?.();
						firstConnected = undefined;
						void resync(buffered, controller.signal)
							.then(() => {
								live.on = true;
							})
							.catch(() => {
								controller.abort();
							});
						return;
					}
					if (!live.on) buffered.push(event);
					else apply(event);
				});
				wait = EVENT_RETRY_MIN_MS;
			} catch {
				if (closed) return;
				ports.log("the OpenCode event stream dropped");
			} finally {
				controller.abort();
			}
			if (closed) return;
			await ports.sleep(wait);
			wait = Math.min(wait * 2, EVENT_RETRY_MAX_MS);
		}
	};
	void runStream();

	const connected = await Promise.race([
		streamReady.then(() => true),
		ports.sleep(STREAM_CONNECT_MS).then(() => false),
	]);
	if (!connected) {
		closed = true;
		streamAbort?.abort();
		return failReady("server_failed", "the OpenCode event stream did not connect");
	}

	send({ type: "ready", ok: true, version: version ?? "" });

	const handle = async (request: BridgeRequest): Promise<BridgeResult | undefined> => {
		switch (request.op) {
			case "models":
				return { type: "result", id: request.id, op: "models", models: await readModels() };
			case "open": {
				const model = request.model;
				if (!model) throw new BridgeFailure("bad_request", "open requires a model");
				const parts = splitOpencodeModel(model);
				if (!parts) throw new BridgeFailure("model_not_offered", `model ${model} must be provider/model`);
				const offered = await readModels();
				if (!offered.some((candidate) => candidate.id === model))
					throw new BridgeFailure("model_not_offered", `model ${model} is not offered by OpenCode`);
				const threadId = `ses_sb${ports.randomHex(16)}`;
				const answer = await call("POST", "/api/session", {
					id: threadId,
					location: { directory: request.cwd },
					model: parts,
					permissions: [{ action: "*", resource: "*", effect: "allow" }],
				});
				if (answer.status >= 400) throw httpFailure("creating the session", answer.status, answer.data);
				threads.set(threadId, { id: threadId, cwd: request.cwd, waiters: new Map() });
				return { type: "result", id: request.id, op: "open", threadId };
			}
			case "resume": {
				const answer = await call("GET", `/api/session/${request.threadId}`);
				if (answer.status === 404) throw new BridgeFailure("not_found", "the OpenCode session was not found");
				if (answer.status >= 400) throw httpFailure("reading the session", answer.status, answer.data);
				const held = threads.get(request.threadId);
				if (held) held.cwd = request.cwd;
				else threads.set(request.threadId, { id: request.threadId, cwd: request.cwd, waiters: new Map() });
				return { type: "result", id: request.id, op: "resume" };
			}
			case "start": {
				const thread = threadFor(request.threadId);
				let rows = await readRows(request.threadId);
				let turns = turnsOf(rows);
				if (thread.active) {
					const active = thread.active;
					const held = turnById(turns, active.turnId);
					if (held?.idle) settle(thread, active, terminalOf(held));
					else if (!held) {
						try {
							const own = turnById(
								turnsOf(await readRows(request.threadId, active.turnId)),
								active.turnId,
							);
							if (own?.idle && thread.active === active) settle(thread, active, terminalOf(own));
						} catch {
							// The stream still owns it.
						}
					}
				}
				let existing = turns.find((candidate) => candidate.turnId === request.turnId);
				if (!existing) {
					rows = await readRows(request.threadId, request.turnId);
					turns = turnsOf(rows);
					existing = turns.find((candidate) => candidate.turnId === request.turnId);
				}
				if (existing?.idle) {
					return {
						type: "result",
						id: request.id,
						op: "start",
						turnId: request.turnId,
						terminal: terminalOf(existing),
					};
				}
				const anywhere = rows.some(
					(row) => row.id === request.turnId && (row.type === "user" || row.type === "synthetic"),
				);
				if (anywhere && !existing) {
					return {
						type: "result",
						id: request.id,
						op: "start",
						turnId: request.turnId,
						terminal: { status: "failed", error: "the OpenCode prompt was already taken" },
					};
				}
				if (existing) {
					const running = await readActive();
					if (running.has(thread.id)) {
						if (!thread.active || thread.active.turnId !== request.turnId) {
							thread.active = activeTurn(request.turnId);
							thread.active.sawStep = existing.assistant.length > 0;
							emitToolCounters(thread, thread.active, existing);
						}
						return { type: "result", id: request.id, op: "start", turnId: request.turnId };
					}
					if (thread.active?.turnId === request.turnId) thread.active = undefined;
					return {
						type: "result",
						id: request.id,
						op: "start",
						turnId: request.turnId,
						terminal: { status: "failed", error: "the OpenCode turn did not finish" },
					};
				}
				if (thread.active && thread.active.turnId !== request.turnId)
					throw new BridgeFailure("turn_inactive", "the OpenCode thread is still running");
				thread.active = activeTurn(request.turnId);
				let answer: { status: number; data: unknown };
				try {
					answer = await call("POST", `/api/session/${request.threadId}/prompt`, {
						id: request.turnId,
						text: request.prompt,
						delivery: "queue",
						resume: true,
					});
				} catch (error) {
					if (thread.active?.turnId === request.turnId) thread.active = undefined;
					await cancelPrompt(thread.id, request.turnId);
					throw error;
				}
				if (answer.status >= 400) {
					if (thread.active?.turnId === request.turnId) thread.active = undefined;
					throw httpFailure("starting the turn", answer.status, answer.data);
				}
				return { type: "result", id: request.id, op: "start", turnId: request.turnId };
			}
			case "steer": {
				const thread = threadFor(request.threadId);
				if (thread.active?.turnId !== request.turnId) {
					// The local pointer may lag the server; ask the rows before refusing.
					try {
						const running = await readActive();
						const turns = turnsOf(await readRows(request.threadId, request.turnId));
						const turn = turnById(turns, request.turnId);
						if (!running.has(request.threadId) || !turn || turn.idle)
							throw new BridgeFailure("turn_inactive", "the OpenCode turn is no longer active");
						thread.active = activeTurn(request.turnId);
						thread.active.sawStep = turn.assistant.length > 0;
						emitToolCounters(thread, thread.active, turn);
					} catch (error) {
						if (error instanceof BridgeFailure) throw error;
						throw new BridgeFailure("turn_inactive", "the OpenCode turn is no longer active");
					}
				}
				const rows = await readRows(request.threadId, request.turnId);
				const turn = turnById(turnsOf(rows), request.turnId);
				const taken = turn?.rows.some((row) => row.id === request.promptId);
				if (taken) return { type: "result", id: request.id, op: "steer" };
				const elsewhere = rows.some(
					(row) => row.id === request.promptId && (row.type === "user" || row.type === "synthetic"),
				);
				if (elsewhere)
					throw new BridgeFailure("turn_inactive", "the OpenCode prompt was taken by another turn");
				const inbox = await readInbox(request.threadId);
				const delivered = new Promise<void>((resolve, reject) => {
					const waiter: SteerWaiter = { turnId: request.turnId, resolve, reject };
					thread.waiters.set(request.promptId, waiter);
					void ports.sleep(steerWaitMs).then(() => {
						if (thread.waiters.get(request.promptId) !== waiter) return;
						void withdrawAndReject(thread, request.promptId, waiter);
					});
				});
				if (!inbox.includes(request.promptId)) {
					try {
						const answer = await call("POST", `/api/session/${request.threadId}/prompt`, {
							id: request.promptId,
							text: request.prompt,
							delivery: "steer",
							resume: true,
						});
						if (answer.status >= 400) {
							thread.waiters.delete(request.promptId);
							throw httpFailure("steering the turn", answer.status, answer.data);
						}
					} catch (error) {
						thread.waiters.delete(request.promptId);
						throw error;
					}
				}
				await delivered;
				return { type: "result", id: request.id, op: "steer" };
			}
			case "interrupt": {
				const thread = threadFor(request.threadId);
				const active = thread.active;
				if (!active || active.turnId !== request.turnId)
					return { type: "result", id: request.id, op: "interrupt", interrupted: false };
				const answer = await call("POST", `/api/session/${request.threadId}/interrupt?resume=false`);
				if (answer.status >= 400) throw httpFailure("interrupting the turn", answer.status, answer.data);
				const interrupted = recordOf(answer.data)?.interrupted === true;
				if (interrupted) {
					active.interrupted = true;
					settle(thread, active, { status: "interrupted" });
				}
				return { type: "result", id: request.id, op: "interrupt", interrupted };
			}
			case "inspect": {
				try {
					const turns = turnsOf(await readRows(request.threadId, request.turnId));
					const turn = turns.find((candidate) => candidate.turnId === request.turnId);
					if (turn?.idle)
						return {
							type: "result",
							id: request.id,
							op: "inspect",
							inspection: { known: "settled", terminal: terminalOf(turn) },
						};
					if (!turn)
						return { type: "result", id: request.id, op: "inspect", inspection: { known: "unknown" } };
					const active = await readActive();
					return {
						type: "result",
						id: request.id,
						op: "inspect",
						inspection: active.has(request.threadId) ? { known: "running" } : { known: "unknown" },
					};
				} catch {
					return { type: "result", id: request.id, op: "inspect", inspection: { known: "unknown" } };
				}
			}
		}
	};

	const receive = (line: string): void => {
		if (closed) return;
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			return;
		}
		const parsed = BridgeRequestSchema.safeParse(raw);
		if (!parsed.success) {
			const held = recordOf(raw);
			const id = stringOf(held?.id);
			if (id && held?.type === "request")
				send({ type: "error", id, code: "bad_request", message: "the bridge request is malformed" });
			return;
		}
		void handle(parsed.data)
			.then((result) => {
				if (result) send(result);
			})
			.catch((error: unknown) => {
				const failure =
					error instanceof BridgeFailure
						? error
						: new BridgeFailure(
								"http",
								error instanceof Error ? error.message : "the OpenCode bridge failed",
							);
				send({
					type: "error",
					id: parsed.data.id,
					code: failure.code,
					message: safeMessage(failure.message),
				});
			});
	};

	const close = (): void => {
		if (closed) return;
		closed = true;
		streamAbort?.abort();
		server?.stop();
		resolveDone();
	};

	void server.exited.then(() => close());

	return { receive, closed: close, done };
}
