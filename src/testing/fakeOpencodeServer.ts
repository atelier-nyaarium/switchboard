// OpenCode's local server as its clients see it, as a `fetch` function.

import { OPENCODE_MCP_NAME, opencodeAuth } from "../shared/opencode.js";

////////////////////////////////
//  Interfaces & Types

export interface FakeOpencodeError {
	type: string;
	message: string;
}

export interface FakeOpencodeMessage {
	id: string;
	type: string;
	text?: string;
	description?: string;
	content?: Array<{ type?: string; text?: string }>;
	outcome?: "succeeded" | "failed" | "interrupted";
	status?: "completed" | "failed";
	error?: FakeOpencodeError;
}

export interface FakeOpencodePermission {
	id: string;
	sessionID: string;
	action: string;
	resources: string[];
}

export interface FakeOpencodeReply {
	id: string;
	sessionID: string;
	decision: string;
	message?: string;
}

export interface FakeOpencodeServerOptions {
	url?: string;
	password?: string;
	models?: Array<{ id: string; providerID: string }>;
}

export interface FakeOpencodeServer {
	url: string;
	password: string;
	fetch: typeof fetch;
	/** Every request taken, in order. */
	requests: Array<{ method: string; route: string; body?: unknown }>;
	/** Every permission reply taken. */
	replies: FakeOpencodeReply[];
	addSession(id: string, directory?: string): void;
	sessionOf(id: string): { directory: string; model?: unknown } | undefined;
	/** Oldest first. */
	messages(sessionId: string): FakeOpencodeMessage[];
	/** Pending request ids, oldest first. */
	pending(): string[];
	/** Open event streams. */
	streams(): number;
	/** Reaches open streams only. */
	emit(type: string, data: Record<string, unknown>): void;
	/** Ends every open stream; `reset` errors it instead. */
	cutStreams(how?: "close" | "reset"): void;
	/** Delivers the oldest pending inbox item; answers its id. */
	deliverNext(sessionId: string): string | undefined;
	/** The pending inbox ids, oldest first. */
	inbox(sessionId: string): string[];
	/** Adds a tool row to the running turn's history, without an event. */
	tool(sessionId: string, id: string, name: string): void;
	/** Adds a synthetic row to the running turn's history, without an event. */
	synthetic(sessionId: string, id: string, text?: string): void;
	/** The models this fake offers. */
	models(): Array<{ id: string; providerID: string }>;
	/** Holds the next answer on this route. */
	stallNext(route: string, computed?: "arrival" | "release"): { release(): void };
	finishTurn(sessionId: string, error?: FakeOpencodeError, finalText?: string): void;
	ask(permission: FakeOpencodePermission): void;
	/** Answers its row's id. */
	/** `quiet` loses its start events. */
	startCompaction(sessionId: string, how?: { quiet?: boolean }): string;
	/** `midTurn` keeps its execution running; `quiet` loses its end event. */
	finishCompaction(sessionId: string, how?: { error?: FakeOpencodeError; midTurn?: boolean; quiet?: boolean }): void;
	/** `booting` lists no server yet. */
	setMcp(status: "booting" | "connected" | "failed", error?: string): void;
	/** The next requests answer this status and change nothing. */
	failNext(status: number, times?: number): void;
}

interface Session {
	directory: string;
	model?: unknown;
	rows: FakeOpencodeMessage[];
	inbox: Array<{ row: FakeOpencodeMessage; delivery: "steer" | "queue" }>;
	running: boolean;
}

interface Stream {
	types: Set<string>;
	controller: ReadableStreamDefaultController<Uint8Array>;
}

////////////////////////////////
//  Functions & Helpers

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createFakeOpencodeServer(options: FakeOpencodeServerOptions = {}): FakeOpencodeServer {
	const url = options.url ?? "http://127.0.0.1:41999";
	const password = options.password ?? "fake-opencode-password";
	const models = options.models ?? [
		{ id: "longcat-2.5-free", providerID: "opencode-go" },
		{ id: "deepseek-v4-pro", providerID: "opencode-go" },
	];
	const sessions = new Map<string, Session>();
	const permissions: FakeOpencodePermission[] = [];
	const streams = new Set<Stream>();
	const requests: FakeOpencodeServer["requests"] = [];
	const replies: FakeOpencodeReply[] = [];
	const encoder = new TextEncoder();
	let mcp: { status: "booting" | "connected" | "failed"; error?: string } = { status: "connected" };
	let failing: { status: number; left: number } | null = null;
	const stalls: Array<{ route: string; computed: "arrival" | "release"; released: Promise<void> }> = [];
	let minted = 0;

	const mint = (prefix: string): string => `${prefix}_fake${String(++minted).padStart(4, "0")}`;

	const write = (stream: Stream, type: string, data: Record<string, unknown>): void => {
		// The filter never drops the opening event.
		if (type !== "server.connected" && stream.types.size > 0 && !stream.types.has(type)) return;
		stream.controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: mint("evt"), type, data })}\n\n`));
	};

	const emit = (type: string, data: Record<string, unknown>): void => {
		for (const stream of streams) write(stream, type, data);
	};

	const need = (sessionId: string): Session => {
		const held = sessions.get(sessionId);
		if (!held) throw new Error(`the fake holds no session ${sessionId}`);
		return held;
	};

	const openStream = (types: string[], signal: AbortSignal | null | undefined): Response => {
		let stream: Stream | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				stream = { types: new Set(types), controller };
				streams.add(stream);
				write(stream, "server.connected", {});
			},
			cancel() {
				if (stream) streams.delete(stream);
			},
		});
		signal?.addEventListener("abort", () => {
			if (!stream || !streams.delete(stream)) return;
			stream.controller.error(new DOMException("the request was aborted", "AbortError"));
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};

	const startTurn = (session: Session, sessionId: string): void => {
		session.running = true;
		emit("session.execution.started", { sessionID: sessionId });
		emit("session.step.started", { sessionID: sessionId });
	};

	const deliver = (session: Session, sessionId: string, at = 0): string | undefined => {
		const [item] = session.inbox.splice(at, 1);
		if (!item) return undefined;
		session.rows.push(item.row);
		emit("session.inbox.delivered", { sessionID: sessionId, inboxID: item.row.id });
		if (!session.running) startTurn(session, sessionId);
		return item.row.id;
	};

	const takePrompt = (session: Session, sessionId: string, body: Record<string, unknown>): Response => {
		const id = String(body.id);
		const text = String(body.text ?? "");
		const delivery = body.delivery === "queue" ? "queue" : body.delivery === "steer" ? "steer" : undefined;
		const resume = body.resume !== false;
		const first = session.rows.find((row) => row.id === id);
		if (first) {
			// A repeat still runs empty.
			if (!session.running) {
				session.rows.push({ id: mint("msg"), type: "idle", outcome: "succeeded" });
				emit("session.execution.started", { sessionID: sessionId });
				emit("session.execution.succeeded", { sessionID: sessionId });
			}
			return json({ data: first });
		}
		const held = session.inbox.find((item) => item.row.id === id);
		if (held) {
			if (resume && !session.running) deliver(session, sessionId, session.inbox.indexOf(held));
			return json({ data: held.row });
		}
		const row: FakeOpencodeMessage = { id, type: "user", text };
		if (delivery !== undefined || body.resume === false) {
			session.inbox.push({ row, delivery: delivery ?? "steer" });
			emit("session.inbox.enqueued", {
				sessionID: sessionId,
				inboxID: id,
				item: { type: "user", payload: { text }, delivery: delivery ?? "steer" },
				delivery: delivery ?? "steer",
			});
			if (resume && !session.running) deliver(session, sessionId, session.inbox.length - 1);
			return json({ data: row });
		}
		session.rows.push(row);
		// Mid-turn, it steers.
		if (!session.running) startTurn(session, sessionId);
		return json({ data: row });
	};

	const route = (method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): Response => {
		if (method === "POST" && path === "/api/session") {
			const id = String(body.id);
			if (!id.startsWith("ses")) return json({ error: "bad session id" }, 400);
			const directory = String((body.location as { directory?: unknown } | undefined)?.directory ?? "");
			sessions.set(id, {
				directory,
				rows: [],
				inbox: [],
				running: false,
				...("model" in body ? { model: body.model } : {}),
			});
			return json({ data: { id } });
		}
		if (method === "GET" && path === "/api/session/active") {
			const running = [...sessions].filter(([, session]) => session.running);
			return json({ data: Object.fromEntries(running.map(([id]) => [id, { type: "running" }])) });
		}
		if (method === "GET" && path === "/api/permission/request") return json({ data: [...permissions] });
		if (method === "GET" && path === "/api/model") {
			return json({
				location: { directory: String(query.get("location[directory]") ?? "") },
				data: models.map((model) => ({
					...model,
					name: model.id,
					canonical: `${model.providerID}/${model.id}`,
					enabled: true,
					capabilities: { tools: true, input: ["text"], output: ["text"] },
					variants: [],
					cost: [],
					limit: { context: 1, output: 1 },
					time: { released: 0 },
				})),
			});
		}
		if (method === "GET" && path === "/api/mcp") {
			if (mcp.status === "booting") return json({ data: [] });
			const status = { status: mcp.status, ...(mcp.error ? { error: mcp.error } : {}) };
			return json({ data: [{ name: OPENCODE_MCP_NAME, status }] });
		}
		if (method === "POST" && path === `/api/experimental/mcp/${OPENCODE_MCP_NAME}/connect`) {
			mcp = { status: "connected" };
			return json({ data: {} });
		}
		const reply = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(path);
		if (method === "POST" && reply) {
			const at = permissions.findIndex((held) => held.id === reply[2] && held.sessionID === reply[1]);
			if (at < 0) return json({ error: "PermissionNotFoundError" }, 404);
			permissions.splice(at, 1);
			const decision = String(body.decision);
			replies.push({
				id: reply[2] as string,
				sessionID: reply[1] as string,
				decision,
				...(typeof body.message === "string" ? { message: body.message } : {}),
			});
			emit("permission.replied", { sessionID: reply[1], requestID: reply[2], reply: decision });
			return json({ data: {} });
		}
		const inboxItem = /^\/api\/session\/([^/]+)\/inbox\/([^/]+)$/.exec(path);
		if (inboxItem) {
			const session = sessions.get(inboxItem[1] as string);
			if (!session) return json({ error: "NotFoundError" }, 404);
			const item = session.inbox.find((held) => held.row.id === inboxItem[2]);
			if (!item) return json({ error: "NotFoundError" }, 404);
			if (method === "PATCH") {
				const delivery = body.delivery === "queue" ? "queue" : "steer";
				item.delivery = delivery;
				if (delivery === "steer" && !session.running)
					deliver(session, inboxItem[1] as string, session.inbox.indexOf(item));
				return new Response(null, { status: 204 });
			}
			if (method === "DELETE") {
				session.inbox.splice(session.inbox.indexOf(item), 1);
				return new Response(null, { status: 204 });
			}
			return json({ error: "no such route" }, 404);
		}
		const scoped = /^\/api\/session\/([^/]+)(\/[a-z]+)?$/.exec(path);
		if (!scoped) return json({ error: "no such route" }, 404);
		const sessionId = scoped[1] as string;
		const session = sessions.get(sessionId);
		if (!session) return json({ error: "NotFoundError" }, 404);
		if (method === "GET" && scoped[2] === undefined) return json({ data: { id: sessionId } });
		if (method === "GET" && scoped[2] === "/inbox") return json({ data: session.inbox.map((item) => item.row) });
		if (method === "POST" && scoped[2] === "/interrupt") {
			const wasRunning = session.running;
			if (wasRunning) {
				session.running = false;
				session.rows.push({ id: mint("msg"), type: "idle", outcome: "interrupted" });
				emit("session.execution.interrupted", { sessionID: sessionId });
				if (query.get("resume") === "true") deliver(session, sessionId);
			}
			return json({ interrupted: wasRunning });
		}
		if (method === "GET" && scoped[2] === "/message") {
			const limit = Number(query.get("limit") ?? session.rows.length);
			const cursor = query.get("cursor");
			if (cursor) {
				const at = /^idx:(\d+)$/.exec(cursor);
				const end = at ? Math.min(Number(at[1]), session.rows.length) : 0;
				const start = Math.max(0, end - limit);
				return json({
					data: session.rows.slice(start, end).reverse(),
					cursor: {
						previous: end < session.rows.length ? `idx:${end}` : null,
						next: start > 0 ? `idx:${start}` : null,
					},
				});
			}
			if (query.get("order") === "asc") {
				const end = Math.min(limit, session.rows.length);
				return json({
					data: session.rows.slice(0, end),
					cursor: { previous: null, next: end < session.rows.length ? `idx:${end}` : null },
				});
			}
			const start = Math.max(0, session.rows.length - limit);
			return json({
				data: session.rows.slice(start).reverse(),
				cursor: { previous: null, next: start > 0 ? `idx:${start}` : null },
			});
		}
		if (method === "POST" && scoped[2] === "/prompt") {
			if (!String(body.id).startsWith("msg_")) return json({ error: "bad message id" }, 400);
			return takePrompt(session, sessionId, body);
		}
		if (method === "POST" && scoped[2] === "/synthetic") {
			// A repeat lands once.
			const held = session.rows.find((row) => row.id === body.id);
			if (held) return json({ data: held });
			const row: FakeOpencodeMessage = {
				id: String(body.id),
				type: "synthetic",
				text: String(body.text ?? ""),
				description: String(body.description ?? ""),
			};
			session.rows.push(row);
			// `resume` true starts a turn.
			if (body.resume !== false && !session.running) {
				session.running = true;
				emit("session.execution.started", { sessionID: sessionId });
				emit("session.step.started", { sessionID: sessionId });
			}
			return json({ data: row });
		}
		return json({ error: "no such route" }, 404);
	};

	const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const target = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
		const method = (init?.method ?? "GET").toUpperCase();
		const text = typeof init?.body === "string" ? init.body : undefined;
		const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
		requests.push({ method, route: `${target.pathname}${target.search}`, ...(text ? { body } : {}) });
		if (`${target.protocol}//${target.host}` !== url) throw new TypeError("fetch failed: nothing listens there");
		if (new Headers(init?.headers).get("authorization") !== opencodeAuth(password)) {
			return json({ error: "unauthorized" }, 401);
		}
		if (failing) {
			const { status } = failing;
			failing.left -= 1;
			if (failing.left <= 0) failing = null;
			return json({ error: "scripted failure" }, status);
		}
		if (method === "GET" && target.pathname === "/api/event") {
			return openStream(target.searchParams.getAll("types"), init?.signal);
		}
		const at = stalls.findIndex((held) => held.route === target.pathname);
		const stall = at >= 0 ? stalls.splice(at, 1)[0] : undefined;
		if (stall?.computed === "release") await stall.released;
		const answer = route(method, target.pathname, target.searchParams, body);
		if (stall?.computed === "arrival") await stall.released;
		return answer;
	};

	return {
		url,
		password,
		fetch: fetchFake as typeof fetch,
		requests,
		replies,
		addSession: (id, directory = "/fake/project") => {
			sessions.set(id, { directory, rows: [], inbox: [], running: false });
		},
		sessionOf: (id) => {
			const held = sessions.get(id);
			return held ? { directory: held.directory, ...("model" in held ? { model: held.model } : {}) } : undefined;
		},
		messages: (sessionId) => [...need(sessionId).rows],
		pending: () => permissions.map((held) => held.id),
		streams: () => streams.size,
		emit,
		cutStreams: (how = "close") => {
			for (const stream of [...streams]) {
				streams.delete(stream);
				if (how === "reset") stream.controller.error(new TypeError("terminated"));
				else stream.controller.close();
			}
		},
		deliverNext: (sessionId) => deliver(need(sessionId), sessionId),
		inbox: (sessionId) => need(sessionId).inbox.map((item) => item.row.id),
		tool: (sessionId, id, name) => {
			const session = need(sessionId);
			const part = { type: "tool", id, name, state: { status: "running" } };
			const last = session.rows.at(-1);
			if (last?.type === "assistant") last.content = [...(last.content ?? []), part];
			else session.rows.push({ id: mint("msg"), type: "assistant", content: [part] });
		},
		synthetic: (sessionId, id, text = id) => {
			need(sessionId).rows.push({ id, type: "synthetic", text });
		},
		models: () => models.map((model) => ({ ...model })),
		stallNext: (route, computed = "arrival") => {
			let release: () => void = () => undefined;
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			stalls.push({ route, computed, released });
			return { release };
		},
		finishTurn: (sessionId, error, finalText) => {
			const session = need(sessionId);
			session.running = false;
			session.rows.push({
				id: mint("msg"),
				type: "assistant",
				...(finalText === undefined ? {} : { content: [{ type: "text", text: finalText }] }),
			});
			session.rows.push({
				id: mint("msg"),
				type: "idle",
				outcome: error ? "failed" : "succeeded",
				...(error ? { error } : {}),
			});
			if (error) emit("session.execution.failed", { sessionID: sessionId, error });
			else emit("session.execution.succeeded", { sessionID: sessionId });
		},
		ask: (permission) => {
			permissions.push(permission);
			emit("permission.asked", { ...permission });
		},
		startCompaction: (sessionId, how = {}) => {
			const session = need(sessionId);
			const id = mint("msg");
			session.running = true;
			// Its row exists from the start.
			session.rows.push({ id, type: "compaction" });
			if (how.quiet) return id;
			emit("session.execution.started", { sessionID: sessionId });
			emit("session.compaction.started", { sessionID: sessionId, reason: "manual", inputID: id });
			return id;
		},
		finishCompaction: (sessionId, how = {}) => {
			const { error, midTurn, quiet } = how;
			const session = need(sessionId);
			const row = session.rows.findLast((held) => held.type === "compaction" && held.status === undefined);
			if (!row) throw new Error(`no compaction runs in ${sessionId}`);
			row.status = error ? "failed" : "completed";
			if (error) row.error = error;
			const told = { sessionID: sessionId, reason: "manual", inputID: row.id };
			if (!quiet && error) emit("session.compaction.failed", { ...told, error });
			if (!quiet && !error) emit("session.compaction.ended", told);
			if (midTurn) return;
			session.running = false;
			session.rows.push({ id: mint("msg"), type: "idle", outcome: "succeeded" });
			emit("session.execution.succeeded", { sessionID: sessionId });
		},
		setMcp: (status, error) => {
			mcp = { status, ...(error ? { error } : {}) };
		},
		failNext: (status, times = 1) => {
			failing = { status, left: times };
		},
	};
}
