import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AgentChild } from "../mcp/devcontainer/agentTargets.js";
import { CodexAppServerClient, createJsonlTransport, isAppServerFailure } from "../mcp/devcontainer/codexAppServer.js";
import { CODEX_BACKEND } from "../shared/agent-backend.js";

const MODEL = CODEX_BACKEND.defaultModel;

function child(script: (request: Record<string, unknown>, emit: (value: unknown) => void) => void) {
	const stdout = new PassThrough();
	const outbound: unknown[] = [];
	const emit = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
	const stdin = new Writable({
		write(chunk, _encoding, callback) {
			const request = JSON.parse(String(chunk)) as Record<string, unknown>;
			outbound.push(request);
			script(request, emit);
			callback();
		},
	});
	let exit: (info: { code: number | null; signal: string | null }) => void = () => {};
	return {
		child: {
			stdin,
			stdout,
			kill: () => exit({ code: 1, signal: null }),
			onExit(listener: (info: { code: number | null; signal: string | null }) => void) {
				exit = listener;
			},
		} as unknown as AgentChild,
		outbound,
		emit,
		exit: () => exit({ code: 1, signal: null }),
	};
}

function reply(request: Record<string, unknown>, result: unknown) {
	return { jsonrpc: "2.0", id: request.id as number, result };
}

function standard(request: Record<string, unknown>, emit: (value: unknown) => void) {
	switch (request.method) {
		case "initialize":
		case "model/list":
			emit(reply(request, request.method === "model/list" ? { data: [{ id: MODEL }] } : {}));
			return;
		case "thread/start":
			emit(reply(request, { thread: { id: "thread-1" } }));
			return;
		case "turn/start":
			emit(reply(request, { turn: { id: "turn-1", status: "inProgress", items: [] } }));
			return;
		default:
			emit(reply(request, {}));
	}
}

describe("Codex App Server JSONL transport", () => {
	it("settles a request from its matching response", async () => {
		const f = child((request, emit) => emit(reply(request, { value: 7 })));
		await expect(createJsonlTransport(f.child).request("thread/read", {})).resolves.toEqual({ value: 7 });
	});

	it("reassembles split bytes and forwards notifications as values", async () => {
		const f = child(() => {});
		const transport = createJsonlTransport(f.child);
		const events: unknown[] = [];
		transport.onEvent((event) => events.push(event));
		f.child.stdout.emit("data", Buffer.from('{"jsonrpc":"2.0","method":"turn/started","params":'));
		f.child.stdout.emit("data", Buffer.from("{}}\n"));
		await new Promise((resolve) => setImmediate(resolve));
		expect(events).toEqual([{ jsonrpc: "2.0", method: "turn/started", params: {} }]);
	});

	it("returns protocol-shaped answers for supported and unknown server requests", async () => {
		const f = child(() => {});
		const transport = createJsonlTransport(f.child);
		f.emit({ jsonrpc: "2.0", id: 1, method: "permission/request", params: {} });
		f.emit({ jsonrpc: "2.0", id: 2, method: "future/request", params: {} });
		await new Promise((resolve) => setImmediate(resolve));
		expect(f.outbound).toEqual([
			{ jsonrpc: "2.0", id: 1, result: { granted: false } },
			{ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "unsupported request: future/request" } },
		]);
		void transport;
	});

	it("classifies refused, unreadable, timeout, and closed requests", async () => {
		vi.useFakeTimers();
		try {
			const refused = child((request, emit) =>
				emit({ jsonrpc: "2.0", id: request.id, error: { code: -1, message: "refused", data: { x: 1 } } }),
			);
			const refusedResult = await createJsonlTransport(refused.child)
				.request("x", {})
				.catch((error) => error);
			expect(refusedResult).toMatchObject({ kind: "refused", code: -1, data: { x: 1 } });

			const unreadable = child((request, emit) =>
				emit({ jsonrpc: "2.0", id: request.id, result: {}, error: null }),
			);
			const unreadableResult = await createJsonlTransport(unreadable.child)
				.request("x", {})
				.catch((error) => error);
			expect(unreadableResult).toMatchObject({ kind: "unreadable" });

			const silent = child(() => {});
			const silentTransport = createJsonlTransport(silent.child);
			const timed = silentTransport.request("x", {}).catch((error) => error);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(await timed).toMatchObject({ kind: "timeout" });

			const closed = child(() => {});
			const closedTransport = createJsonlTransport(closed.child);
			const pending = closedTransport.request("x", {}).catch((error) => error);
			closed.exit();
			expect(await pending).toMatchObject({ kind: "closed" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("handshakes, validates the model, and sends typed thread and turn requests", async () => {
		const f = child(standard);
		const client = await CodexAppServerClient.open(createJsonlTransport(f.child), MODEL);
		const thread = await client.startThread({ cwd: "/workspace/app" });
		await client.startTurn(thread, "inspect", () => {}, { outputSchema: { type: "object" } });
		await client.steerTurn(thread, "turn-1", "continue");
		await client.interruptTurn(thread, "turn-1");

		expect(f.outbound.map((request) => (request as { method: string }).method)).toEqual([
			"initialize",
			"initialized",
			"model/list",
			"thread/start",
			"turn/start",
			"turn/steer",
			"turn/interrupt",
		]);
		expect((f.outbound[4] as { params: unknown }).params).toEqual({
			threadId: "thread-1",
			input: [{ type: "text", text: "inspect" }],
			outputSchema: { type: "object" },
		});
		expect((f.outbound[5] as { params: unknown }).params).toMatchObject({ expectedTurnId: "turn-1" });
	});

	it("deletes a thread, says gone for one with no rollout, and throws any other refusal", async () => {
		const held = new Set(["thread-kept"]);
		const f = child((request, emit) => {
			if (request.method !== "thread/delete") return standard(request, emit);
			const threadId = (request.params as { threadId: string }).threadId;
			if (held.delete(threadId)) return emit(reply(request, {}));
			const message =
				threadId === "thread-locked" ? "thread is locked" : `no rollout found for thread id ${threadId}`;
			emit({ jsonrpc: "2.0", id: request.id, error: { code: -32600, message } });
		});
		const client = await CodexAppServerClient.open(createJsonlTransport(f.child), MODEL);

		await expect(client.deleteThread("thread-kept")).resolves.toBe("deleted");
		await expect(client.deleteThread("thread-kept")).resolves.toBe("gone");
		await expect(client.deleteThread("thread-locked")).rejects.toThrow();
	});

	it("lists every thread across pages, archived or not, and throws rather than answer part of a store", async () => {
		const pages: Record<string, { data: unknown[]; nextCursor?: string }> = {
			"false:": { data: [{ id: "t1", updatedAt: 1_700_000_000 }], nextCursor: "next" },
			"false:next": { data: [{ id: "t2", updatedAt: 0 }] },
			"true:": { data: [{ id: "t3" }] },
		};
		const asked: unknown[] = [];
		const f = child((request, emit) => {
			if (request.method !== "thread/list") return standard(request, emit);
			const params = request.params as { archived: boolean; cursor: string | null; sourceKinds: string[] };
			asked.push(params.sourceKinds.length);
			emit(reply(request, pages[`${params.archived}:${params.cursor ?? ""}`] ?? { data: [] }));
		});
		const client = await CodexAppServerClient.open(createJsonlTransport(f.child), MODEL);

		await expect(client.listThreads()).resolves.toEqual([
			{ threadId: "t1", updatedAt: 1_700_000_000_000, parentId: null },
			{ threadId: "t2", updatedAt: null, parentId: null },
			{ threadId: "t3", updatedAt: null, parentId: null },
		]);
		// Every door a thread is made through.
		expect(asked.every((kinds) => kinds === 10)).toBe(true);

		pages["true:"] = { data: [{ updatedAt: 5 }] };
		await expect(client.listThreads()).rejects.toThrow();
	});

	it("rejects an unoffered model and preserves the failure brand", async () => {
		const missing = child((request, emit) =>
			emit(reply(request, request.method === "model/list" ? { data: [] } : {})),
		);
		await expect(CodexAppServerClient.open(createJsonlTransport(missing.child), "missing-model")).rejects.toThrow();

		const dead = child(() => {});
		const transport = createJsonlTransport(dead.child);
		const pending = transport.request("x", {}).catch((error) => error);
		dead.exit();
		expect(isAppServerFailure(await pending)).toBe(true);
	});
});
