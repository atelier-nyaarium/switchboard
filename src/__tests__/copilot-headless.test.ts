import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AgentChild } from "../mcp/devcontainer/agentTargets.js";
import {
	CopilotHeadlessClient,
	createHeadlessTransport,
	HeadlessTurn,
	type SessionEvent,
	splitFrames,
} from "../mcp/devcontainer/copilotHeadless.js";

function framed(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`), body]);
}

function fakeChild() {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const written: Record<string, unknown>[] = [];
	let pending: Buffer = Buffer.alloc(0);
	stdin.on("data", (chunk: Buffer) => {
		pending = Buffer.concat([pending, chunk]);
		const { bodies, rest } = splitFrames(pending);
		pending = rest;
		for (const body of bodies) written.push(JSON.parse(body));
	});
	let onExit: (info: { code: number | null; signal: string | null }) => void = () => {};
	const child: AgentChild = {
		stdin,
		stdout,
		kill: () => {},
		onExit(listener) {
			onExit = listener;
		},
	};
	return {
		child,
		written,
		feed(message: unknown) {
			stdout.write(framed(message));
		},
		feedBytes(bytes: Buffer) {
			stdout.write(bytes);
		},
		exit() {
			onExit({ code: 1, signal: null });
		},
	};
}

async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

const event = (type: string, data: Record<string, unknown> = {}): SessionEvent => ({ type, data });

describe("Copilot headless client", () => {
	it("opens on protocol version 3, creates an allow-all session, then sends, steers and aborts", async () => {
		const context = fakeChild();
		const transport = createHeadlessTransport(context.child);
		const open = CopilotHeadlessClient.open(transport);
		await tick();
		expect(context.written).toMatchObject([{ id: 1, method: "ping" }]);
		context.feed({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 3 } });
		const client = await open;
		const events: Array<[string, SessionEvent]> = [];
		client.onEvent((sessionId, received) => events.push([sessionId, received]));

		const created = client.createSession({
			cwd: "/workspace/project",
			model: "gpt-6-luna",
			reasoningEffort: "low",
		});
		await tick();
		expect(context.written.at(-1)).toMatchObject({
			id: 2,
			method: "session.create",
			params: {
				workingDirectory: "/workspace/project",
				model: "gpt-6-luna",
				reasoningEffort: "low",
				streaming: false,
			},
		});
		context.feed({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } });
		await tick();
		expect(context.written.at(-1)).toMatchObject({
			id: 3,
			method: "session.permissions.setMode",
			params: { sessionId: "session-1", mode: "allow-all" },
		});
		context.feed({ jsonrpc: "2.0", id: 3, result: { success: true } });
		expect(await created).toBe("session-1");

		const sent = client.send("session-1", "Hello.", { outputSchema: { type: "object" } });
		await tick();
		expect(context.written.at(-1)).toMatchObject({
			id: 4,
			method: "session.send",
			params: {
				sessionId: "session-1",
				prompt: "Hello.",
				responseFormat: {
					type: "json_schema",
					jsonSchema: { name: "answer", schema: { type: "object" }, strict: true },
				},
			},
		});
		context.feed({
			jsonrpc: "2.0",
			method: "session.event",
			params: { sessionId: "session-1", event: { type: "assistant.message", data: { content: "Hi." } } },
		});
		context.feed({ jsonrpc: "2.0", id: 4, result: { messageId: "message-1" } });
		expect(await sent).toBe("message-1");
		await tick();
		expect(events).toEqual([["session-1", { type: "assistant.message", data: { content: "Hi." } }]]);

		void client.steer("session-1", "Faster.");
		void client.abort("session-1");
		await tick();
		expect(context.written.slice(-2)).toMatchObject([
			{ method: "session.send", params: { sessionId: "session-1", prompt: "Faster.", mode: "immediate" } },
			{ method: "session.abort", params: { sessionId: "session-1", reason: "remote_command" } },
		]);
	});

	it("refuses another protocol version before any session exists", async () => {
		const context = fakeChild();
		const open = CopilotHeadlessClient.open(createHeadlessTransport(context.child));
		await tick();
		context.feed({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 2 } });
		await expect(open).rejects.toThrow(/protocol version 2/);
		expect(context.written).toHaveLength(1);
	});

	it("reads a frame split across chunks and answers a runtime request as unsupported", async () => {
		const context = fakeChild();
		const transport = createHeadlessTransport(context.child);
		const pong = transport.request("ping", {});
		const bytes = framed({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 3 } });
		context.feedBytes(bytes.subarray(0, 20));
		await tick();
		context.feedBytes(bytes.subarray(20));
		expect(await pong).toEqual({ protocolVersion: 3 });

		context.feed({ jsonrpc: "2.0", id: "r1", method: "userInput.request", params: {} });
		await tick();
		expect(context.written.at(-1)).toMatchObject({ id: "r1", error: { code: -32601 } });
	});

	it("fails what is pending when the child exits", async () => {
		const context = fakeChild();
		const pong = createHeadlessTransport(context.child).request("ping", {});
		context.exit();
		await expect(pong).rejects.toThrow(/exited/);
	});
});

describe("HeadlessTurn", () => {
	it("notes each message and tool call, and completes on idle with the last message", () => {
		const turn = new HeadlessTurn();
		expect(turn.fold(event("assistant.message", { content: "Reading." }))).toEqual(["Reading."]);
		expect(
			turn.fold(event("tool.execution_start", { toolName: "bash", arguments: { command: "cat  a.ts" } })),
		).toEqual(["bash: cat a.ts"]);
		expect(turn.fold(event("assistant.message", { content: "" }))).toEqual([]);
		expect(turn.fold(event("assistant.message", { content: "Done." }))).toEqual(["Done."]);
		expect(turn.settle(event("assistant.turn_end"))).toBeUndefined();
		expect(turn.settle(event("session.idle"))).toEqual({ status: "completed", finalResponse: "Done." });
	});

	it("fails on an error the turn ends on, not on one a message followed", () => {
		const recovered = new HeadlessTurn();
		recovered.fold(event("session.error", { message: "rate limited" }));
		recovered.fold(event("assistant.message", { content: "Fine now." }));
		expect(recovered.settle(event("session.idle"))).toEqual({ status: "completed", finalResponse: "Fine now." });

		const failed = new HeadlessTurn();
		expect(failed.fold(event("session.error", { message: "quota" }))).toEqual(["quota"]);
		expect(failed.settle(event("session.idle"))).toEqual({ status: "failed", error: "quota" });
	});

	it("interrupts on an abort or an aborted idle", () => {
		const aborted = new HeadlessTurn();
		aborted.fold(event("abort", { reason: "remote_command" }));
		expect(aborted.settle(event("session.idle"))).toEqual({ status: "interrupted" });
		expect(new HeadlessTurn().settle(event("session.idle", { aborted: true }))).toEqual({ status: "interrupted" });
	});
});
