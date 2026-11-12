import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { OpencodeBackendSession, opencodeFailureCode } from "../mcp/agents/opencodeSession.js";
import { AgentDaemonService } from "../mcp/devcontainer/agentDaemonService.js";
import type { AgentChild, TargetSupervisor } from "../mcp/devcontainer/agentTargets.js";
import { startBridge } from "../opencode-agent/bridge.js";
import { OPENCODE_BACKEND } from "../shared/agent-backend.js";
import { promptIdOf } from "../shared/opencode.js";
import { createFakeOpencodeServer } from "../testing/fakeOpencodeServer.js";

const OWNER_KEY = "recipe-app.work";
const AGENT_ID = "opencode_0123456789abcdef0123456789abcdef";
const START = "123e4567-e89b-42d3-a456-426614174000";
const MESSAGE = "123e4567-e89b-42d3-a456-426614174001";
const NEXT = "123e4567-e89b-42d3-a456-426614174002";
const TARGET = { kind: "host", targetId: "host", cwd: "/home/agent" } as const;

let minted = 0;
function requestId(): string {
	minted += 1;
	return `123e4567-e89b-42d3-a456-${String(minted).padStart(12, "0")}`;
}

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const found = read();
		if (found !== undefined) return found;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** The real driver over the real bridge, joined by a pipe, with the fake server behind it. */
async function rig() {
	// The bridge mints its server's password, so the fake's must be what it mints.
	const minted = "0".repeat(32);
	const server = createFakeOpencodeServer({ url: "http://127.0.0.1:41998", password: minted });
	const stdout = new PassThrough();
	let pending = "";
	let receive: (line: string) => void = () => {};
	const stdin = new Writable({
		write(chunk: Buffer, _encoding, done) {
			pending += chunk.toString("utf8");
			for (;;) {
				const cut = pending.indexOf("\n");
				if (cut < 0) break;
				const line = pending.slice(0, cut);
				pending = pending.slice(cut + 1);
				if (line) receive(line);
			}
			done();
		},
	});
	const child: AgentChild = { stdin, stdout, kill: () => {}, onExit: () => {} };
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
		fetch: server.fetch,
		abortAfter: () => new AbortController().signal,
		randomHex: () => minted,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))),
		write: (line) => stdout.write(`${line}\n`),
		log: () => undefined,
	});
	receive = (line) => bridge.receive(line);

	const sent: Record<string, unknown>[] = [];
	const targets: TargetSupervisor = {
		acquire: () => ({ state: "running", lease: { generation: 1, child } }),
		release: () => {},
	};
	const service = new AgentDaemonService({
		backend: OPENCODE_BACKEND,
		targets,
		daemonInstanceId: "daemon-1",
		send: (message) => sent.push(message),
		open: (opened) => OpencodeBackendSession.open(opened),
		resolveHostCwd: () => "/home/agent",
		failureCode: opencodeFailureCode,
	});
	const command = (kind: string, fields: Record<string, unknown>) =>
		service.handleCommand({
			type: "opencode_command",
			kind,
			requestId: requestId(),
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			...fields,
		});
	const frame = (wanted: (candidate: Record<string, unknown>) => boolean, what: string) =>
		until(() => sent.find(wanted), what);
	return { server, bridge, sent, command, frame };
}

describe("an OpenCode agent on the daemon wire", () => {
	it("runs a turn from a start command to its terminal, and a message as a new turn", async () => {
		const r = await rig();
		r.command("start", { operationId: START, target: { kind: "host", workdirHint: "agent" }, prompt: "Review" });
		const accepted = await r.frame((sent) => sent.kind === "accepted", "the start's acceptance");
		const sessionId = accepted.sessionId as string;
		expect(accepted).toMatchObject({
			type: "opencode_receipt",
			operationId: START,
			turnId: promptIdOf(START),
			delivery: "started",
		});
		expect(r.server.sessionOf(sessionId)).toMatchObject({
			directory: "/home/agent",
			model: { providerID: "opencode-go", id: "deepseek-v4-pro" },
		});

		r.server.emit("session.text.ended", {
			sessionID: sessionId,
			assistantMessageID: "msg_a",
			ordinal: 0,
			text: "Reading the parser.",
		});
		r.server.emit("session.tool.input.started", {
			sessionID: sessionId,
			assistantMessageID: "msg_a",
			id: "call_1",
			name: "bash",
		});
		expect(await r.frame((sent) => sent.kind === "activity", "commentary")).toMatchObject({
			type: "opencode_event",
			turnId: promptIdOf(START),
			text: "Reading the parser.",
		});
		expect(await r.frame((sent) => sent.kind === "counter", "a tool counter")).toMatchObject({
			counterKind: "shell",
		});

		r.server.finishTurn(sessionId, undefined, "Done.");
		expect(await r.frame((sent) => sent.kind === "terminal", "the terminal")).toMatchObject({
			turnId: promptIdOf(START),
			state: "completed",
			finalResponse: "Done.",
		});

		r.command("message", { operationId: MESSAGE, target: TARGET, sessionId, prompt: "And the lexer" });
		expect(
			await r.frame((sent) => sent.kind === "accepted" && sent.operationId === MESSAGE, "the message's turn"),
		).toMatchObject({ turnId: promptIdOf(MESSAGE), delivery: "started" });
		r.bridge.closed();
	});

	it("steers a message into the running turn while a step is owed", async () => {
		const r = await rig();
		r.command("start", { operationId: START, target: { kind: "host", workdirHint: "agent" }, prompt: "Review" });
		const accepted = await r.frame((sent) => sent.kind === "accepted", "the start's acceptance");
		const sessionId = accepted.sessionId as string;

		r.command("message", {
			operationId: MESSAGE,
			target: TARGET,
			sessionId,
			expectedTurnId: promptIdOf(START),
			prompt: "Also the lexer",
		});
		expect(
			await r.frame((sent) => sent.kind === "accepted" && sent.operationId === MESSAGE, "the steer's acceptance"),
		).toMatchObject({ turnId: promptIdOf(START), delivery: "steered" });
		expect(r.server.inbox(sessionId)).toHaveLength(1);

		r.server.deliverNext(sessionId);
		r.server.finishTurn(sessionId, undefined, "Both done.");
		await r.frame((sent) => sent.kind === "terminal", "the terminal");
		r.command("message", { operationId: NEXT, target: TARGET, sessionId, prompt: "Next" });
		expect(
			await r.frame((sent) => sent.kind === "accepted" && sent.operationId === NEXT, "the next turn"),
		).toMatchObject({ turnId: promptIdOf(NEXT), delivery: "started" });
		r.bridge.closed();
	});
});
