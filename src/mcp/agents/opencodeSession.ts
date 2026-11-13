// OpenCode's driver: JSON lines to its bridge, which runs the server and speaks HTTP.

import crypto from "node:crypto";
import { OPENCODE_BACKEND } from "../../shared/agent-backend.js";
import type { AgentDaemonFailureCode } from "../../shared/agent-state.js";
import { promptIdOf } from "../../shared/opencode.js";
import {
	type BridgeMessage,
	BridgeMessageSchema,
	type BridgeResult,
	promptForSchema,
} from "../../shared/opencode-agent.js";
import type { AgentChild } from "../devcontainer/agentTargets.js";
import type {
	AgentBackendSession,
	AgentModel,
	ThreadOptions,
	TurnCounter,
	TurnHandle,
	TurnInspection,
	TurnOptions,
	TurnTerminal,
} from "./backendSession.js";

////////////////////////////////
//  Interfaces & Types

type RequestBody =
	| { op: "open"; cwd: string; model: string }
	| { op: "resume"; threadId: string; cwd: string }
	| { op: "start"; threadId: string; turnId: string; prompt: string }
	| { op: "steer"; threadId: string; turnId: string; promptId: string; prompt: string }
	| { op: "interrupt"; threadId: string; turnId: string }
	| { op: "inspect"; threadId: string; turnId: string }
	| { op: "delete"; threadId: string }
	| { op: "models" };

interface PendingRequest {
	resolve(result: BridgeResult): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

interface TurnRecord {
	settle(terminal: TurnTerminal): void;
}

////////////////////////////////
//  Constants

// Past the bridge's own server start and stream connect.
const READY_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
// Past the bridge's own deadline for a start or a steer.
const TURN_REQUEST_TIMEOUT_MS = 90_000;

////////////////////////////////
//  Functions & Helpers

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).trim() || "OpenCode turn failed";
}

function mintedTurnId(): string {
	return `msg_sb${crypto.randomBytes(20).toString("hex")}`;
}

export function opencodeFailureCode(error: string): AgentDaemonFailureCode {
	if (/version|outside the supported range|protocol|incompatible/i.test(error)) return "protocol_incompatible";
	if (/auth|login|unauthori[sz]ed|credential/i.test(error)) return "authentication_required";
	if (/binary|not installed|container|target|unavailable/i.test(error)) return "daemon_unavailable";
	if (/timed out|timeout|exited|closed|broken pipe|server|event stream/i.test(error)) return "app_server_unavailable";
	return "protocol_error";
}

////////////////////////////////
//  Class

/** One OpenCode bridge child. */
export class OpencodeBackendSession implements AgentBackendSession {
	private readonly pending = new Map<string, PendingRequest>();
	private readonly turns = new Map<string, TurnRecord>();
	private buffer = "";
	private nextId = 0;
	private ready = false;
	private closed = false;
	private readyResolve: ((version: string) => void) | undefined;
	private readyReject: ((error: Error) => void) | undefined;
	private activityListener: ((turnId: string, text: string, itemId?: string) => void) | undefined;
	private counterListener: ((turnId: string, counter: TurnCounter) => void) | undefined;
	private progressListener: ((turnId: string) => void) | undefined;
	private closedListener: (() => void) | undefined;
	private closedNotified = false;

	private constructor(private readonly child: AgentChild) {}

	static async open(child: AgentChild): Promise<OpencodeBackendSession> {
		const session = new OpencodeBackendSession(child);
		child.stdout.on("data", (chunk: Buffer) => session.receive(chunk.toString("utf8")));
		child.stdout.on("error", () => {});
		child.stdin.on("error", () => {});
		child.onExit(() => session.onExit());
		await session.awaitReady();
		return session;
	}

	onActivity(listener: (turnId: string, text: string, itemId?: string) => void): void {
		this.activityListener = listener;
	}

	onCounter(listener: (turnId: string, counter: TurnCounter) => void): void {
		this.counterListener = listener;
	}

	onProgress(listener: (turnId: string) => void): void {
		this.progressListener = listener;
	}

	onClosed(listener: () => void): void {
		this.closedListener = listener;
		if (this.closed) listener();
	}
	async listModels(): Promise<AgentModel[]> {
		const result = await this.request({ op: "models" });
		if (result.op !== "models") throw new Error("OpenCode bridge answered the wrong operation");
		return result.models;
	}

	async openThread(options: ThreadOptions): Promise<string> {
		const result = await this.request({
			op: "open",
			cwd: options.cwd,
			model: options.model ?? OPENCODE_BACKEND.defaultModel,
		});
		if (result.op !== "open") throw new Error("OpenCode bridge answered the wrong operation");
		return result.threadId;
	}

	async resumeThread(threadId: string, cwd: string): Promise<void> {
		const result = await this.request({ op: "resume", threadId, cwd });
		if (result.op !== "resume") throw new Error("OpenCode bridge answered the wrong operation");
	}

	async deleteThread(threadId: string): Promise<"deleted" | "gone"> {
		const result = await this.request({ op: "delete", threadId });
		if (result.op !== "delete") throw new Error("OpenCode bridge answered the wrong operation");
		return result.outcome;
	}

	async startTurn(threadId: string, prompt: string, turn: TurnOptions = {}): Promise<TurnHandle> {
		const turnId = turn.key ? promptIdOf(turn.key) : mintedTurnId();
		const text = turn.outputSchema ? promptForSchema(prompt, turn.outputSchema) : prompt;
		let settle: (terminal: TurnTerminal) => void = () => undefined;
		const settled = new Promise<TurnTerminal>((resolve) => {
			settle = resolve;
		});
		this.turns.set(turnId, { settle });
		try {
			const result = await this.request({ op: "start", threadId, turnId, prompt: text }, TURN_REQUEST_TIMEOUT_MS);
			if (result.op !== "start") throw new Error("OpenCode bridge answered the wrong operation");
			if (result.terminal) this.settleTurn(turnId, result.terminal);
		} catch (error) {
			this.settleTurn(turnId, { status: "failed", error: errorText(error) });
		}
		return { turnId, settled };
	}

	/** The bridge accepts steers when queued or taken. */
	async steerTurn(threadId: string, turnId: string, prompt: string, key?: string): Promise<"taken"> {
		const promptId = key ? promptIdOf(key) : mintedTurnId();
		const result = await this.request({ op: "steer", threadId, turnId, promptId, prompt }, TURN_REQUEST_TIMEOUT_MS);
		if (result.op !== "steer") throw new Error("OpenCode bridge answered the wrong operation");
		return "taken";
	}

	async interruptTurn(threadId: string, turnId: string): Promise<void> {
		const result = await this.request({ op: "interrupt", threadId, turnId });
		if (result.op !== "interrupt") throw new Error("OpenCode bridge answered the wrong operation");
	}

	async inspectTurn(threadId: string, turnId: string): Promise<TurnInspection> {
		try {
			const result = await this.request({ op: "inspect", threadId, turnId });
			if (result.op !== "inspect") return { known: "unknown" };
			return result.inspection;
		} catch {
			return { known: "unknown" };
		}
	}

	close(): void {
		this.closed = true;
		this.settleAll({ status: "failed", error: "OpenCode session closed" });
		try {
			this.child.kill();
		} catch {
			// Already gone.
		}
		this.notifyClosed();
	}

	/** Bounded: a bridge that never speaks must not hold its target's commands. */
	private awaitReady(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.readyResolve = undefined;
				this.readyReject = undefined;
				reject(new Error("OpenCode bridge did not become ready"));
			}, READY_TIMEOUT_MS);
			timer.unref?.();
			this.readyResolve = () => {
				clearTimeout(timer);
				resolve();
			};
			this.readyReject = (error) => {
				clearTimeout(timer);
				reject(error);
			};
		});
	}

	private receive(text: string): void {
		this.buffer += text;
		for (;;) {
			const cut = this.buffer.indexOf("\n");
			if (cut < 0) break;
			const line = this.buffer.slice(0, cut).trim();
			this.buffer = this.buffer.slice(cut + 1);
			if (line) this.handle(line);
		}
	}

	private handle(line: string): void {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			return;
		}
		const parsed = BridgeMessageSchema.safeParse(raw);
		if (!parsed.success) return;
		const message = parsed.data;
		if (message.type === "ready") {
			if (this.ready) return;
			if (!message.ok) {
				this.readyReject?.(new Error(`${message.code}: ${message.message}`));
				this.readyReject = undefined;
				this.readyResolve = undefined;
				return;
			}
			this.ready = true;
			this.readyResolve?.(message.version);
			this.readyResolve = undefined;
			this.readyReject = undefined;
			return;
		}
		if (message.type === "result") {
			const held = this.pending.get(message.id);
			if (!held) return;
			this.pending.delete(message.id);
			clearTimeout(held.timer);
			held.resolve(message);
			return;
		}
		if (message.type === "error") {
			const held = this.pending.get(message.id);
			if (!held) return;
			this.pending.delete(message.id);
			clearTimeout(held.timer);
			held.reject(new Error(`${message.code}: ${message.message}`));
			return;
		}
		this.onEvent(message);
	}

	private onEvent(message: Extract<BridgeMessage, { type: "event" }>): void {
		if (message.event === "activity") {
			this.activityListener?.(message.turnId, message.text, message.itemId);
			return;
		}
		if (message.event === "counter") {
			this.counterListener?.(message.turnId, {
				kind: message.counterKind,
				...(message.itemId === undefined ? {} : { itemId: message.itemId }),
			});
			return;
		}
		if (message.event === "progress") {
			this.progressListener?.(message.turnId);
			return;
		}
		this.settleTurn(message.turnId, message.terminal);
	}

	private request(body: RequestBody, timeoutMs = REQUEST_TIMEOUT_MS): Promise<BridgeResult> {
		if (this.closed) return Promise.reject(new Error("OpenCode session is closed"));
		const id = `req-${++this.nextId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("OpenCode bridge request timed out"));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.child.stdin.write(`${JSON.stringify({ type: "request", id, ...body })}\n`);
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error("OpenCode bridge is closed"));
			}
		});
	}

	private settleTurn(turnId: string, terminal: TurnTerminal): void {
		const held = this.turns.get(turnId);
		if (!held) return;
		this.turns.delete(turnId);
		held.settle(terminal);
	}

	private settleAll(terminal: TurnTerminal): void {
		for (const [turnId, held] of [...this.turns]) {
			this.turns.delete(turnId);
			held.settle(terminal);
		}
		for (const [id, held] of [...this.pending]) {
			this.pending.delete(id);
			clearTimeout(held.timer);
			held.reject(new Error("OpenCode bridge exited"));
		}
	}

	private onExit(): void {
		if (this.closed) return;
		this.closed = true;
		this.settleAll({ status: "failed", error: "OpenCode exited" });
		if (!this.ready) this.readyReject?.(new Error("OpenCode bridge exited before ready"));
		this.readyResolve = undefined;
		this.readyReject = undefined;
		this.notifyClosed();
	}

	private notifyClosed(): void {
		if (this.closedNotified) return;
		this.closedNotified = true;
		this.closedListener?.();
	}
}
