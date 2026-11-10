// Client for the session's OpenCode server.

import {
	locationQuery,
	OPENCODE_EVENT_TYPES,
	OPENCODE_SERVER_ENV,
	type OpencodeEvent,
	type OpencodeMessageRow,
	type OpencodePermission,
	type OpencodeServerFile,
	OpencodeServerFileSchema,
	opencodeAuth,
	permissionOf,
} from "../../shared/opencode.js";

////////////////////////////////
//  Interfaces & Types

export class OpencodeHttpError extends Error {
	constructor(
		readonly status: number,
		route: string,
	) {
		super(`OpenCode answered HTTP ${status} to ${route}`);
	}
}

export interface OpencodeSnapshot {
	running: boolean;
	permissions: OpencodePermission[];
	/** Newest first. */
	rows: OpencodeMessageRow[];
}

export interface OpencodeClient {
	readonly sessionId: string;
	/** Starts or steers a turn. A repeated id lands once. */
	prompt(id: string, text: string): Promise<void>;
	/** Adds context without starting a turn. */
	synthetic(id: string, text: string, description: string): Promise<void>;
	/** `stale` when the request is no longer pending. */
	replyPermission(
		permission: Pick<OpencodePermission, "id" | "sessionId">,
		decision: "once" | "reject",
		message?: string,
	): Promise<"answered" | "stale">;
	snapshot(signal?: AbortSignal): Promise<OpencodeSnapshot>;
	/** Resolves when the stream ends. */
	events(onEvent: (event: OpencodeEvent) => void, signal: AbortSignal): Promise<void>;
}

////////////////////////////////
//  Constants

const SNAPSHOT_ROWS = 20;
const CALL_TIMEOUT_MS = 15_000;

////////////////////////////////
//  Functions & Helpers

/** The launcher's file, or undefined when this session has none. */
export function readServerFile(
	env: Readonly<Record<string, string | undefined>>,
	readFile: (file: string) => string | undefined,
): OpencodeServerFile | undefined {
	const file = env[OPENCODE_SERVER_ENV];
	const text = file ? readFile(file) : undefined;
	if (!text) return undefined;
	try {
		const parsed = OpencodeServerFileSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

function rowOf(value: unknown): OpencodeMessageRow | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { id, type, error } = value as Record<string, unknown>;
	if (typeof id !== "string" || typeof type !== "string") return undefined;
	const failure = error as { type?: unknown; message?: unknown } | undefined;
	return {
		id,
		type,
		...(typeof failure?.type === "string"
			? { error: { type: failure.type, message: typeof failure.message === "string" ? failure.message : "" } }
			: {}),
	};
}

export function createOpencodeClient(file: OpencodeServerFile, fetcher: typeof fetch): OpencodeClient {
	const headers = { authorization: opencodeAuth(file.password), "content-type": "application/json" };
	const session = `/api/session/${file.sessionId}`;

	/** Bounded unless a stream: a server that never answers must not hold the caller. */
	async function call(method: string, route: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
		return fetcher(`${file.url}${route}`, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
		});
	}

	async function expectOk(method: string, route: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
		const response = await call(method, route, body, signal);
		if (!response.ok) throw new OpencodeHttpError(response.status, route);
		return response;
	}

	async function data(route: string, signal?: AbortSignal): Promise<unknown> {
		const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : undefined;
		return ((await (await expectOk("GET", route, undefined, bounded)).json()) as { data?: unknown }).data;
	}

	return {
		sessionId: file.sessionId,
		prompt: async (id, text) => {
			await expectOk("POST", `${session}/prompt`, { id, text });
		},
		synthetic: async (id, text, description) => {
			await expectOk("POST", `${session}/synthetic`, { id, text, description, resume: false });
		},
		replyPermission: async (permission, decision, message) => {
			const route = `/api/session/${permission.sessionId}/permission/${permission.id}/reply`;
			const response = await call("POST", route, { decision, ...(message ? { message } : {}) });
			if (response.status === 404) return "stale";
			if (!response.ok) throw new OpencodeHttpError(response.status, route);
			return "answered";
		},
		snapshot: async (signal) => {
			const [active, pending, rows] = await Promise.all([
				data("/api/session/active", signal),
				data(`/api/permission/request?${locationQuery(file.directory)}`, signal),
				data(`${session}/message?limit=${SNAPSHOT_ROWS}`, signal),
			]);
			return {
				running: typeof active === "object" && active !== null && file.sessionId in active,
				permissions: (Array.isArray(pending) ? pending : []).flatMap((entry) => permissionOf(entry) ?? []),
				rows: (Array.isArray(rows) ? rows : []).flatMap((entry) => rowOf(entry) ?? []),
			};
		},
		events: async (onEvent, signal) => {
			const types = OPENCODE_EVENT_TYPES.map((type) => `types=${type}`).join("&");
			const response = await call("GET", `/api/event?${types}`, undefined, signal);
			if (!response.ok || !response.body) throw new OpencodeHttpError(response.status, "/api/event");
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				buffer += decoder.decode(chunk, { stream: true });
				for (;;) {
					const cut = buffer.indexOf("\n\n");
					if (cut < 0) break;
					const frame = buffer.slice(0, cut);
					buffer = buffer.slice(cut + 2);
					for (const line of frame.split("\n")) {
						if (!line.startsWith("data:")) continue;
						try {
							const event = JSON.parse(line.slice(5)) as { type?: unknown; data?: unknown };
							if (typeof event.type !== "string") continue;
							onEvent({ type: event.type, data: (event.data ?? {}) as Record<string, unknown> });
						} catch {
							// A frame this build cannot read.
						}
					}
				}
			}
		},
	};
}
