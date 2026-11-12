import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexBackendSession } from "../mcp/agents/codexSession.js";
import { AgentDaemonService } from "../mcp/devcontainer/agentDaemonService.js";
import type { AgentChild, TargetAvailability, TargetSupervisor } from "../mcp/devcontainer/agentTargets.js";
import { CODEX_BACKEND } from "../shared/agent-backend.js";
import type { AgentResolvedTarget } from "../shared/agent-execution-target.js";
import { agentWire } from "../shared/agent-wire.js";

const CODEX_DEFAULT_MODEL = CODEX_BACKEND.defaultModel;
const OWNER_KEY = "recipe-app.work";
const AGENT_ID = "codex_0123456789abcdef0123456789abcdef";
const SECOND_AGENT_ID = "codex_fedcba9876543210fedcba9876543210";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const TARGET_ID = "container:recipe-app";
const RESOLVED_TARGET: AgentResolvedTarget = {
	kind: "devcontainer",
	targetId: TARGET_ID,
	cwd: "/workspace/recipe-app",
};
const WIRE = agentWire("codex");
type Request = Record<string, unknown>;
type Item = { id: string; text: string; phase?: string };

let operationSequence = 1;
const nextOperationId = () => `123e4567-e89b-42d3-a456-${(operationSequence++).toString(16).padStart(12, "0")}`;

function reply(request: Request, result: unknown) {
	return { jsonrpc: "2.0", id: request.id as number, result };
}

function errorReply(request: Request, message: string) {
	return { jsonrpc: "2.0", id: request.id as number, error: { code: -1, message } };
}

function scripted() {
	const stdout = new PassThrough();
	const requests: Request[] = [];
	let nextThread = 1;
	let nextTurn = 1;
	let readResult: unknown = { thread: { id: "thread-1", turns: [] } };
	let turnStartError: string | undefined;
	let steerError: string | undefined;
	let interruptError: string | undefined;
	let archiveError: string | undefined;
	let unreadableRead = false;
	let blockedRead: Request | undefined;
	let blockedSteer: Request | undefined;
	let blockedInitialize = false;
	let initializeRelease: (() => void) | undefined;
	let exited = false;
	let onExit: (info: { code: number | null; signal: string | null; reason?: string }) => void = () => {};
	const emit = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
	const child: AgentChild = {
		stdin: new Writable({
			write(chunk: Buffer, _encoding, callback) {
				const request = JSON.parse(String(chunk)) as Request;
				requests.push(request);
				switch (request.method) {
					case "initialize":
						if (blockedInitialize) initializeRelease = () => emit(reply(request, {}));
						else emit(reply(request, {}));
						break;
					case "initialized":
						break;
					case "model/list":
						emit(reply(request, { data: [{ id: CODEX_DEFAULT_MODEL }] }));
						break;
					case "thread/start":
						emit(reply(request, { thread: { id: `thread-${nextThread++}` } }));
						break;
					case "thread/read":
						if (blockedRead) blockedRead = request;
						else if (unreadableRead) emit({ jsonrpc: "2.0", id: request.id, result: {}, error: null });
						else emit(reply(request, readResult));
						break;
					case "thread/resume":
					case "thread/unarchive":
					case "thread/delete":
						emit(reply(request, {}));
						break;
					case "thread/archive":
						emit(archiveError ? errorReply(request, archiveError) : reply(request, {}));
						break;
					case "turn/start":
						if (turnStartError) emit(errorReply(request, turnStartError));
						else
							emit(
								reply(request, { turn: { id: `turn-${nextTurn++}`, status: "inProgress", items: [] } }),
							);
						break;
					case "turn/steer":
						if (blockedSteer) blockedSteer = request;
						else if (steerError) emit(errorReply(request, steerError));
						else emit(reply(request, {}));
						break;
					default:
						if (request.method === "turn/interrupt" && interruptError)
							emit(errorReply(request, interruptError));
						else emit(reply(request, {}));
				}
				callback();
			},
		}),
		stdout,
		kill: () => {
			if (!exited) {
				exited = true;
				onExit({ code: 1, signal: null });
			}
		},
		onExit: (listener) => {
			onExit = listener;
		},
	};
	return {
		child,
		requests,
		emit,
		setRead(value: unknown) {
			readResult = value;
		},
		failStart(message = "start failed") {
			turnStartError = message;
		},
		failSteer(message = "steer failed") {
			steerError = message;
		},
		failInterrupt(message = "turn ended") {
			interruptError = message;
		},
		blockSteer() {
			blockedSteer = {};
		},
		releaseSteer() {
			const request = blockedSteer;
			blockedSteer = undefined;
			if (request) emit(steerError ? errorReply(request, steerError) : reply(request, {}));
		},
		failArchive(message = "archive failed") {
			archiveError = message;
		},
		failRead() {
			unreadableRead = true;
		},
		blockInitialize() {
			blockedInitialize = true;
		},
		exit() {
			if (!exited) {
				exited = true;
				onExit({ code: 1, signal: null });
			}
		},
		releaseInitialize() {
			blockedInitialize = false;
			initializeRelease?.();
			initializeRelease = undefined;
		},
		blockNextRead() {
			blockedRead = {};
		},
		releaseRead() {
			const request = blockedRead;
			blockedRead = undefined;
			if (request) emit(reply(request, readResult));
		},
	};
}

type Scripted = ReturnType<typeof scripted>;

function item(threadId: string, turnId: string, value: Item) {
	return { method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", ...value } } };
}

function terminal(threadId: string, turnId: string, status = "completed") {
	return { method: "turn/completed", params: { threadId, turn: { id: turnId, status } } };
}

function read(threadId: string, turns: unknown[]) {
	return { thread: { id: threadId, turns } };
}

function settledTurn(turnId: string, text: string) {
	return {
		id: turnId,
		status: "completed",
		items: [{ type: "agentMessage", id: `item-${turnId}`, text, phase: "final_answer" }],
	};
}

function startCommand(overrides: Record<string, unknown> = {}) {
	return {
		type: "codex_command",
		kind: "start",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: nextOperationId(),
		target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		prompt: "Audit the parser",
		...overrides,
	};
}

function reconcile(sessionId: string, turnId?: string, target = RESOLVED_TARGET) {
	return {
		type: "codex_command",
		kind: "reconcile",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		target,
		sessionId,
		...(turnId ? { turnId } : {}),
	};
}

function message(sessionId: string, prompt: string, turnId?: string, target = RESOLVED_TARGET) {
	return {
		type: "codex_command",
		kind: "message",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: nextOperationId(),
		target,
		sessionId,
		prompt,
		...(turnId ? { expectedTurnId: turnId } : {}),
	};
}

function interrupt(sessionId: string, turnId: string) {
	return {
		type: "codex_command",
		kind: "interrupt",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: nextOperationId(),
		target: RESOLVED_TARGET,
		sessionId,
		turnId,
	};
}

function setup(
	options: { availability?: TargetAvailability; resolveHostCwd?: (hint: string | undefined) => string } = {},
) {
	const apps = new Map<string, Scripted>();
	const appKey = (targetId: string, generation: number) => `${targetId}:${generation}`;
	const appFor = (targetId = TARGET_ID, generation = 3) => {
		const key = appKey(targetId, generation);
		let app = apps.get(key);
		if (!app) {
			app = scripted();
			apps.set(key, app);
		}
		return app;
	};
	const app = appFor();
	const sent: Record<string, unknown>[] = [];
	const acquired: Array<{ targetId: string; generation: number }> = [];
	const released: Array<{ targetId: string; generation: number }> = [];
	const retireListeners = new Set<(targetId: string, generation: number) => void>();
	const generations = new Map<string, number>();
	const timers = new Map<number, { run: () => void; ms: number; cleared: boolean }>();
	const sweeps: Array<() => void> = [];
	let timerSequence = 0;
	let clock = 1_000_000;
	const targets: TargetSupervisor = {
		acquire: (target) => {
			if (options.availability) return options.availability;
			const generation = generations.get(target.targetId) ?? 3;
			acquired.push({ targetId: target.targetId, generation });
			return { state: "running", lease: { generation, child: appFor(target.targetId, generation).child } };
		},
		release: (targetId, generation) => {
			if ((generations.get(targetId) ?? 3) !== generation) return;
			released.push({ targetId, generation });
			generations.set(targetId, generation + 1);
		},
		onRetire: (listener) => {
			retireListeners.add(listener);
			return () => retireListeners.delete(listener);
		},
	};
	const service = new AgentDaemonService({
		backend: CODEX_BACKEND,
		targets,
		daemonInstanceId: "daemon-1",
		send: (frame) => sent.push(frame),
		open: (child) =>
			CodexBackendSession.open(child, {
				now: () => clock,
				setTimer: (run, ms) => {
					timerSequence += 1;
					timers.set(timerSequence, { run, ms, cleared: false });
					return timerSequence as unknown as ReturnType<typeof setTimeout>;
				},
				clearTimer: (handle) => {
					const timer = timers.get(handle as unknown as number);
					if (timer) timer.cleared = true;
				},
			}),
		resolveHostCwd: options.resolveHostCwd ?? (() => "/home/agent"),
		threadsResumable: true,
		now: () => clock,
		setSweep: (run) => {
			sweeps.push(run);
			return sweeps.length as unknown as ReturnType<typeof setInterval>;
		},
		clearSweep: () => sweeps.splice(0),
	});
	const fireTimers = async () => {
		for (const timer of timers.values()) {
			if (timer.cleared) continue;
			timer.cleared = true;
			timer.run();
		}
		await settle();
	};
	const sweep = async (byMs = 0) => {
		clock += byMs;
		for (const run of [...sweeps]) run();
		await settle();
	};
	return {
		app,
		appFor,
		apps,
		service,
		sent,
		acquired,
		released,
		timers,
		fireTimers,
		sweep,
		advance: (ms: number) => (clock += ms),
		childExited: (targetId = TARGET_ID, generation = 3) => {
			for (const listener of retireListeners) listener(targetId, generation);
		},
	};
}

async function settle() {
	for (let tick = 0; tick < 60; tick += 1) await Promise.resolve();
}

function events(sent: Record<string, unknown>[]) {
	return sent.filter((frame) => frame.type === "codex_event").map((frame) => WIRE.event.parse(frame));
}

function receipts(sent: Record<string, unknown>[]) {
	return sent.filter((frame) => frame.type === "codex_receipt").map((frame) => WIRE.receipt.parse(frame));
}

describe("Codex on the generic daemon wire", () => {
	it("resolves host and container targets and forgets unavailable refusals", async () => {
		const hints: Array<string | undefined> = [];
		const host = setup({
			resolveHostCwd: (hint) => {
				hints.push(hint);
				return "/home/agent/Codex Support";
			},
		});
		host.service.handleCommand(startCommand({ target: { kind: "host", workdirHint: "Codex Support" } }));
		await settle();
		expect(hints).toEqual(["Codex Support"]);
		expect(host.appFor("host").requests.find((request) => request.method === "thread/start")?.params).toMatchObject(
			{
				cwd: "/home/agent/Codex Support",
			},
		);

		const container = setup();
		container.service.handleCommand(startCommand());
		await settle();
		expect(container.app.requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
			cwd: "/workspace/recipe-app",
		});
		expect(receipts(container.sent)).toMatchObject([
			{ kind: "accepted", resolvedTarget: { targetId: TARGET_ID, cwd: "/workspace/recipe-app" } },
		]);

		const unavailable = setup({ availability: { state: "unavailable", errorClass: "noSuchContainer" } });
		unavailable.service.handleCommand(startCommand());
		await settle();
		expect(receipts(unavailable.sent)).toMatchObject([{ kind: "rejected", agentId: AGENT_ID }]);
		unavailable.sent.length = 0;
		unavailable.service.replay();
		expect(unavailable.sent).toEqual([]);
	});

	it("starts and steers turns, then sends live and rebuilt answers", async () => {
		const context = setup();
		const start = startCommand();
		context.service.handleCommand(start);
		await settle();
		const firstReceipt = receipts(context.sent).at(-1);
		expect(firstReceipt).toMatchObject({
			kind: "accepted",
			delivery: "started",
			sessionId: "thread-1",
			turnId: "turn-1",
		});
		const threadId = firstReceipt?.kind === "accepted" ? firstReceipt.sessionId : "";
		const app = context.app;
		expect(app.requests.map((request) => request.method)).toEqual([
			"initialize",
			"initialized",
			"model/list",
			"thread/start",
			"turn/start",
		]);

		context.service.handleCommand(message(threadId, "Also check the lexer", "turn-1"));
		await settle();
		expect(receipts(context.sent).at(-1)).toMatchObject({
			kind: "accepted",
			delivery: "steered",
			turnId: "turn-1",
		});
		expect(app.requests.at(-1)).toMatchObject({ method: "turn/steer", params: { expectedTurnId: "turn-1" } });

		app.emit(item(threadId, "turn-1", { id: "note", text: "Reading the parser", phase: "commentary" }));
		app.emit(item(threadId, "turn-1", { id: "answer", text: "THE ANSWER", phase: "final_answer" }));
		app.emit(terminal(threadId, "turn-1"));
		await settle();
		expect(events(context.sent)).toMatchObject([
			{ kind: "activity", sessionId: threadId, turnId: "turn-1", text: "Reading the parser" },
			{
				kind: "terminal",
				sessionId: threadId,
				turnId: "turn-1",
				state: "completed",
				finalResponse: "THE ANSWER",
			},
		]);

		context.service.handleCommand(message(threadId, "Continue"));
		await settle();
		expect(receipts(context.sent).at(-1)).toMatchObject({
			kind: "accepted",
			delivery: "started",
			turnId: "turn-2",
		});
		expect(app.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
		app.emit(item(threadId, "turn-2", { id: "answer-2", text: "Done", phase: "final_answer" }));
		app.emit(terminal(threadId, "turn-2"));
		await settle();

		const rebuilt = setup();
		rebuilt.app.setRead(read("thread-9", [settledTurn("turn-2", "Recovered answer")]));
		rebuilt.service.handleCommand(reconcile("thread-9", "turn-2"));
		await settle();
		expect(receipts(rebuilt.sent).at(-1)).toMatchObject({ kind: "reconciled", turnState: "completed" });
		expect(events(rebuilt.sent).at(-1)).toMatchObject({
			kind: "terminal",
			turnId: "turn-2",
			state: "completed",
			finalResponse: "Recovered answer",
		});
	});

	it("keeps commentary out of the final answer when archiving is refused", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.failArchive();
		context.app.setRead(read("thread-1", [{ id: "turn-1", status: "inProgress", items: [] }]));
		context.app.emit(item("thread-1", "turn-1", { id: "note", text: "Still working", phase: "commentary" }));
		context.app.emit(item("thread-1", "turn-1", { id: "answer", text: "Done", phase: "final_answer" }));
		context.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		expect(events(context.sent)).toMatchObject([
			{ kind: "activity", text: "Still working" },
			{ kind: "terminal", state: "completed", finalResponse: "Done" },
		]);
		expect(context.app.requests.some((request) => request.method === "thread/archive")).toBe(true);
	});

	it("reconciles unknown, running, and moved-on turns from thread reads", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.emit(item("thread-1", "turn-1", { id: "answer", text: "Done", phase: "final_answer" }));
		context.app.emit(terminal("thread-1", "turn-1"));
		await settle();

		context.app.setRead(read("thread-1", [{ id: "turn-9", status: "inProgress", items: [] }]));
		context.service.handleCommand(reconcile("thread-1", "turn-9"));
		await settle();
		expect(receipts(context.sent).at(-1)).toMatchObject({
			kind: "reconciled",
			turnId: "turn-9",
			turnState: "inProgress",
		});

		context.app.setRead(
			read("thread-1", [
				settledTurn("turn-8", "Earlier answer"),
				{ id: "turn-9", status: "inProgress", items: [] },
			]),
		);
		context.service.handleCommand(reconcile("thread-1", "turn-8"));
		await settle();
		expect(receipts(context.sent).at(-1)).toMatchObject({
			kind: "reconciled",
			turnId: "turn-8",
			turnState: "completed",
		});
		expect(events(context.sent).at(-1)).toMatchObject({ turnId: "turn-8", finalResponse: "Earlier answer" });

		context.app.setRead(read("thread-9", [{ id: "turn-99", status: "inProgress", items: [] }]));
		context.service.handleCommand(reconcile("thread-9", "turn-99"));
		await settle();
		expect(receipts(context.sent).at(-1)).toMatchObject({ kind: "reconciled", turnId: "turn-99" });
		expect(receipts(context.sent).at(-1)).not.toHaveProperty("turnState");

		context.app.setRead(read("thread-9", []));
		context.service.handleCommand(reconcile("thread-9", "turn-99"));
		await settle();
		expect(receipts(context.sent).at(-1)).toMatchObject({ kind: "reconciled", turnId: "turn-99" });
		expect(receipts(context.sent).at(-1)).not.toHaveProperty("turnState");
	});

	it("holds a missing final item to its deadline and publishes through an archive refusal", async () => {
		vi.useFakeTimers();
		try {
			const context = setup();
			context.service.handleCommand(startCommand());
			await settle();
			context.app.failArchive();
			context.app.emit(item("thread-1", "turn-1", { id: "note", text: "Not the answer", phase: "commentary" }));
			context.app.emit(terminal("thread-1", "turn-1"));
			await settle();
			expect(events(context.sent).filter((event) => event.kind === "terminal")).toEqual([]);
			expect([...context.timers.values()].filter((timer) => !timer.cleared).map((timer) => timer.ms)).toEqual([
				10_000,
			]);

			await context.fireTimers();
			expect(events(context.sent)).toMatchObject([
				{ kind: "activity", text: "Not the answer" },
				{ kind: "terminal", state: "completed", finalResponse: "" },
			]);
			expect(context.app.requests.some((request) => request.method === "thread/archive")).toBe(true);
			await vi.advanceTimersByTimeAsync(250);
			await settle();
		} finally {
			vi.useRealTimers();
		}
	});

	it("ends every live turn when its child exits", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		context.service.handleCommand(startCommand({ agentId: SECOND_AGENT_ID }));
		await settle();
		expect(receipts(context.sent).filter((receipt) => receipt.kind === "accepted")).toHaveLength(2);

		context.app.exit();
		await settle();
		expect(events(context.sent).filter((event) => event.kind === "terminal")).toMatchObject([
			{ agentId: AGENT_ID, sessionId: "thread-1", state: "interrupted" },
			{ agentId: SECOND_AGENT_ID, sessionId: "thread-2", state: "interrupted" },
		]);
		expect(context.service.hello()).toMatchObject({ targets: [] });
	});

	it("retires a poisoned generation and serves the next command fresh", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.failRead();
		context.service.handleCommand(reconcile("thread-1", "turn-9"));
		await settle();
		expect(context.released).toEqual([{ targetId: TARGET_ID, generation: 3 }]);
		expect(events(context.sent)).toMatchObject([{ kind: "terminal", turnId: "turn-1", state: "interrupted" }]);

		context.service.handleCommand(startCommand());
		await settle();
		expect(context.acquired.slice(-2)).toEqual([
			{ targetId: TARGET_ID, generation: 3 },
			{ targetId: TARGET_ID, generation: 4 },
		]);
		expect(receipts(context.sent).at(-1)).toMatchObject({ kind: "accepted", generation: 4 });
	});

	it("releases an opening client that finishes after shutdown", async () => {
		const context = setup();
		context.app.blockInitialize();
		context.service.handleCommand(startCommand());
		await settle();
		context.service.shutdown();
		context.app.releaseInitialize();
		await settle();
		expect(context.released).toEqual([{ targetId: TARGET_ID, generation: 3 }]);
		expect(receipts(context.sent).filter((receipt) => receipt.kind === "accepted")).toEqual([]);
		expect(events(context.sent)).toEqual([]);
	});

	it("releases a child that exits before its session opens", async () => {
		const context = setup();
		context.app.blockInitialize();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.exit();
		await settle();
		expect(context.released).toEqual([{ targetId: TARGET_ID, generation: 3 }]);
		expect(receipts(context.sent).at(-1)).toMatchObject({ kind: "rejected" });
	});

	it("starts one replacement turn when a steer races its terminal", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.blockSteer();
		context.service.handleCommand(message("thread-1", "Continue", "turn-1"));
		await settle();
		context.app.emit(item("thread-1", "turn-1", { id: "answer", text: "Done", phase: "final_answer" }));
		context.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		context.app.failSteer();
		context.app.releaseSteer();
		await settle();

		const accepted = receipts(context.sent).filter((receipt) => receipt.kind === "accepted");
		expect(accepted).toHaveLength(2);
		expect(accepted.at(-1)).toMatchObject({ delivery: "started", turnId: "turn-2" });
		expect(context.app.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
		expect(context.app.requests.some((request) => request.method === "thread/read")).toBe(false);

		const refused = setup();
		refused.service.handleCommand(startCommand());
		await settle();
		refused.app.failSteer();
		refused.service.handleCommand(message("thread-1", "Again", "turn-1"));
		await settle();
		expect(receipts(refused.sent).at(-1)).toMatchObject({ kind: "rejected" });
		expect(refused.app.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
	});

	it("reports successful and failed interrupts on the Codex wire", async () => {
		const delivered = setup();
		delivered.service.handleCommand(startCommand());
		await settle();
		delivered.service.handleCommand(interrupt("thread-1", "turn-1"));
		await settle();
		expect(receipts(delivered.sent).at(-1)).toMatchObject({ kind: "interruptResult", ok: true, turnId: "turn-1" });
		delivered.app.emit(item("thread-1", "turn-1", { id: "answer", text: "Stopped", phase: "final_answer" }));
		delivered.app.emit(terminal("thread-1", "turn-1", "interrupted"));
		await settle();
		expect(events(delivered.sent).at(-1)).toMatchObject({ kind: "terminal", state: "interrupted" });

		const failed = setup();
		failed.service.handleCommand(startCommand());
		await settle();
		failed.app.failInterrupt();
		failed.service.handleCommand(interrupt("thread-1", "turn-1"));
		await settle();
		expect(receipts(failed.sent).at(-1)).toMatchObject({ kind: "interruptResult", ok: false });
	});

	it("terminalizes a held turn on shutdown without firing its deadline", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		context.service.shutdown();
		await context.fireTimers();
		expect(events(context.sent)).toMatchObject([{ kind: "terminal", turnId: "turn-1", state: "interrupted" }]);
		expect(events(context.sent).filter((event) => event.kind === "terminal")).toHaveLength(1);
	});

	it("replays reliable receipts and announces live Codex targets", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		const accepted = receipts(context.sent).at(-1);
		expect(context.service.hello()).toEqual({
			type: "codex_hello",
			daemonInstanceId: "daemon-1",
			targets: [{ targetId: TARGET_ID, generation: 3 }],
		});
		context.sent.length = 0;
		context.service.replay();
		expect(receipts(context.sent)).toHaveLength(1);
		context.sent.length = 0;
		if (accepted?.kind !== "accepted") throw new Error("start receipt missing");
		context.service.acknowledge({
			type: "codex_ack",
			daemonInstanceId: "daemon-1",
			targetId: TARGET_ID,
			generation: 3,
			throughEventId: accepted.eventId,
		});
		context.service.replay();
		expect(context.sent).toEqual([]);
	});

	it("ignores malformed commands and refuses valid commands after shutdown", async () => {
		const context = setup();
		context.service.handleCommand({ ...startCommand(), prompt: "   " });
		await settle();
		expect(context.acquired).toEqual([]);
		context.service.shutdown();
		context.service.handleCommand(startCommand());
		await settle();
		expect(receipts(context.sent)).toMatchObject([{ kind: "rejected" }]);
	});

	it("holds an in-flight read off the idle reap", async () => {
		const context = setup();
		context.service.handleCommand(startCommand());
		await settle();
		context.app.emit(item("thread-1", "turn-1", { id: "answer", text: "Done", phase: "final_answer" }));
		context.app.emit(terminal("thread-1", "turn-1"));
		await settle();
		context.app.setRead(read("thread-1", [settledTurn("turn-1", "Done")]));
		context.app.blockNextRead();
		context.service.handleCommand(reconcile("thread-1", "turn-1"));
		await settle();
		await context.sweep(600_000);
		expect(context.released).toEqual([]);

		context.app.releaseRead();
		await settle();
		await context.sweep(600_000);
		expect(context.released).toEqual([{ targetId: TARGET_ID, generation: 3 }]);
		context.service.handleCommand(message("thread-1", "Continue"));
		await settle();
		expect(context.acquired.at(-1)).toEqual({ targetId: TARGET_ID, generation: 4 });
		expect(receipts(context.sent).at(-1)).toMatchObject({ kind: "accepted", delivery: "started" });
	});
});
