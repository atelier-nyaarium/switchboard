import { describe, expect, it } from "vitest";
import { startBridge } from "../opencode-agent/bridge.js";
import { promptIdOf } from "../shared/opencode.js";
import { type BridgeMessage, BridgeMessageSchema } from "../shared/opencode-agent.js";
import { createFakeOpencodeServer } from "../testing/fakeOpencodeServer.js";

const PASSWORD = "0123456789abcdef0123456789abcdef";
const URL = "http://127.0.0.1:41999";
const MODEL = "opencode-go/longcat-2.5-free";

function waitFor<T>(read: () => T | undefined, timeoutMs = 1_000): Promise<T> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			const found = read();
			if (found !== undefined) {
				resolve(found);
				return;
			}
			if (Date.now() - start >= timeoutMs) {
				reject(new Error("timed out"));
				return;
			}
			setTimeout(tick, 5);
		};
		tick();
	});
}

async function rig(
	options: { steerWaitMs?: number; abortOn?: string; sleep?: (ms: number) => Promise<void> | undefined } = {},
) {
	const server = createFakeOpencodeServer({ url: URL, password: PASSWORD });
	const lines: BridgeMessage[] = [];
	let aborted = false;
	const bridge = await startBridge(
		{
			env: { PATH: "/bin" },
			home: "/home/test",
			isExecutable: () => true,
			readVersion: async () => "opencode v2.2.5",
			startServer: () => ({
				url: Promise.resolve(server.url),
				exited: new Promise<void>(() => undefined),
				errorTail: () => "",
				stop: () => undefined,
			}),
			fetch: ((input, init) =>
				init?.signal?.aborted
					? Promise.reject(new DOMException("aborted", "AbortError"))
					: server.fetch(input, init)) as typeof fetch,
			abortAfter: (_ms, route) => {
				const controller = new AbortController();
				if (options.abortOn && !aborted && route.includes(options.abortOn)) {
					aborted = true;
					controller.abort();
				}
				return controller.signal;
			},
			randomHex: () => PASSWORD,
			sleep: (ms) => options.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))),
			write: (line) => {
				const parsed = BridgeMessageSchema.safeParse(JSON.parse(line));
				if (parsed.success) lines.push(parsed.data);
			},
			log: () => undefined,
		},
		options,
	);
	let next = 0;
	const send = (body: Record<string, unknown>): string => {
		const id = `req-${++next}`;
		bridge.receive(JSON.stringify({ type: "request", id, ...body }));
		return id;
	};
	const result = (id: string) => waitFor(() => lines.find((line) => line.type === "result" && line.id === id));
	const error = (id: string) => waitFor(() => lines.find((line) => line.type === "error" && line.id === id));
	const events = () => lines.filter((line) => line.type === "event");
	const ready = lines[0];
	return { server, bridge, lines, send, result, error, events, ready };
}

async function open(r: Awaited<ReturnType<typeof rig>>): Promise<string> {
	const id = r.send({ op: "open", cwd: "/fake/project", model: MODEL });
	const answer = await r.result(id);
	if (answer.type !== "result" || answer.op !== "open") throw new Error("open failed");
	return answer.threadId;
}

describe("the OpenCode bridge", () => {
	it("opens a thread and lists the models it offers", async () => {
		const r = await rig();
		expect(r.ready).toMatchObject({ type: "ready", ok: true, version: "2.2.5" });
		const threadId = await open(r);
		expect(threadId).toMatch(/^ses_sb[0-9a-f]+$/);

		const models = await r.result(r.send({ op: "models" }));
		expect(models).toMatchObject({
			type: "result",
			op: "models",
			models: [{ id: MODEL }, { id: "opencode-go/deepseek-v4-pro" }],
		});
		r.bridge.closed();
		await r.bridge.done;
	});

	it("resumes a held thread and refuses a missing one", async () => {
		const r = await rig();
		const threadId = await open(r);
		const held = await r.result(r.send({ op: "resume", threadId, cwd: "/fake/project" }));
		expect(held).toMatchObject({ type: "result", op: "resume" });
		const missing = await r.error(r.send({ op: "resume", threadId: "ses_sbmissing", cwd: "/fake/project" }));
		expect(missing).toMatchObject({ type: "error", code: "not_found" });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("refuses a model the server does not offer", async () => {
		const r = await rig();
		const answer = await r.error(r.send({ op: "open", cwd: "/fake/project", model: "opencode-go/not-a-model" }));
		expect(answer).toMatchObject({
			type: "error",
			code: "model_not_offered",
			message: "model opencode-go/not-a-model is not offered by OpenCode",
		});
		r.bridge.closed();
		await r.bridge.done;
	});

	it("says a running turn is alive once per interval, whatever the server said", async () => {
		let nextInterval: () => void = () => {};
		const r = await rig({
			sleep: (ms) =>
				ms === 15_000
					? new Promise<void>((resolve) => {
							nextInterval = resolve;
						})
					: undefined,
		});
		const threadId = await open(r);
		const turnId = promptIdOf("turn-one");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const alive = () => r.events().filter((event) => event.type === "event" && event.event === "progress");
		const counted = () => r.events().filter((event) => event.type === "event" && event.event === "counter");
		// A counter marks everything before it as read.
		const tool = (id: string) =>
			r.server.emit("session.tool.input.started", {
				sessionID: threadId,
				assistantMessageID: "msg_a",
				id,
				name: "read",
			});

		r.server.emit("session.tool.progress", { sessionID: threadId, id: "call_0" });
		r.server.emit("session.tool.progress", { sessionID: threadId, id: "call_0" });
		tool("call_1");
		await waitFor(() => (counted().length === 1 ? true : undefined));
		expect(alive()).toEqual([{ type: "event", event: "progress", threadId, turnId }]);

		nextInterval();
		await Promise.resolve();
		r.server.emit("session.tool.progress", { sessionID: threadId, id: "call_0" });
		tool("call_2");
		await waitFor(() => (counted().length === 2 ? true : undefined));
		expect(alive()).toHaveLength(2);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("runs a turn: commentary, a tool counter, the final answer", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-one");
		const started = await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		expect(started).toMatchObject({ type: "result", op: "start", turnId });

		r.server.emit("session.text.ended", {
			sessionID: threadId,
			assistantMessageID: "msg_a",
			ordinal: 0,
			text: "Reading the parser.",
		});
		r.server.emit("session.tool.input.started", {
			sessionID: threadId,
			assistantMessageID: "msg_a",
			id: "call_1",
			name: "read",
		});
		const activity = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "activity"),
		);
		expect(activity).toMatchObject({ event: "activity", text: "Reading the parser.", itemId: "msg_a:0" });
		const counter = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "counter"),
		);
		expect(counter).toMatchObject({ event: "counter", counterKind: "read", itemId: "call_1" });

		r.server.finishTurn(threadId, undefined, "Done.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({
			event: "terminal",
			turnId,
			terminal: { status: "completed", finalResponse: "Done." },
		});
		r.bridge.closed();
		await r.bridge.done;
	});

	it("carries a failed turn's error", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-failed");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		r.server.finishTurn(threadId, { type: "provider.auth", message: "login required" });
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({
			event: "terminal",
			terminal: { status: "failed", error: "login required" },
		});
		r.bridge.closed();
		await r.bridge.done;
	});

	it("settles an interrupted turn", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-interrupt");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const answer = await r.result(r.send({ op: "interrupt", threadId, turnId }));
		expect(answer).toMatchObject({ type: "result", op: "interrupt", interrupted: true });
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ event: "terminal", terminal: { status: "interrupted" } });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("resolves a steer once its turn takes it", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-steer");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("steer-key");
		const steerId = r.send({
			op: "steer",
			threadId,
			turnId,
			promptId,
			prompt: "Also this",
		});
		await waitFor(() => (r.server.inbox(threadId).includes(promptId) ? true : undefined));
		r.server.deliverNext(threadId);
		await expect(r.result(steerId)).resolves.toMatchObject({ type: "result", op: "steer" });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("rejects a steer its turn ended without, then starts exactly one turn for that key", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-miss");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const key = "missed-key";
		const promptId = promptIdOf(key);
		const steerId = r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also this" });
		await waitFor(() => (r.server.inbox(threadId).includes(promptId) ? true : undefined));
		r.server.finishTurn(threadId);
		await expect(r.error(steerId)).resolves.toMatchObject({ type: "error", code: "turn_ended" });

		const adoptedId = r.send({
			op: "start",
			threadId,
			turnId: promptId,
			prompt: "Also this",
		});
		await expect(r.result(adoptedId)).resolves.toMatchObject({ type: "result", op: "start" });
		expect(r.server.messages(threadId).filter((row) => row.id === promptId)).toHaveLength(1);
		r.server.finishTurn(threadId, undefined, "Done.");
		const terminal = await waitFor(() =>
			r
				.events()
				.find((event) => event.type === "event" && event.event === "terminal" && event.turnId === promptId),
		);
		expect(terminal).toMatchObject({
			event: "terminal",
			terminal: { status: "completed", finalResponse: "Done." },
		});
		r.bridge.closed();
		await r.bridge.done;
	});

	it("inspects a running, a settled and an unknown turn", async () => {
		const r = await rig();
		const threadId = await open(r);
		const runningId = promptIdOf("turn-running");
		await r.result(r.send({ op: "start", threadId, turnId: runningId, prompt: "Review" }));
		const running = await r.result(r.send({ op: "inspect", threadId, turnId: runningId }));
		expect(running).toMatchObject({ type: "result", op: "inspect", inspection: { known: "running" } });

		r.server.finishTurn(threadId, undefined, "Done.");
		const settled = await r.result(r.send({ op: "inspect", threadId, turnId: runningId }));
		expect(settled).toMatchObject({
			type: "result",
			op: "inspect",
			inspection: { known: "settled", terminal: { status: "completed", finalResponse: "Done." } },
		});
		const unknown = await r.result(r.send({ op: "inspect", threadId, turnId: "msg_missing" }));
		expect(unknown).toMatchObject({ type: "result", op: "inspect", inspection: { known: "unknown" } });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("settles a cut stream from a fresh read", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-cut");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		r.server.cutStreams("reset");
		r.server.finishTurn(threadId, undefined, "After the cut.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({
			event: "terminal",
			terminal: { status: "completed", finalResponse: "After the cut." },
		});
		r.bridge.closed();
		await r.bridge.done;
	});

	it("rejects a steer whose prompt opened another turn, after the old terminal", async () => {
		const r = await rig();
		const threadId = await open(r);
		const oldId = promptIdOf("old-turn");
		await r.result(r.send({ op: "start", threadId, turnId: oldId, prompt: "Review" }));
		const promptId = promptIdOf("late-steer");
		const steerId = r.send({ op: "steer", threadId, turnId: oldId, promptId, prompt: "Late" });
		await waitFor(() => (r.server.inbox(threadId).includes(promptId) ? true : undefined));
		r.server.cutStreams("reset");
		r.server.finishTurn(threadId);
		r.server.deliverNext(threadId);
		const error = await r.error(steerId);
		expect(error).toMatchObject({ type: "error", code: "turn_ended" });
		const terminalAt = r.lines.findIndex(
			(line) => line.type === "event" && line.event === "terminal" && line.turnId === oldId,
		);
		expect(terminalAt).toBeGreaterThanOrEqual(0);
		expect(terminalAt).toBeLessThan(r.lines.indexOf(error));

		const adopted = await r.result(r.send({ op: "start", threadId, turnId: promptId, prompt: "Late" }));
		expect(adopted).toMatchObject({ type: "result", op: "start", turnId: promptId });
		r.server.finishTurn(threadId, undefined, "Done.");
		const terminal = await waitFor(() =>
			r
				.events()
				.find((event) => event.type === "event" && event.event === "terminal" && event.turnId === promptId),
		);
		expect(terminal).toMatchObject({ terminal: { status: "completed", finalResponse: "Done." } });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("resolves a steer delivered while the stream was down", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("resync-turn");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("resync-steer");
		const steerId = r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also" });
		await waitFor(() => (r.server.inbox(threadId).includes(promptId) ? true : undefined));
		r.server.cutStreams("reset");
		r.server.deliverNext(threadId);
		await expect(r.result(steerId)).resolves.toMatchObject({ type: "result", op: "steer" });
		r.server.finishTurn(threadId);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("withdraws a timed-out steer so it cannot land later", async () => {
		const r = await rig({ steerWaitMs: 200 });
		const threadId = await open(r);
		const turnId = promptIdOf("timeout-turn");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("timeout-steer");
		const steerId = r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also" });
		await waitFor(() => (r.server.inbox(threadId).includes(promptId) ? true : undefined));
		await expect(r.error(steerId)).resolves.toMatchObject({ type: "error", code: "turn_ended" });
		await waitFor(() => (r.server.inbox(threadId).includes(promptId) ? undefined : true));
		expect(r.server.inbox(threadId)).toEqual([]);
		r.server.finishTurn(threadId);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("emits counters for tool rows missed across a reconnect", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("counter-turn");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		r.server.emit("session.tool.input.started", {
			sessionID: threadId,
			assistantMessageID: "msg_a",
			id: "call_1",
			name: "read",
		});
		await waitFor(() =>
			r
				.events()
				.some((event) => event.type === "event" && event.event === "counter" && event.itemId === "call_1"),
		);
		r.server.tool(threadId, "call_1", "read");
		r.server.cutStreams("reset");
		r.server.tool(threadId, "call_2", "shell");
		const second = await waitFor(() =>
			r
				.events()
				.find((event) => event.type === "event" && event.event === "counter" && event.itemId === "call_2"),
		);
		expect(second).toMatchObject({ counterKind: "shell", itemId: "call_2" });
		const calls = r
			.events()
			.filter(
				(event) =>
					event.type === "event" &&
					event.event === "counter" &&
					(event.itemId === "call_1" || event.itemId === "call_2"),
			)
			.map((event) => (event.type === "event" && event.event === "counter" ? event.itemId : ""));
		expect(calls).toEqual(["call_1", "call_2"]);
		r.server.finishTurn(threadId);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("settles a turn whose own rows pass one page", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("page-turn");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		for (let index = 0; index < 250; index += 1) r.server.synthetic(threadId, `msg_page_${index}`);
		r.server.finishTurn(threadId, undefined, "Past the page.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal" && event.turnId === turnId),
		);
		expect(terminal).toMatchObject({
			event: "terminal",
			terminal: { status: "completed", finalResponse: "Past the page." },
		});
		expect(r.server.requests.filter((request) => request.route.includes("/message")).length).toBeGreaterThan(1);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("inspects an older settled turn whose rows pass one page", async () => {
		const r = await rig();
		const threadId = await open(r);
		const first = promptIdOf("old-page-turn");
		await r.result(r.send({ op: "start", threadId, turnId: first, prompt: "First" }));
		for (let index = 0; index < 250; index += 1) r.server.synthetic(threadId, `msg_old_${index}`);
		r.server.finishTurn(threadId, undefined, "First answer.");
		await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal" && event.turnId === first),
		);
		const second = promptIdOf("new-page-turn");
		await r.result(r.send({ op: "start", threadId, turnId: second, prompt: "Second" }));
		r.server.finishTurn(threadId, undefined, "Second answer.");
		await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal" && event.turnId === second),
		);
		const inspected = await r.result(r.send({ op: "inspect", threadId, turnId: first }));
		expect(inspected).toMatchObject({
			type: "result",
			op: "inspect",
			inspection: { known: "settled", terminal: { status: "completed", finalResponse: "First answer." } },
		});
		r.bridge.closed();
		await r.bridge.done;
	});

	it("adopts a running turn whose rows pass one page", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("adopt-page-turn");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		for (let index = 0; index < 250; index += 1) r.server.synthetic(threadId, `msg_adopt_${index}`);
		const adopted = await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		expect(adopted).toMatchObject({ type: "result", op: "start", turnId });
		r.server.finishTurn(threadId, undefined, "Done.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal" && event.turnId === turnId),
		);
		expect(terminal).toMatchObject({ terminal: { status: "completed", finalResponse: "Done." } });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("clears the turn and withdraws the prompt when the start POST times out", async () => {
		const r = await rig({ abortOn: "/prompt" });
		const threadId = await open(r);
		const turnId = promptIdOf("timed-out-start");
		const failed = await r.error(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		expect(failed).toMatchObject({ type: "error", code: "http" });
		expect(r.server.inbox(threadId)).not.toContain(turnId);
		expect(
			r.server.requests.some(
				(request) => request.method === "DELETE" && request.route.includes(`/inbox/${turnId}`),
			),
		).toBe(true);

		const next = promptIdOf("after-timeout");
		const started = await r.result(r.send({ op: "start", threadId, turnId: next, prompt: "Review" }));
		expect(started).toMatchObject({ type: "result", op: "start", turnId: next });
		r.server.finishTurn(threadId);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("refuses an open without a model", async () => {
		const r = await rig();
		const answer = await r.error(r.send({ op: "open", cwd: "/fake/project" }));
		expect(answer).toMatchObject({ type: "error", code: "bad_request" });
		r.bridge.closed();
		await r.bridge.done;
	});
});
