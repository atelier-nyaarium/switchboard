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
	/** Bounds one call or one operation, never the event stream. */
	abortAfter(ms: number, route: string): AbortSignal;
	randomHex(bytes: number): string;
	sleep(ms: number): Promise<void>;
	write(line: string): void;
	log(line: string): void;
}

export interface Bridge {
	receive(line: string): void;
	/** Stdin closed or host exits. */
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
	completed?: boolean;
	finish?: string;
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
	/** Progress rate limit. */
	heard?: boolean;
	seenTools: Set<string>;
	pendingMessageId?: string;
	pendingTexts: Map<number, string>;
}

interface ThreadState {
	id: string;
	cwd: string;
	active?: ActiveTurn;
	/** Accepted prompts still in the inbox, each naming its turn. */
	queued: Map<string, string>;
	/** The thread's operation chain. */
	ending: Promise<void>;
}

/** Where a steer stands. `held` and `between` are queued under a running turn. */
type Standing =
	| { at: "taken" | "held" | "between" | "adrift" | "stranded" | "unseen" }
	| { at: "elsewhere"; holder: TurnRows };

interface SteerWindow {
	over: boolean;
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
const RETRY_TRIES = 3;
const RETRY_PAUSE_MS = 500;
const STEER_POLL_MS = 500;
const STEER_WINDOW_MS = 10_000;
// Below the driver's start and steer limits.
const OPERATION_DEADLINE_MS = 60_000;
// A turn that missed an accepted steer fails.
const UNDELIVERED: OpencodeTerminal = {
	status: "failed",
	error: "a steered message could not be delivered to the OpenCode turn",
};
const LOST: OpencodeTerminal = { status: "failed", error: "the OpenCode turn was lost" };
const UNREADABLE = "the OpenCode server sent an answer this bridge cannot read";
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
	const finish = stringOf(record.finish);
	return {
		id,
		type,
		...(content ? { content } : {}),
		...(stringOf(record.text) !== undefined ? { text: stringOf(record.text) } : {}),
		...(message !== undefined ? { error: { message } } : {}),
		...(stringOf(record.outcome) !== undefined ? { outcome: stringOf(record.outcome) } : {}),
		...(numberOf(recordOf(record.time)?.completed) !== undefined ? { completed: true } : {}),
		...(finish !== undefined ? { finish } : {}),
	};
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
			if (current) current.rows.push(row);
			else current = { turnId: row.id, assistant: [], rows: [row] };
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

/** A running or owed step reads the inbox when it ends. A last step already has. */
function stepAhead(turn: TurnRows): boolean {
	const last = turn.rows.at(-1);
	if (!last) return false;
	if (last.type === "user" || last.type === "synthetic") return true;
	return last.type === "assistant" && (!last.completed || last.finish === "tool-calls");
}

function turnWithPrompt(turns: readonly TurnRows[], promptId: string): TurnRows | undefined {
	return turns.find((turn) =>
		turn.rows.some((row) => row.id === promptId && (row.type === "user" || row.type === "synthetic")),
	);
}

/** Reads the current turn after awaits. */
function heldTurn(thread: ThreadState): ActiveTurn | undefined {
	return thread.active;
}

function activeTurn(turnId: string): ActiveTurn {
	return {
		turnId,
		sawStep: false,
		interrupted: false,
		seenTools: new Set(),
		pendingTexts: new Map(),
	};
}

////////////////////////////////
//  Bridge

export async function startBridge(ports: BridgePorts): Promise<Bridge> {
	const threads = new Map<string, ThreadState>();
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
		if (closed) throw new BridgeFailure("closed", "the OpenCode bridge is closed");
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
		let text: string;
		try {
			text = await response.text();
		} catch {
			throw new BridgeFailure("http", "the OpenCode server is unavailable");
		}
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
		const held = recordOf(data)?.data;
		if (!Array.isArray(held)) throw new BridgeFailure("http", UNREADABLE);
		const next = stringOf(recordOf(recordOf(data)?.cursor)?.next);
		return { rows: held.flatMap((row) => rowOf(row) ?? []), ...(next ? { next } : {}) };
	};

	/** Newest first until the turn, or the newest turn. A whole read throws at the page cap, where a cut splits a turn. */
	const readRows = async (threadId: string, turnId?: string, whole = true): Promise<Row[]> => {
		const pages: Row[][] = [];
		let cursor: string | undefined;
		for (let index = 0; index < HISTORY_MAX_PAGES; index += 1) {
			const page = await readPage(threadId, cursor);
			if (page.rows.length === 0) return pages.flat();
			pages.unshift([...page.rows].reverse());
			const turns = turnsOf(pages.flat());
			if (turnId ? turns.some((turn) => turn.turnId === turnId) : turns.some((turn) => turn.idle))
				return pages.flat();
			if (!page.next) return pages.flat();
			cursor = page.next;
		}
		if (whole) throw new BridgeFailure("http", "the OpenCode session's history is too long to read");
		return pages.flat();
	};

	const readActive = async (): Promise<Set<string>> => {
		const { status, data } = await call("GET", "/api/session/active");
		if (status !== 200) throw httpFailure("reading active sessions", status, data);
		const held = recordOf(recordOf(data)?.data);
		if (!held) throw new BridgeFailure("http", UNREADABLE);
		return new Set(Object.keys(held));
	};

	/** Inbox ids, oldest first. */
	const readInbox = async (threadId: string): Promise<string[]> => {
		const { status, data } = await call("GET", `/api/session/${threadId}/inbox`);
		if (status !== 200) throw httpFailure("reading the inbox", status, data);
		const rows = recordOf(data)?.data;
		if (!Array.isArray(rows)) throw new BridgeFailure("http", UNREADABLE);
		return rows.flatMap((row) => stringOf(recordOf(row)?.id) ?? []);
	};

	/** Undefined when unread. */
	const inboxOf = async (threadId: string): Promise<string[] | undefined> => {
		for (let attempt = 0; attempt < RETRY_TRIES; attempt += 1) {
			if (attempt > 0) await ports.sleep(RETRY_PAUSE_MS);
			try {
				return await readInbox(threadId);
			} catch {
				// Read again.
			}
		}
		return undefined;
	};

	const threadFor = (threadId: string): ThreadState => {
		const held = threads.get(threadId);
		if (!held) throw new BridgeFailure("not_found", "the OpenCode session is not open");
		return held;
	};

	const sendEvent = (event: BridgeEvent): void => {
		if (!closed) send(event);
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

	const queuedFor = (thread: ThreadState, turnId: string): string[] =>
		[...thread.queued].flatMap(([promptId, held]) => (held === turnId ? [promptId] : []));

	const settle = (thread: ThreadState, active: ActiveTurn, terminal: OpencodeTerminal): OpencodeTerminal => {
		thread.active = undefined;
		for (const promptId of queuedFor(thread, active.turnId)) thread.queued.delete(promptId);
		sendEvent({ type: "event", event: "terminal", threadId: thread.id, turnId: active.turnId, terminal });
		return terminal;
	};

	/** True means absent from the inbox, whether or not it was held: OpenCode answers alike. */
	const cancelPrompt = async (threadId: string, promptId: string): Promise<boolean> => {
		try {
			const { status } = await call("DELETE", `/api/session/${threadId}/inbox/${promptId}`);
			return status < 300 || status === 404;
		} catch {
			return false;
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

	/** Undefined while the server runs the turn. Rows come only with its idle row. */
	const endedNow = async (
		thread: ThreadState,
		turnId: string,
	): Promise<{ terminal: OpencodeTerminal; turn?: TurnRows } | undefined> => {
		const running = (await readActive()).has(thread.id);
		// Read rows last to capture an observed end.
		const turn = turnById(turnsOf(await readRows(thread.id, turnId)), turnId);
		if (turn?.idle) return { terminal: terminalOf(turn), turn };
		return running ? undefined : { terminal: LOST };
	};

	/** Serializes turn operations per thread. */
	const serial = <T>(thread: ThreadState, work: () => Promise<T>): Promise<T> => {
		const run = thread.ending.then(work);
		thread.ending = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	const ending = (thread: ThreadState, work: () => Promise<unknown>): Promise<void> =>
		serial(thread, work).then(
			() => undefined,
			() => undefined,
		);

	/** Call inside the chain. A failed turn withdraws its steers, and a completed one fails on a steer it missed. */
	const conclude = async (
		thread: ThreadState,
		active: ActiveTurn,
		terminal: OpencodeTerminal,
		turn?: TurnRows,
	): Promise<OpencodeTerminal | undefined> => {
		if (thread.active !== active) return undefined;
		const held = queuedFor(thread, active.turnId);
		if (terminal.status !== "completed") {
			for (const promptId of held) {
				thread.queued.delete(promptId);
				await cancelPrompt(thread.id, promptId);
			}
			return thread.active === active ? settle(thread, active, terminal) : undefined;
		}
		let missed = held.filter((promptId) => !turn?.rows.some((row) => row.id === promptId));
		if (missed.length > 0 && !turn) {
			// No rows read: out of the inbox, the turn took it.
			const inbox = await inboxOf(thread.id);
			if (inbox) missed = missed.filter((promptId) => inbox.includes(promptId));
		}
		if (missed.length > 0) {
			ports.log("an accepted OpenCode steer was not taken by its turn");
			for (const promptId of missed) await cancelPrompt(thread.id, promptId);
		}
		if (thread.active !== active) return undefined;
		return settle(thread, active, missed.length > 0 ? UNDELIVERED : terminal);
	};

	/** Call inside the chain. */
	const endIfOver = async (thread: ThreadState, active: ActiveTurn): Promise<OpencodeTerminal | undefined> => {
		if (thread.active !== active) return undefined;
		const ended = await endedNow(thread, active.turnId);
		return ended ? conclude(thread, active, ended.terminal, ended.turn) : undefined;
	};

	/** Throws when unread. Inbox before rows, so a step seen after it ends after the prompt arrived. */
	const standingOf = async (thread: ThreadState, turnId: string, promptId: string): Promise<Standing> => {
		let inbox: string[] | undefined;
		let unread: unknown;
		try {
			inbox = await readInbox(thread.id);
		} catch (error) {
			unread = error;
		}
		const turns = turnsOf(await readRows(thread.id, turnId));
		const holder = turnWithPrompt(turns, promptId);
		if (holder) return holder.turnId === turnId ? { at: "taken" } : { at: "elsewhere", holder };
		if (!inbox) throw unread;
		if (!inbox.includes(promptId)) return { at: "unseen" };
		const turn = turnById(turns, turnId);
		if (turn?.idle) return { at: "stranded" };
		if (!(await readActive()).has(thread.id)) return { at: "adrift" };
		return { at: turn && stepAhead(turn) ? "held" : "between" };
	};

	const steerWindow = (): SteerWindow => {
		const window = { over: false };
		void ports.sleep(STEER_WINDOW_MS).then(() => {
			window.over = true;
		});
		return window;
	};

	/** Call inside the chain. Accepts a steer only where its turn will take it. */
	const steer = async (
		thread: ThreadState,
		request: Extract<BridgeRequest, { op: "steer" }>,
		window: SteerWindow,
		limit: AbortSignal,
	): Promise<BridgeResult> => {
		const accepted: BridgeResult = { type: "result", id: request.id, op: "steer" };
		// A repeat of an accepted steer.
		if (thread.queued.get(request.promptId) === request.turnId) return accepted;
		const inactive = new BridgeFailure("turn_inactive", "the OpenCode turn is no longer active");
		const other = heldTurn(thread);
		if (other && other.turnId !== request.turnId) {
			try {
				await endIfOver(thread, other);
			} catch {
				// Refused below.
			}
		}
		if (heldTurn(thread)?.turnId !== request.turnId) {
			if (heldTurn(thread)) throw inactive;
			// Local turn state may lag the server.
			let turn: TurnRows | undefined;
			try {
				const running = (await readActive()).has(thread.id);
				turn = turnById(turnsOf(await readRows(thread.id, request.turnId)), request.turnId);
				if (!running || turn?.idle) turn = undefined;
			} catch {
				// Refused below.
			}
			if (turn && !heldTurn(thread)) adoptTurn(thread, turn);
			if (heldTurn(thread)?.turnId !== request.turnId) throw inactive;
		}
		let standing: Standing | undefined;
		let posted = false;
		let misses = 0;
		let pause = false;
		for (;;) {
			if (pause) await ports.sleep(STEER_POLL_MS);
			pause = true;
			try {
				standing = await standingOf(thread, request.turnId, request.promptId);
			} catch {
				standing = undefined;
			}
			// No posts after timeout.
			if (standing?.at === "unseen" && !posted && limit.aborted) break;
			if (standing?.at === "unseen" && !posted) {
				posted = true;
				let refused: BridgeFailure | undefined;
				try {
					// Repeated prompt ids land once.
					const answer = await call("POST", `/api/session/${request.threadId}/prompt`, {
						id: request.promptId,
						text: request.prompt,
						delivery: "steer",
						resume: true,
					});
					if (answer.status >= 400) refused = httpFailure("steering the turn", answer.status, answer.data);
				} catch {
					// Unanswered: the reads decide.
				}
				if (refused) throw refused;
				pause = false;
				continue;
			}
			if (!standing || standing.at === "unseen") {
				misses += 1;
				if (misses >= RETRY_TRIES) break;
				continue;
			}
			misses = 0;
			// Poll ambiguous states until they settle.
			if (standing.at !== "between" && standing.at !== "adrift") break;
			if (window.over) break;
		}
		const sent = heldTurn(thread)?.turnId === request.turnId ? heldTurn(thread) : undefined;
		if (standing?.at === "taken") return accepted;
		if (sent && !limit.aborted && (standing?.at === "held" || standing?.at === "between")) {
			// A step end takes the prompt.
			thread.queued.set(request.promptId, request.turnId);
			return accepted;
		}
		const ended = new BridgeFailure("turn_ended", "the OpenCode turn ended before the prompt was taken");
		/** The prompt reached an idle session and opened its own turn. */
		const ownTurn = async (holder: TurnRows): Promise<never> => {
			if (sent) await endIfOver(thread, sent);
			if (!holder.idle && !heldTurn(thread)) adoptTurn(thread, holder);
			throw ended;
		};
		if (standing?.at === "elsewhere") return ownTurn(standing.holder);
		if (!posted) throw new BridgeFailure("http", "the OpenCode server is unavailable");
		// Withdrawn, so a repeat cannot land twice.
		const withdrawn = await cancelPrompt(thread.id, request.promptId);
		// Withdrawal can race with delivery.
		let last: Standing | undefined;
		try {
			last = await standingOf(thread, request.turnId, request.promptId);
		} catch {
			// Unread.
		}
		if (last?.at === "taken") return accepted;
		if (last?.at === "elsewhere") return ownTurn(last.holder);
		if (sent && !limit.aborted && last?.at === "held") {
			// The withdrawal failed, and a step is ahead.
			thread.queued.set(request.promptId, request.turnId);
			return accepted;
		}
		if (sent) {
			// End rows decide prompt delivery.
			const over = await endedNow(thread, sent.turnId);
			if (over) {
				const took = over.turn?.rows.some((row) => row.id === request.promptId) ?? false;
				await conclude(thread, sent, over.terminal, over.turn);
				if (took) return accepted;
				throw ended;
			}
		}
		throw new BridgeFailure(
			"http",
			withdrawn && last?.at === "unseen"
				? "the OpenCode server did not confirm the steer, so it was withdrawn"
				: "the OpenCode server did not confirm the steer, so it may still land",
		);
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

	/** Retry unread turn ends. */
	const recheck = (thread: ThreadState, active: ActiveTurn, wait = EVENT_RETRY_MIN_MS): void => {
		void ports.sleep(wait).then(() => {
			if (closed || thread.active !== active) return;
			void serial(thread, () => endIfOver(thread, active)).catch(() =>
				recheck(thread, active, Math.min(wait * 2, EVENT_RETRY_MAX_MS)),
			);
		});
	};

	/** An end event names no turn, so the held turn's rows decide. */
	const finishActive = (
		thread: ThreadState,
		active: ActiveTurn,
		type: string,
		data: Record<string, unknown>,
	): Promise<void> =>
		ending(thread, async () => {
			if (thread.active !== active) return;
			let ended: { terminal: OpencodeTerminal; turn?: TurnRows } | undefined;
			let read = false;
			for (let attempt = 0; attempt < RETRY_TRIES && !ended; attempt += 1) {
				if (attempt > 0) await ports.sleep(RETRY_PAUSE_MS);
				try {
					ended = await endedNow(thread, active.turnId);
					read = true;
				} catch {
					// Read again.
				}
			}
			if (!ended) {
				// Another execution may have ended.
				if (!read) recheck(thread, active);
				return;
			}
			if (!ended.turn) {
				// Without idle rows, use the event outcome.
				ended = undefined;
				if (!active.sawStep) {
					await cancelPrompt(thread.id, active.turnId);
					ended = { terminal: { status: "failed", error: "the OpenCode turn did not start" } };
				}
			}
			await conclude(thread, active, ended?.terminal ?? fallbackTerminal(type, active, data), ended?.turn);
		});

	const adoptRunning = async (thread: ThreadState): Promise<void> => {
		if (thread.active) return;
		try {
			const active = await readActive();
			if (!active.has(thread.id) || thread.active) return;
			const current = turnsOf(await readRows(thread.id)).at(-1);
			if (!current || current.idle || thread.active) return;
			adoptTurn(thread, current);
		} catch {
			// A later event or reconnect retries.
		}
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
				if (inboxId) thread.queued.delete(inboxId);
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

	const reconcile = (thread: ThreadState, active: ActiveTurn): Promise<void> =>
		serial(thread, () => endIfOver(thread, active)).then(
			() => undefined,
			() => recheck(thread, active),
		);

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
				if (thread.active) recheck(thread, thread.active);
				continue;
			}
			if (signal.aborted) return;
			// Clear steers taken offline.
			for (const promptId of [...thread.queued.keys()]) {
				if (turnWithPrompt(turns, promptId)) thread.queued.delete(promptId);
			}
			const active = await readActive();
			if (signal.aborted) return;
			if (active.has(thread.id)) {
				const current = turns.at(-1);
				if (current && !current.idle) {
					if (thread.active?.turnId !== current.turnId) {
						if (thread.active) await reconcile(thread, thread.active);
						if (signal.aborted) return;
						if (!thread.active) adoptTurn(thread, current);
					} else {
						emitToolCounters(thread, thread.active, current);
					}
				}
				continue;
			}
			const held = thread.active;
			if (!held) continue;
			await reconcile(thread, held);
			if (signal.aborted) return;
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
						// Ignore unreadable frames.
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

	/** Answers `late` at the limit. Work already posting may still finish. */
	const bounded = <T>(work: Promise<T>, limit: AbortSignal, late: string): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const expire = (): void => reject(new BridgeFailure("http", late));
			if (limit.aborted) expire();
			else limit.addEventListener("abort", expire, { once: true });
			work.then(resolve, reject).finally(() => limit.removeEventListener("abort", expire));
		});

	/** Call inside the chain. */
	const start = async (
		thread: ThreadState,
		request: Extract<BridgeRequest, { op: "start" }>,
		limit: AbortSignal,
	): Promise<BridgeResult> => {
		const answer = (terminal?: OpencodeTerminal): BridgeResult => ({
			type: "result",
			id: request.id,
			op: "start",
			turnId: request.turnId,
			...(terminal ? { terminal } : {}),
		});
		const stale = heldTurn(thread);
		if (stale && stale.turnId !== request.turnId) {
			try {
				// Only an idle row settles it.
				const own = turnById(turnsOf(await readRows(thread.id, stale.turnId)), stale.turnId);
				if (own?.idle) await conclude(thread, stale, terminalOf(own), own);
			} catch {
				// Stream owns unread turns.
			}
		}
		let holder: TurnRows | undefined;
		let ended: { terminal: OpencodeTerminal; turn?: TurnRows } | undefined;
		try {
			holder = turnWithPrompt(turnsOf(await readRows(thread.id)), request.turnId);
			// A fresh prompt is in no page: the cap ends the search.
			holder ??= turnWithPrompt(turnsOf(await readRows(thread.id, request.turnId, false)), request.turnId);
			if (holder?.turnId === request.turnId)
				ended = holder.idle
					? { terminal: terminalOf(holder), turn: holder }
					: await endedNow(thread, request.turnId);
		} catch (error) {
			// Unread history does not invalidate a held turn.
			if (heldTurn(thread)?.turnId === request.turnId) return answer();
			throw error;
		}
		if (holder && holder.turnId !== request.turnId) {
			// A steer an earlier turn took is answered by that turn's end.
			return answer(
				holder.idle ? terminalOf(holder) : { status: "failed", error: "the OpenCode prompt was already taken" },
			);
		}
		if (holder) {
			const held = heldTurn(thread);
			if (!ended) {
				if (held?.turnId !== request.turnId) adoptTurn(thread, holder);
				return answer();
			}
			const terminal: OpencodeTerminal = ended.turn
				? ended.terminal
				: { status: "failed", error: "the OpenCode turn did not finish" };
			if (held?.turnId !== request.turnId) return answer(terminal);
			return answer((await conclude(thread, held, terminal, ended.turn)) ?? terminal);
		}
		const running = new BridgeFailure("turn_inactive", "the OpenCode thread is still running");
		if (heldTurn(thread) && heldTurn(thread)?.turnId !== request.turnId) throw running;
		// Stale prompts arrive first.
		const left = await inboxOf(thread.id);
		if (!left) throw new BridgeFailure("http", "the OpenCode server is unavailable");
		for (const held of left) {
			if (held !== request.turnId && !(await cancelPrompt(thread.id, held)))
				throw new BridgeFailure("http", "the OpenCode server kept a stale prompt");
		}
		if (heldTurn(thread) && heldTurn(thread)?.turnId !== request.turnId) throw running;
		// No starts after timeout.
		if (limit.aborted) throw new BridgeFailure("http", "the OpenCode server did not answer in time");
		const own = activeTurn(request.turnId);
		thread.active = own;
		const release = (): void => {
			if (thread.active === own) thread.active = undefined;
		};
		let posted: { status: number; data: unknown };
		try {
			posted = await call("POST", `/api/session/${thread.id}/prompt`, {
				id: request.turnId,
				text: request.prompt,
				delivery: "queue",
				resume: true,
			});
		} catch (error) {
			// A lost response leaves delivery uncertain.
			await cancelPrompt(thread.id, request.turnId);
			let began: boolean;
			try {
				began = Boolean(turnWithPrompt(turnsOf(await readRows(thread.id)), request.turnId));
			} catch {
				// Keep uncertain starts active.
				recheck(thread, own);
				return answer();
			}
			if (began) return answer();
			release();
			throw error;
		}
		if (posted.status >= 400) {
			release();
			throw httpFailure("starting the turn", posted.status, posted.data);
		}
		return answer();
	};

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
				threads.set(threadId, {
					id: threadId,
					cwd: request.cwd,
					queued: new Map(),
					ending: Promise.resolve(),
				});
				return { type: "result", id: request.id, op: "open", threadId };
			}
			case "resume": {
				const answer = await call("GET", `/api/session/${request.threadId}`);
				if (answer.status === 404) throw new BridgeFailure("not_found", "the OpenCode session was not found");
				if (answer.status >= 400) throw httpFailure("reading the session", answer.status, answer.data);
				const held = threads.get(request.threadId);
				if (held) held.cwd = request.cwd;
				else
					threads.set(request.threadId, {
						id: request.threadId,
						cwd: request.cwd,
						queued: new Map(),
						ending: Promise.resolve(),
					});
				return { type: "result", id: request.id, op: "resume" };
			}
			case "start": {
				const thread = threadFor(request.threadId);
				const limit = ports.abortAfter(OPERATION_DEADLINE_MS, "start-deadline");
				return bounded(
					serial(thread, () => start(thread, request, limit)),
					limit,
					"the OpenCode server did not answer in time, so the turn may still start",
				);
			}
			case "steer": {
				const thread = threadFor(request.threadId);
				// Both limits include queue time.
				const window = steerWindow();
				const limit = ports.abortAfter(OPERATION_DEADLINE_MS, "steer-deadline");
				return bounded(
					serial(thread, () => steer(thread, request, window, limit)),
					limit,
					"the OpenCode server did not answer in time, so the steer may still land",
				);
			}
			case "interrupt": {
				const thread = threadFor(request.threadId);
				return serial(thread, async () => {
					const active = thread.active;
					if (!active || active.turnId !== request.turnId)
						return { type: "result", id: request.id, op: "interrupt", interrupted: false };
					const answer = await call("POST", `/api/session/${request.threadId}/interrupt?resume=false`);
					if (answer.status >= 400) throw httpFailure("interrupting the turn", answer.status, answer.data);
					const interrupted = recordOf(answer.data)?.interrupted === true;
					if (interrupted) {
						active.interrupted = true;
						await conclude(thread, active, { status: "interrupted" });
					}
					return { type: "result", id: request.id, op: "interrupt", interrupted };
				});
			}
			case "inspect": {
				const thread = threads.get(request.threadId);
				const answer = (inspection: Extract<BridgeResult, { op: "inspect" }>["inspection"]): BridgeResult => ({
					type: "result",
					id: request.id,
					op: "inspect",
					inspection,
				});
				const look = async (): Promise<BridgeResult> => {
					try {
						const held = thread?.active;
						if (thread && held?.turnId === request.turnId) {
							// Settle held turns here or on their event.
							const told = await endIfOver(thread, held);
							return answer(told ? { known: "settled", terminal: told } : { known: "running" });
						}
						const turns = turnsOf(await readRows(request.threadId, request.turnId));
						const turn = turnById(turns, request.turnId);
						if (turn?.idle) return answer({ known: "settled", terminal: terminalOf(turn) });
						if (!turn) return answer({ known: "unknown" });
						const active = await readActive();
						return answer(active.has(request.threadId) ? { known: "running" } : { known: "unknown" });
					} catch {
						return answer({ known: "unknown" });
					}
				};
				return thread ? serial(thread, look) : look();
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
				if (result && !closed) send(result);
			})
			.catch((error: unknown) => {
				if (closed) return;
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
