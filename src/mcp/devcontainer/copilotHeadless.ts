// Copilot's own protocol, the one its SDK speaks: JSON-RPC over the headless CLI's stdio. A send
// answers at once with a message id; the turn's events follow, and `session.idle` ends it.

import { AGENT_ACTIVITY_MAX_BYTES, cutUtf8 } from "../../shared/agent-record.js";
import type { ListedThread } from "../../shared/host-op.js";
import type { AgentChild } from "./agentTargets.js";

////////////////////////////////
//  Interfaces & Types

export interface HeadlessNotification {
	method: string;
	params?: unknown;
}

export interface HeadlessTransport {
	request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
	notify(method: string, params: unknown): void;
	onNotification(listener: (notification: HeadlessNotification) => void): void;
	close(): void;
}

/** One `session.event` notification's event, as the runtime sends it. */
export interface SessionEvent {
	type: string;
	data?: Record<string, unknown>;
}

export interface HeadlessModel {
	id: string;
	reasoningEfforts: string[];
	/** The account's policy state; absent when none applies. */
	policy?: string;
}

export type HeadlessTerminal =
	| { status: "completed"; finalResponse: string }
	| { status: "failed"; error: string }
	| { status: "interrupted" };

export interface SendOptions {
	/** `immediate` interjects into the running turn. */
	mode?: "enqueue" | "immediate";
	/** A JSON Schema the provider holds the turn's answer to. */
	outputSchema?: unknown;
}

////////////////////////////////
//  Constants

export const COPILOT_PROTOCOL_VERSION = 3;
const METHOD_NOT_FOUND = -32601;
const REQUEST_TIMEOUT_MS = 60_000;
const HEADER_END = "\r\n\r\n";
const CLIENT_NAME = "switchboard";
// Server reply for an absent session.
const NO_SESSION = /not found/i;
const COMMAND_NOTE_CHARS = 160;

////////////////////////////////
//  Transport

function frame(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}${HEADER_END}`, "ascii"), body]);
}

/** The whole frames in `buffered`, and the bytes after them. */
export function splitFrames(buffered: Buffer): { bodies: string[]; rest: Buffer } {
	const bodies: string[] = [];
	let rest = buffered;
	for (;;) {
		const headerEnd = rest.indexOf(HEADER_END);
		if (headerEnd < 0) break;
		const length = /content-length:\s*(\d+)/i.exec(rest.subarray(0, headerEnd).toString("ascii"));
		const start = headerEnd + HEADER_END.length;
		if (!length) {
			rest = rest.subarray(start);
			continue;
		}
		const end = start + Number(length[1]);
		if (rest.length < end) break;
		bodies.push(rest.subarray(start, end).toString("utf8"));
		rest = rest.subarray(end);
	}
	return { bodies, rest };
}

export function createHeadlessTransport(child: AgentChild): HeadlessTransport {
	let nextId = 1;
	let buffered: Buffer = Buffer.alloc(0);
	let closed = false;
	const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	const listeners: Array<(notification: HeadlessNotification) => void> = [];

	const rejectPending = (error: Error): void => {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	};

	const write = (message: unknown): void => {
		if (closed) return;
		try {
			child.stdin.write(frame(message));
		} catch {
			closed = true;
		}
	};

	const handle = (body: string): void => {
		let message: unknown;
		try {
			message = JSON.parse(body);
		} catch {
			return;
		}
		if (typeof message !== "object" || message === null || Array.isArray(message)) return;
		const record = message as Record<string, unknown>;
		const id = record.id;
		if (id !== undefined && record.method === undefined) {
			const waiter = pending.get(String(id));
			if (!waiter) return;
			pending.delete(String(id));
			if (record.error && typeof record.error === "object") {
				const error = record.error as { message?: unknown };
				waiter.reject(new Error(typeof error.message === "string" ? error.message : `Copilot request failed`));
			} else {
				waiter.resolve(record.result);
			}
			return;
		}
		if (id !== undefined && typeof record.method === "string") {
			// No handler is configured, so the runtime asks nothing a client must answer.
			write({
				jsonrpc: "2.0",
				id,
				error: { code: METHOD_NOT_FOUND, message: `unsupported request: ${record.method}` },
			});
			return;
		}
		if (typeof record.method === "string") {
			const notification = { method: record.method, params: record.params };
			queueMicrotask(() => {
				for (const listener of listeners) listener(notification);
			});
		}
	};

	child.stdout.on("data", (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		const { bodies, rest } = splitFrames(buffered);
		buffered = rest;
		for (const body of bodies) handle(body);
	});
	child.stdout.on("error", () => {});
	child.stdin.on("error", () => {});
	child.onExit((info) => {
		closed = true;
		rejectPending(new Error(info.reason === "authFailed" ? `Copilot login required` : `Copilot exited`));
	});

	return {
		request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
			if (closed) return Promise.reject(new Error(`Copilot exited`));
			const id = nextId++;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(String(id));
					reject(new Error(`timed out: ${method}`));
				}, timeoutMs);
				pending.set(String(id), {
					resolve: (value) => {
						clearTimeout(timer);
						resolve(value);
					},
					reject: (error) => {
						clearTimeout(timer);
						reject(error);
					},
				});
				write({ jsonrpc: "2.0", id, method, params });
			});
		},
		notify(method, params) {
			write({ jsonrpc: "2.0", method, params });
		},
		onNotification(listener) {
			listeners.push(listener);
		},
		close() {
			if (closed) return;
			closed = true;
			rejectPending(new Error(`Copilot closed`));
			child.kill();
		},
	};
}

////////////////////////////////
//  Client

export class CopilotHeadlessClient {
	private constructor(private readonly transport: HeadlessTransport) {}

	/** Refuses a runtime speaking another protocol version before any session is opened. */
	static async open(transport: HeadlessTransport): Promise<CopilotHeadlessClient> {
		const pong = (await transport.request("ping", {})) as { protocolVersion?: unknown } | undefined;
		if (pong?.protocolVersion !== COPILOT_PROTOCOL_VERSION) {
			throw new Error(
				`unsupported Copilot protocol version ${String(pong?.protocolVersion)}: Copilot CLI 1.0.106 or newer is required`,
			);
		}
		return new CopilotHeadlessClient(transport);
	}

	/** Every session's events, by session id. */
	onEvent(listener: (sessionId: string, event: SessionEvent) => void): void {
		this.transport.onNotification(({ method, params }) => {
			if (method !== "session.event" || typeof params !== "object" || params === null) return;
			const { sessionId, event } = params as { sessionId?: unknown; event?: unknown };
			if (typeof sessionId !== "string" || typeof event !== "object" || event === null) return;
			const typed = event as { type?: unknown; data?: unknown };
			if (typeof typed.type !== "string") return;
			const data =
				typeof typed.data === "object" && typed.data !== null
					? (typed.data as Record<string, unknown>)
					: undefined;
			listener(sessionId, { type: typed.type, data });
		});
	}

	async listModels(): Promise<HeadlessModel[]> {
		const result = (await this.transport.request("models.list", {})) as { models?: unknown } | undefined;
		if (!Array.isArray(result?.models)) return [];
		return result.models.flatMap((entry): HeadlessModel[] => {
			if (typeof entry !== "object" || entry === null) return [];
			const { id, supportedReasoningEfforts, policy } = entry as {
				id?: unknown;
				supportedReasoningEfforts?: unknown;
				policy?: { state?: unknown };
			};
			if (typeof id !== "string") return [];
			const reasoningEfforts = Array.isArray(supportedReasoningEfforts)
				? supportedReasoningEfforts.filter((effort): effort is string => typeof effort === "string")
				: [];
			const state = typeof policy?.state === "string" ? { policy: policy.state } : {};
			return [{ id, reasoningEfforts, ...state }];
		});
	}

	/** Created in allow-all mode, as the delegating session itself runs. */
	async createSession(options: { cwd: string; model?: string; reasoningEffort?: string }): Promise<string> {
		const result = (await this.transport.request("session.create", {
			workingDirectory: options.cwd,
			clientName: CLIENT_NAME,
			streaming: false,
			...(options.model === undefined ? {} : { model: options.model }),
			...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
		})) as { sessionId?: unknown } | undefined;
		const sessionId = result?.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error(`Copilot returned no session ID`);
		await this.allowAll(sessionId);
		return sessionId;
	}

	async resumeSession(sessionId: string, cwd: string): Promise<void> {
		await this.transport.request("session.resume", {
			sessionId,
			workingDirectory: cwd,
			clientName: CLIENT_NAME,
			streaming: false,
		});
		await this.allowAll(sessionId);
	}

	/** Tools, paths and URLs alike; approve-all alone leaves a read outside the directory denied. */
	private async allowAll(sessionId: string): Promise<void> {
		await this.transport.request("session.permissions.setMode", { sessionId, mode: "allow-all" });
	}

	/** Answers the message id; the turn ends with `session.idle`. */
	async send(sessionId: string, prompt: string, options: SendOptions = {}): Promise<string> {
		const result = (await this.transport.request("session.send", {
			sessionId,
			prompt,
			...(options.mode === undefined ? {} : { mode: options.mode }),
			...(options.outputSchema === undefined
				? {}
				: {
						responseFormat: {
							type: "json_schema",
							jsonSchema: { name: "answer", schema: options.outputSchema, strict: true },
						},
					}),
		})) as { messageId?: unknown } | undefined;
		return typeof result?.messageId === "string" ? result.messageId : "";
	}

	steer(sessionId: string, prompt: string): Promise<string> {
		return this.send(sessionId, prompt, { mode: "immediate" });
	}

	async abort(sessionId: string): Promise<void> {
		await this.transport.request("session.abort", { sessionId, reason: "remote_command" });
	}

	async listSessions(): Promise<ListedThread[]> {
		const result = (await this.transport.request("session.list", {})) as { sessions?: unknown } | undefined;
		if (!Array.isArray(result?.sessions)) throw new Error("Copilot answered no session list");
		return (result.sessions as Array<{ sessionId?: unknown; modifiedTime?: unknown }>).map((held) => {
			if (typeof held?.sessionId !== "string" || !held.sessionId)
				throw new Error("Copilot listed a session with no id");
			const at = typeof held.modifiedTime === "string" ? Date.parse(held.modifiedTime) : Number.NaN;
			return { threadId: held.sessionId, updatedAt: Number.isFinite(at) ? at : null, parentId: null };
		});
	}

	/** Missing sessions return `gone`. Other refusals throw. */
	async deleteSession(sessionId: string): Promise<"deleted" | "gone"> {
		const result = (await this.transport.request("session.delete", { sessionId })) as
			| { success?: unknown; error?: unknown }
			| undefined;
		if (result?.success === true) return "deleted";
		const reason = typeof result?.error === "string" ? result.error : "";
		if (NO_SESSION.test(reason)) return "gone";
		throw new Error(`Copilot would not delete the session${reason ? `: ${reason.slice(0, 200)}` : ""}`);
	}

	close(): void {
		this.transport.close();
	}
}

export async function defaultOpenCopilotClient(child: AgentChild): Promise<CopilotHeadlessClient> {
	const transport = createHeadlessTransport(child);
	try {
		return await CopilotHeadlessClient.open(transport);
	} catch (error) {
		transport.close();
		throw error;
	}
}

////////////////////////////////
//  Turn fold

const bounded = (text: string): string => cutUtf8(text, AGENT_ACTIVITY_MAX_BYTES);

/** The command a shell tool was given, or the tool's own description. */
function commandOf(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const { command, description } = args as { command?: unknown; description?: unknown };
	const text = typeof command === "string" ? command : typeof description === "string" ? description : "";
	return text.replace(/\s+/g, " ").trim().slice(0, COMMAND_NOTE_CHARS);
}

/** Copilot's message with its error type and status, which name a policy refusal. */
function errorText(data: Record<string, unknown>): string {
	const message = typeof data.message === "string" && data.message ? data.message : "Copilot reported an error";
	const kind = typeof data.errorType === "string" && data.errorType ? data.errorType : null;
	const status = typeof data.statusCode === "number" ? `HTTP ${data.statusCode}` : null;
	const why = [kind, status].filter((part) => part !== null);
	return why.length > 0 ? `${message} (${why.join(", ")})` : message;
}

/**
 * One turn's events folded: notes as they come, and the terminal at `session.idle`. An error a
 * later assistant message follows was recovered from; one the turn ends on fails it.
 */
export class HeadlessTurn {
	private lastMessage = "";
	private error: string | undefined;
	private aborted = false;

	/** The notes this event tells, in order. */
	fold(event: SessionEvent): string[] {
		const data = event.data ?? {};
		switch (event.type) {
			case "assistant.message": {
				const content = typeof data.content === "string" ? data.content.trim() : "";
				if (!content) return [];
				this.lastMessage = content;
				this.error = undefined;
				return [bounded(content)];
			}
			case "tool.execution_start": {
				const name = typeof data.toolName === "string" ? data.toolName : `tool`;
				const command = commandOf(data.arguments);
				return [bounded(command ? `${name}: ${command}` : name)];
			}
			case "session.error": {
				const message = errorText(data);
				this.error = message;
				return [bounded(message)];
			}
			case "abort":
				this.aborted = true;
				return [];
			default:
				return [];
		}
	}

	/** The terminal when `event` ends the turn, else undefined. */
	settle(event: SessionEvent): HeadlessTerminal | undefined {
		if (event.type !== "session.idle") return undefined;
		if (this.aborted || event.data?.aborted === true) return { status: "interrupted" };
		if (this.error !== undefined) return { status: "failed", error: this.error };
		return { status: "completed", finalResponse: this.lastMessage };
	}
}
