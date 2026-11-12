import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { OpencodeBackendSession, opencodeFailureCode } from "../mcp/agents/opencodeSession.js";
import { promptIdOf } from "../shared/opencode.js";

interface RequestLine {
	type: "request";
	id: string;
	op: string;
	[key: string]: unknown;
}

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

function fakeChild() {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const requests: RequestLine[] = [];
	let exit: ((info: { code: number | null; signal: string | null; reason?: string }) => void) | undefined;
	let buffer = "";
	stdin.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		for (;;) {
			const cut = buffer.indexOf("\n");
			if (cut < 0) break;
			const line = buffer.slice(0, cut).trim();
			buffer = buffer.slice(cut + 1);
			if (!line) continue;
			const parsed = JSON.parse(line) as RequestLine;
			if (parsed.type === "request") requests.push(parsed);
		}
	});
	const child = {
		stdin,
		stdout,
		kill: () => undefined,
		onExit: (listener: (info: { code: number | null; signal: string | null; reason?: string }) => void) => {
			exit = listener;
		},
	};
	const send = (line: object): void => {
		stdout.write(`${JSON.stringify(line)}\n`);
	};
	return {
		child,
		requests,
		send,
		exit: () => exit?.({ code: 0, signal: null }),
	};
}

async function opened() {
	const fake = fakeChild();
	const opening = OpencodeBackendSession.open(fake.child);
	fake.send({ type: "ready", ok: true, version: "2.2.5" });
	const session = await opening;
	return { ...fake, session };
}

async function answered(fake: ReturnType<typeof fakeChild>, op: string, body: Record<string, unknown> = {}) {
	const request = await waitFor(() => fake.requests.find((line) => line.op === op));
	fake.send({ type: "result", id: request.id, op, ...body });
	return request;
}

describe("the OpenCode driver", () => {
	it("opens a thread and lists models", async () => {
		const fake = await opened();
		const models = fake.session.listModels();
		await answered(fake, "models", { models: [{ id: "opencode-go/longcat-2.5-free" }] });
		await expect(models).resolves.toEqual([{ id: "opencode-go/longcat-2.5-free" }]);

		const opening = fake.session.openThread({ cwd: "/work", model: "opencode-go/longcat-2.5-free" });
		const request = await answered(fake, "open", { threadId: "ses_sbthread" });
		expect(request).toMatchObject({ cwd: "/work", model: "opencode-go/longcat-2.5-free" });
		await expect(opening).resolves.toBe("ses_sbthread");
		fake.session.close();
	});

	it("starts a keyed turn with the schema instruction and settles it", async () => {
		const fake = await opened();
		const starting = fake.session.startTurn("ses_sbthread", "Review", {
			key: "operation-1",
			outputSchema: { type: "object" },
		});
		const request = await answered(fake, "start", { turnId: promptIdOf("operation-1") });
		const handle = await starting;
		expect(request).toMatchObject({ turnId: promptIdOf("operation-1") });
		expect(String(request.prompt)).toContain("Answer with one JSON value matching this schema and nothing else:");
		fake.send({
			type: "event",
			event: "terminal",
			threadId: "ses_sbthread",
			turnId: handle.turnId,
			terminal: { status: "completed", finalResponse: "Done." },
		});
		await expect(handle.settled).resolves.toEqual({ status: "completed", finalResponse: "Done." });
		fake.session.close();
	});

	it("reports commentary and counters", async () => {
		const fake = await opened();
		const activity: Array<[string, string, string | undefined]> = [];
		const counters: Array<[string, unknown]> = [];
		fake.session.onActivity((turnId, text, itemId) => activity.push([turnId, text, itemId]));
		fake.session.onCounter((turnId, counter) => counters.push([turnId, counter]));
		fake.send({
			type: "event",
			event: "activity",
			threadId: "ses_sbthread",
			turnId: "turn-1",
			text: "Reading.",
			itemId: "msg_a:0",
		});
		fake.send({
			type: "event",
			event: "counter",
			threadId: "ses_sbthread",
			turnId: "turn-1",
			counterKind: "read",
			itemId: "call_1",
		});
		await waitFor(() => (activity.length === 1 && counters.length === 1 ? true : undefined));
		expect(activity).toEqual([["turn-1", "Reading.", "msg_a:0"]]);
		expect(counters).toEqual([["turn-1", { kind: "read", itemId: "call_1" }]]);
		fake.session.close();
	});

	it("steers, interrupts and inspects", async () => {
		const fake = await opened();
		const steering = fake.session.steerTurn("ses_sbthread", "turn-1", "Also this", "operation-2");
		const steer = await answered(fake, "steer");
		expect(steer).toMatchObject({ turnId: "turn-1", promptId: promptIdOf("operation-2") });
		await expect(steering).resolves.toBe("taken");

		const interrupting = fake.session.interruptTurn("ses_sbthread", "turn-1");
		await answered(fake, "interrupt", { interrupted: true });
		await expect(interrupting).resolves.toBeUndefined();

		const inspecting = fake.session.inspectTurn("ses_sbthread", "turn-1");
		await answered(fake, "inspect", { inspection: { known: "settled", terminal: { status: "interrupted" } } });
		await expect(inspecting).resolves.toEqual({ known: "settled", terminal: { status: "interrupted" } });
		fake.session.close();
	});

	it("settles running turns failed and fires closed when the pipe ends", async () => {
		const fake = await opened();
		let closed = 0;
		fake.session.onClosed(() => {
			closed += 1;
		});
		const starting = fake.session.startTurn("ses_sbthread", "Review", { key: "operation-3" });
		await answered(fake, "start", { turnId: promptIdOf("operation-3") });
		const handle = await starting;
		fake.exit();
		await expect(handle.settled).resolves.toEqual({ status: "failed", error: "OpenCode exited" });
		expect(closed).toBe(1);
	});

	it("calls a closed listener registered after the close", async () => {
		const fake = await opened();
		fake.exit();
		let closed = 0;
		fake.session.onClosed(() => {
			closed += 1;
		});
		expect(closed).toBe(1);

		const closing = await opened();
		let notified = 0;
		closing.session.onClosed(() => {
			notified += 1;
		});
		closing.session.close();
		expect(notified).toBe(1);
	});

	it("refuses a bridge that cannot start", async () => {
		const fake = fakeChild();
		const opening = OpencodeBackendSession.open(fake.child);
		fake.send({ type: "ready", ok: false, code: "binary_missing", message: "OpenCode is not installed" });
		await expect(opening).rejects.toThrow("binary_missing: OpenCode is not installed");
	});

	it("reads a failure's class off its text", () => {
		expect(opencodeFailureCode("version_refused: OpenCode 2.3.0 is outside the supported range")).toBe(
			"protocol_incompatible",
		);
		expect(opencodeFailureCode("authentication_required: login required")).toBe("authentication_required");
		expect(opencodeFailureCode("binary_missing: OpenCode is not installed")).toBe("daemon_unavailable");
		expect(opencodeFailureCode("server_failed: the OpenCode server did not start")).toBe("app_server_unavailable");
		expect(opencodeFailureCode("something else")).toBe("protocol_error");
	});
});
