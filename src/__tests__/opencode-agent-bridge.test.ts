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
	options: { abortOn?: string; loseAnswerOn?: string; sleep?: (ms: number) => Promise<void> | undefined } = {},
) {
	const server = createFakeOpencodeServer({ url: URL, password: PASSWORD });
	const lines: BridgeMessage[] = [];
	/** Each start's and steer's deadline, newest last. */
	const limits: AbortController[] = [];
	let aborted = false;
	let lost = false;
	const bridge = await startBridge({
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
		fetch: (async (input, init) => {
			if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
			const answer = await server.fetch(input, init);
			// The server took it, and its answer never arrives.
			if (options.loseAnswerOn && !lost && String(input).includes(options.loseAnswerOn)) {
				lost = true;
				throw new TypeError("fetch failed");
			}
			return answer;
		}) as typeof fetch,
		abortAfter: (_ms, route) => {
			const controller = new AbortController();
			if (route.endsWith("-deadline")) limits.push(controller);
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
	});
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
	const reads = (route: string) => server.requests.filter((request) => request.route.startsWith(route)).length;
	return { server, bridge, lines, limits, send, result, error, events, ready, reads };
}

async function open(r: Awaited<ReturnType<typeof rig>>): Promise<string> {
	const id = r.send({ op: "open", cwd: "/fake/project", model: MODEL });
	const answer = await r.result(id);
	if (answer.type !== "result" || answer.op !== "open") throw new Error("open failed");
	return answer.threadId;
}

function posted(r: Awaited<ReturnType<typeof rig>>, promptId: string) {
	return r.server.requests.filter(
		(request) => request.method === "POST" && (request.body as { id?: unknown } | undefined)?.id === promptId,
	);
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
		expect(answer).toMatchObject({ type: "error", code: "model_not_offered" });
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

	it("accepts a steer as soon as it is queued for the running turn", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-steer");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("steer-key");
		const steer = { op: "steer", threadId, turnId, promptId, prompt: "Also this" };

		await expect(r.result(r.send(steer))).resolves.toMatchObject({ type: "result", op: "steer" });
		expect(r.server.inbox(threadId)).toEqual([promptId]);

		// Repeats do not duplicate.
		await r.result(r.send(steer));
		r.server.deliverNext(threadId);
		await r.result(r.send(steer));
		r.server.finishTurn(threadId, undefined, "Done.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "completed", finalResponse: "Done." } });
		expect(r.server.messages(threadId).filter((row) => row.id === promptId)).toHaveLength(1);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("fails a turn that ended without a steer it accepted", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-undelivered");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("undelivered-steer");
		await r.result(r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also this" }));

		r.server.finishTurn(threadId, undefined, "First.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "failed" } });
		expect(r.server.inbox(threadId)).toEqual([]);
		expect(r.server.messages(threadId).some((row) => row.id === promptId)).toBe(false);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("accepts a steer at once while a step runs or is owed", async () => {
		// A poll would never return.
		const r = await rig({
			sleep: (ms) => (ms === 500 || ms === 10_000 ? new Promise(() => undefined) : undefined),
		});
		const threadId = await open(r);
		const turnId = promptIdOf("turn-steps");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const steer = (key: string) =>
			r.result(r.send({ op: "steer", threadId, turnId, promptId: promptIdOf(key), prompt: key }));

		r.server.step(threadId, { finish: "tool-calls" });
		await expect(steer("after-a-tool-step")).resolves.toMatchObject({ type: "result", op: "steer" });
		r.server.tool(threadId, "call_1", "read");
		await expect(steer("during-a-step")).resolves.toMatchObject({ type: "result", op: "steer" });
		// A repeat of an accepted one, behind the last step.
		r.server.step(threadId);
		await expect(steer("during-a-step")).resolves.toMatchObject({ type: "result", op: "steer" });

		r.server.deliverNext(threadId);
		r.server.deliverNext(threadId);
		r.server.finishTurn(threadId, undefined, "Done.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "completed", finalResponse: "Done." } });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("holds a steer behind a turn's last step until the turn takes it", async () => {
		const r = await rig({ sleep: (ms) => (ms === 10_000 ? new Promise(() => undefined) : undefined) });
		const threadId = await open(r);
		const turnId = promptIdOf("turn-last-step");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		r.server.step(threadId, { text: "First." });
		const promptId = promptIdOf("last-step-steer");
		const inbox = `/api/session/${threadId}/inbox`;
		const steerId = r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also this" });
		await waitFor(() => (r.server.inbox(threadId).includes(promptId) ? true : undefined));
		// Two more reads of a queued prompt, and still no answer.
		const before = r.reads(inbox);
		await waitFor(() => (r.reads(inbox) >= before + 2 ? true : undefined));
		expect(r.lines.some((line) => line.type !== "event" && line.type !== "ready" && line.id === steerId)).toBe(
			false,
		);

		r.server.deliverNext(threadId);
		await expect(r.result(steerId)).resolves.toMatchObject({ type: "result", op: "steer" });
		r.server.finishTurn(threadId, undefined, "Second.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "completed", finalResponse: "Second." } });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("refuses a steer behind a turn's last step once the turn ends without it", async () => {
		const r = await rig({ sleep: (ms) => (ms === 10_000 ? new Promise(() => undefined) : undefined) });
		const threadId = await open(r);
		const turnId = promptIdOf("turn-ends-first");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		r.server.step(threadId, { text: "First." });
		const promptId = promptIdOf("too-late-steer");
		const steerId = r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also this" });
		await waitFor(() => (r.server.inbox(threadId).includes(promptId) ? true : undefined));

		r.server.goIdle(threadId);
		const error = await r.error(steerId);
		expect(error).toMatchObject({ type: "error", code: "turn_ended" });
		expect(r.server.inbox(threadId)).toEqual([]);
		const ended = r.lines.findIndex(
			(line) => line.type === "event" && line.event === "terminal" && line.turnId === turnId,
		);
		expect(r.lines[ended]).toMatchObject({ terminal: { status: "completed", finalResponse: "First." } });
		expect(ended).toBeLessThan(r.lines.indexOf(error));
		r.bridge.closed();
		await r.bridge.done;
	});

	it("accepts a steer whose turn stays between steps past the window", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-window");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		r.server.step(threadId, { text: "First." });
		const promptId = promptIdOf("window-steer");
		await expect(
			r.result(r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also this" })),
		).resolves.toMatchObject({ type: "result", op: "steer" });

		r.server.deliverNext(threadId);
		r.server.finishTurn(threadId, undefined, "Second.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "completed", finalResponse: "Second." } });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("runs a stop behind a steer still being decided", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-stop-behind");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("deciding-steer");
		const held = r.server.stallNext(`/api/session/${threadId}/inbox`, "arrival");
		const steerId = r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also this" });
		const stopId = r.send({ op: "interrupt", threadId, turnId });

		held.release();
		const steered = await r.result(steerId);
		const stopped = await r.result(stopId);
		expect(steered).toMatchObject({ type: "result", op: "steer" });
		expect(stopped).toMatchObject({ op: "interrupt", interrupted: true });
		// The steer was decided whole before the stop reached the server.
		expect(r.lines.indexOf(steered)).toBeLessThan(r.lines.indexOf(stopped));
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "interrupted" } });
		expect(r.server.inbox(threadId)).toEqual([]);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("ends nothing on an end event while the server still runs the turn", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-stale-end");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const terminals = () => r.events().filter((event) => event.type === "event" && event.event === "terminal");

		const before = r.reads("/api/session/active");
		r.server.emit("session.execution.succeeded", { sessionID: threadId });
		// Every read the event earns, and still no terminal.
		await waitFor(() => (r.reads("/api/session/active") >= before + 3 ? true : undefined));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(terminals()).toEqual([]);

		r.server.finishTurn(threadId, undefined, "Done.");
		await waitFor(() => (terminals().length > 0 ? true : undefined));
		expect(terminals()).toMatchObject([{ turnId, terminal: { status: "completed", finalResponse: "Done." } }]);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("ends nothing on an end event it cannot read, and reads the end again later", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-unread-end");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const terminals = () => r.events().filter((event) => event.type === "event" && event.event === "terminal");

		// Another execution's end, with the server unread, then read again.
		const before = r.reads("/api/session/active");
		r.server.failNext(500, 3);
		r.server.emit("session.execution.succeeded", { sessionID: threadId });
		await waitFor(() => (r.reads("/api/session/active") >= before + 4 ? true : undefined));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(terminals()).toEqual([]);

		r.server.failNext(500, 3);
		r.server.finishTurn(threadId, undefined, "Done.");
		await waitFor(() => (terminals().length > 0 ? true : undefined));
		expect(terminals()).toMatchObject([{ turnId, terminal: { status: "completed", finalResponse: "Done." } }]);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("keeps a turn it holds when a repeated start cannot read the server", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-repeat-unread");
		const start = { op: "start", threadId, turnId, prompt: "Review" };
		await r.result(r.send(start));

		r.server.failNext(500, 2);
		const repeated = await r.result(r.send(start));
		expect(repeated).toMatchObject({ type: "result", op: "start", turnId });
		expect(repeated).not.toHaveProperty("terminal");

		r.server.finishTurn(threadId, undefined, "Done.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "completed", finalResponse: "Done." } });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("accepts a steer its turn took while the inbox cannot be read", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-inbox-unread");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("taken-unread-steer");
		const held = r.server.stallNext(`/api/session/${threadId}/prompt`, "arrival");
		const steerId = r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also this" });
		await waitFor(() => (r.server.inbox(threadId).includes(promptId) ? true : undefined));
		r.server.deliverNext(threadId);
		r.server.failNext(500, 20, `/api/session/${threadId}/inbox`);
		held.release();

		await expect(r.result(steerId)).resolves.toMatchObject({ type: "result", op: "steer" });
		r.server.failNext(500, 0);
		r.server.finishTurn(threadId, undefined, "Done.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "completed", finalResponse: "Done." } });

		// A start under that key is answered by the turn that took it.
		const again = await r.result(r.send({ op: "start", threadId, turnId: promptId, prompt: "Also this" }));
		expect(again).toMatchObject({ op: "start", terminal: { status: "completed", finalResponse: "Done." } });
		expect(r.server.messages(threadId).filter((row) => row.id === promptId)).toHaveLength(1);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("answers a steer at its deadline, and takes back what it posted", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-deadline");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("late-answer-steer");
		const held = r.server.stallNext(`/api/session/${threadId}/prompt`, "arrival");
		const steerId = r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also this" });
		await waitFor(() => (r.server.inbox(threadId).includes(promptId) ? true : undefined));

		r.limits.at(-1)?.abort();
		await expect(r.error(steerId)).resolves.toMatchObject({ type: "error", code: "http" });
		held.release();
		await waitFor(() => (r.server.inbox(threadId).length === 0 ? true : undefined));

		r.server.finishTurn(threadId, undefined, "Done.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "completed", finalResponse: "Done." } });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("starts nothing once its deadline has passed", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-too-late");
		const rows = `/api/session/${threadId}/message`;
		const held = r.server.stallNext(rows, "arrival");
		const startId = r.send({ op: "start", threadId, turnId, prompt: "Review" });
		await waitFor(() => (r.reads(rows) > 0 ? true : undefined));

		r.limits.at(-1)?.abort();
		await expect(r.error(startId)).resolves.toMatchObject({ type: "error", code: "http" });
		held.release();
		// Its last read before the post it must not make.
		await waitFor(() => (r.reads(`/api/session/${threadId}/inbox`) > 0 ? true : undefined));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(r.server.messages(threadId)).toEqual([]);

		const next = promptIdOf("after-too-late");
		const begun = await r.result(r.send({ op: "start", threadId, turnId: next, prompt: "Review" }));
		expect(begun).toMatchObject({ op: "start", turnId: next });
		r.server.finishTurn(threadId);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("keeps a turn that started when the start's answer was lost", async () => {
		const r = await rig({ loseAnswerOn: "/prompt" });
		const threadId = await open(r);
		const turnId = promptIdOf("turn-answer-lost");
		const started = await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		expect(started).toMatchObject({ type: "result", op: "start", turnId });
		expect(started).not.toHaveProperty("terminal");

		r.server.finishTurn(threadId, undefined, "Done.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "completed", finalResponse: "Done." } });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("accepts a steer its ended turn took when only the end could be read", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-end-proof");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("end-proof-steer");
		const held = r.server.stallNext(`/api/session/${threadId}/prompt`, "arrival");
		const steerId = r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also this" });
		await waitFor(() => (r.server.inbox(threadId).includes(promptId) ? true : undefined));
		r.server.deliverNext(threadId);
		r.server.finishTurn(threadId, undefined, "Done.");
		// Every row read of the steer's own fails.
		r.server.failNext(500, 4, `/api/session/${threadId}/message`);
		held.release();

		const steered = await r.result(steerId);
		expect(steered).toMatchObject({ type: "result", op: "steer" });
		const terminal = r.lines.find((line) => line.type === "event" && line.event === "terminal");
		expect(terminal).toMatchObject({ turnId, terminal: { status: "completed", finalResponse: "Done." } });
		expect(r.lines.indexOf(terminal as BridgeMessage)).toBeLessThan(r.lines.indexOf(steered));
		r.bridge.closed();
		await r.bridge.done;
	});

	it("ends a turn that ended while the stream was down, once its rows can be read", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-resync-unread");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		r.server.cutStreams("reset");
		r.server.finishTurn(threadId, undefined, "After the cut.");
		r.server.failNext(500, 1, `/api/session/${threadId}/message`);

		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "completed", finalResponse: "After the cut." } });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("reads no lost turn from an answer it cannot read", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-unreadable");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const terminals = () => r.events().filter((event) => event.type === "event" && event.event === "terminal");

		// A 200 that names no sessions.
		r.server.failNext(200);
		const inspected = await r.result(r.send({ op: "inspect", threadId, turnId }));
		expect(inspected).toMatchObject({ inspection: { known: "unknown" } });
		expect(terminals()).toEqual([]);

		r.server.finishTurn(threadId, undefined, "Done.");
		await waitFor(() => (terminals().length > 0 ? true : undefined));
		expect(terminals()).toMatchObject([{ turnId, terminal: { status: "completed", finalResponse: "Done." } }]);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("takes a failed turn's queued steer with it", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-failed-steer");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("failed-steer");
		await r.result(r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also this" }));

		r.server.finishTurn(threadId, { type: "provider.auth", message: "login required" });
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "failed", error: "login required" } });
		expect(r.server.inbox(threadId)).toEqual([]);
		expect(r.server.messages(threadId).some((row) => row.id === promptId)).toBe(false);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("takes an interrupted turn's queued steer with it, and clears one it could not withdraw", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-stopped");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("stopped-steer");
		await r.result(r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also this" }));
		r.server.refuseCancel(true);

		const stopped = await r.result(r.send({ op: "interrupt", threadId, turnId }));
		expect(stopped).toMatchObject({ op: "interrupt", interrupted: true });
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "interrupted" } });
		expect(r.server.inbox(threadId)).toEqual([promptId]);

		// Stale prompts arrive first.
		const nextId = promptIdOf("turn-after-stop");
		const start = { op: "start", threadId, turnId: nextId, prompt: "Next" };
		await expect(r.error(r.send(start))).resolves.toMatchObject({ type: "error", code: "http" });
		expect(posted(r, nextId)).toEqual([]);
		r.server.refuseCancel(false);
		await r.result(r.send(start));
		expect(r.server.inbox(threadId)).toEqual([]);
		expect(r.server.messages(threadId).some((row) => row.id === promptId)).toBe(false);
		r.server.finishTurn(threadId, undefined, "Done.");
		const next = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal" && event.turnId === nextId),
		);
		expect(next).toMatchObject({ terminal: { status: "completed", finalResponse: "Done." } });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("refuses a steer its turn ended before accepting it, then starts exactly one turn for that key", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-miss");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("missed-key");
		// The server holds the prompt, and its answer comes back after the turn ended.
		const held = r.server.stallNext(`/api/session/${threadId}/prompt`, "arrival");
		const steerId = r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also this" });
		await waitFor(() => (r.server.inbox(threadId).includes(promptId) ? true : undefined));
		r.server.finishTurn(threadId, undefined, "First.");
		held.release();

		const error = await r.error(steerId);
		expect(error).toMatchObject({ type: "error", code: "turn_ended" });
		expect(r.server.inbox(threadId)).toEqual([]);
		const ended = r.lines.findIndex(
			(line) => line.type === "event" && line.event === "terminal" && line.turnId === turnId,
		);
		expect(r.lines[ended]).toMatchObject({ terminal: { status: "completed", finalResponse: "First." } });
		expect(ended).toBeLessThan(r.lines.indexOf(error));

		const adoptedId = r.send({ op: "start", threadId, turnId: promptId, prompt: "Also this" });
		await expect(r.result(adoptedId)).resolves.toMatchObject({ type: "result", op: "start" });
		expect(r.server.messages(threadId).filter((row) => row.id === promptId)).toHaveLength(1);
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

	it("withdraws a steer the server would not confirm", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-unconfirmed");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("unconfirmed-steer");
		const held = r.server.stallNext(`/api/session/${threadId}/prompt`, "arrival");
		const steerId = r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also this" });
		await waitFor(() => (r.server.inbox(threadId).includes(promptId) ? true : undefined));
		// No inbox read after the post answers.
		r.server.failNext(500, 3, `/api/session/${threadId}/inbox`);
		held.release();

		await expect(r.error(steerId)).resolves.toMatchObject({
			type: "error",
			code: "http",
			message: expect.stringContaining("not delivered"),
		});
		expect(r.server.inbox(threadId)).toEqual([]);
		r.server.finishTurn(threadId, undefined, "Done.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "completed", finalResponse: "Done." } });
		r.bridge.closed();
		await r.bridge.done;
	});

	it("accepts a steer when one read after its post fails", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-unread");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("unread-steer");
		const held = r.server.stallNext(`/api/session/${threadId}/prompt`, "arrival");
		const steerId = r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also this" });
		await waitFor(() => (r.server.inbox(threadId).includes(promptId) ? true : undefined));
		r.server.failNext(500);
		held.release();

		await expect(r.result(steerId)).resolves.toMatchObject({ type: "result", op: "steer" });
		r.server.deliverNext(threadId);
		r.server.finishTurn(threadId, undefined, "Done.");
		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "completed", finalResponse: "Done." } });
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

	it("refuses a steer that reached the server after its turn ended, after the old terminal", async () => {
		const r = await rig();
		const threadId = await open(r);
		const oldId = promptIdOf("old-turn");
		await r.result(r.send({ op: "start", threadId, turnId: oldId, prompt: "Review" }));
		const promptId = promptIdOf("late-steer");
		// A late post starts its own turn.
		const held = r.server.stallNext(`/api/session/${threadId}/prompt`, "release");
		const steerId = r.send({ op: "steer", threadId, turnId: oldId, promptId, prompt: "Late" });
		await waitFor(() => (posted(r, promptId).length > 0 ? true : undefined));
		r.server.finishTurn(threadId);
		held.release();
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
		expect(r.server.messages(threadId).filter((row) => row.id === promptId)).toHaveLength(1);
		r.bridge.closed();
		await r.bridge.done;
	});

	it("delivers nothing twice for a steer taken while the stream was down", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("resync-turn");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		const promptId = promptIdOf("resync-steer");
		await r.result(r.send({ op: "steer", threadId, turnId, promptId, prompt: "Also" }));
		r.server.cutStreams("reset");
		r.server.deliverNext(threadId);
		r.server.finishTurn(threadId, undefined, "Done.");

		const terminal = await waitFor(() =>
			r.events().find((event) => event.type === "event" && event.event === "terminal"),
		);
		expect(terminal).toMatchObject({ turnId, terminal: { status: "completed", finalResponse: "Done." } });
		expect(posted(r, promptId)).toHaveLength(1);
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

	it("deletes a thread's session once no turn runs on it, and says gone for one the server does not hold", async () => {
		const r = await rig();
		const threadId = await open(r);
		const turnId = promptIdOf("turn-before-delete");
		await r.result(r.send({ op: "start", threadId, turnId, prompt: "Review" }));
		await expect(r.error(r.send({ op: "delete", threadId }))).resolves.toMatchObject({ code: "turn_inactive" });
		expect(r.server.sessionOf(threadId)).toBeDefined();

		r.server.finishTurn(threadId, undefined, "Done.");
		await waitFor(() => r.events().find((event) => event.type === "event" && event.event === "terminal"));
		await expect(r.result(r.send({ op: "delete", threadId }))).resolves.toMatchObject({ outcome: "deleted" });
		expect(r.server.sessionOf(threadId)).toBeUndefined();
		await expect(r.result(r.send({ op: "delete", threadId }))).resolves.toMatchObject({ outcome: "gone" });
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
