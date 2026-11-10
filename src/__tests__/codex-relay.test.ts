import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexAgentCommands } from "../gateway/codexAgentCommands.js";
import { CodexAgentService } from "../gateway/codexAgentService.js";
import { CodexRelay } from "../gateway/codexRelay.js";
import { CodexRoute } from "../gateway/codexRoute.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/wsTypes.js";
import { processAmbient } from "../shared/ambient.js";
import type {
	CodexDaemonCommand,
	CodexDaemonEvent,
	CodexDaemonHello,
	CodexDaemonReceipt,
	CodexEventAck,
} from "../shared/codex-agent.js";
import {
	CodexAgentResultSchema,
	CodexDaemonCommandSchema,
	CodexDaemonEventSchema,
	CodexDaemonHelloSchema,
	CodexDaemonReceiptSchema,
	CodexEventAckSchema,
	codexAgentIdForOperation,
} from "../shared/codex-agent.js";
import { type CodexCatalogWriter, SessionStore } from "../shared/session-store.js";

const targetId = "container:recipe-app";
const resolvedTarget = { kind: "devcontainer" as const, targetId, cwd: "/workspace/recipe-app" };
const operations = {
	start: "123e4567-e89b-42d3-a456-426614174000",
	stop: "123e4567-e89b-42d3-a456-426614174009",
	message: "123e4567-e89b-42d3-a456-42661417400a",
};
const dirs: string[] = [];

function setup(
	options: {
		attached?: boolean;
		project?: string;
		waitBudgetMs?: number;
		ambient?: ReturnType<typeof processAmbient>;
	} = {},
) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-relay-"));
	dirs.push(dir);
	let catalogWriter: CodexCatalogWriter | undefined;
	let store!: SessionStore;
	store = new SessionStore({
		ambient: processAmbient(),
		codexCatalogPersistence: {
			persistChecked: () => {
				fs.writeFileSync(path.join(dir, "session-resume.json"), JSON.stringify(store.snapshot()));
				return true;
			},
			receiveWriter: (writer) => {
				catalogWriter = writer;
			},
		},
	});
	const registry: TeamRegistry = new Map();
	const auth = createSessionAuthority({
		sessionStore: store,
		registry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => "alice",
		localGatewayId: "sakura",
	});
	if (!catalogWriter) throw new Error("catalog writer unavailable");
	const service = new CodexAgentService({
		auth,
		sessionStore: store,
		offlineCatalog: new Map([["recipe-app", "/trusted/recipe-app"]]),
		catalogWriter,
	});
	const ambient = options.ambient ?? processAmbient();
	let liveDaemonInstanceId: string | undefined = "daemon-1";
	let attached = options.attached ?? true;
	const outbound: (CodexDaemonCommand | CodexEventAck)[] = [];
	const relay = new CodexRelay({
		service,
		sessionStore: store,
		liveDaemonInstanceId: () => liveDaemonInstanceId,
		ambient,
		sendToHost: (message) => {
			if (!attached) return false;
			outbound.push(
				message.type === "codex_ack"
					? CodexEventAckSchema.parse(message)
					: CodexDaemonCommandSchema.parse(message),
			);
			return true;
		},
	});
	const owner = store.mint({ spawn: options.project ?? "recipe-app", sessionLabel: "Work", harness: "claude" });
	const token = store.ensureBindToken(owner);
	store.activateBinding(owner);
	store.confirm(store.teamOf(owner));
	const route = new CodexRoute({
		service,
		relay,
		commands: createCodexAgentCommands({
			service,
			relay,
			readLiveness: () => ({
				socket: {} as never,
				daemonInstanceId: liveDaemonInstanceId,
				containerInCatalog: (target) => target.kind === "devcontainer",
			}),
			ambient,
		}),
		ambient,
		waitBudgetMs: options.waitBudgetMs ?? 100,
	});
	const request = (tokenValue = token) =>
		new Request("http://gateway/codex", { method: "POST", headers: { "x-session-token": tokenValue } });
	const feed = (value: CodexDaemonReceipt | CodexDaemonEvent | CodexDaemonHello) => relay.handleHostMessage(value);
	const registerHost = (daemonInstanceId: string) => {
		liveDaemonInstanceId = daemonInstanceId;
		relay.onHostRegister();
	};
	const agent = (agentId = codexAgentIdForOperation(operations.start)) =>
		store.listCodexAgents(owner).find((candidate) => candidate.agentId === agentId);
	const commands = () => outbound.filter((frame): frame is CodexDaemonCommand => frame.type === "codex_command");
	return {
		service,
		relay,
		route,
		store,
		owner,
		token,
		outbound,
		commands,
		request,
		feed,
		registerHost,
		agent,
		setAttached: (value: boolean) => (attached = value),
	};
}

function accepted(context: ReturnType<typeof setup>, operationId = operations.start, eventId = 0) {
	const command = context
		.commands()
		.find((candidate) => candidate.kind === "start" && candidate.operationId === operationId);
	if (!command) throw new Error("start command unavailable");
	context.feed(
		CodexDaemonReceiptSchema.parse({
			type: "codex_receipt",
			kind: "accepted",
			requestId: command.requestId,
			ownerKey: context.store.teamOf(context.owner),
			daemonInstanceId: "daemon-1",
			targetId,
			generation: 1,
			eventId,
			agentId: command.agentId,
			operationId,
			resolvedTarget,
			threadId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
		}),
	);
}

async function startWorking(context: ReturnType<typeof setup>) {
	const pending = context.route.handle(context.request(), {
		kind: "start",
		operationId: operations.start,
		prompt: "Audit the parser",
	});
	await Promise.resolve();
	accepted(context);
	await pending;
}

async function settle() {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function collectUntilTurn(context: ReturnType<typeof setup>, agentId: string) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const body = await (await context.route.handle(context.request(), { kind: "await", agentId })).json();
		if (Array.isArray(body.turns) && body.turns.length > 0) return body;
		await settle();
	}
	throw new Error(`await did not collect an ended turn for ${agentId}`);
}

function event(context: ReturnType<typeof setup>, eventId: number, extra: Record<string, unknown>) {
	return CodexDaemonEventSchema.parse({
		type: "codex_event",
		ownerKey: context.store.teamOf(context.owner),
		daemonInstanceId: "daemon-1",
		targetId,
		generation: 1,
		eventId,
		agentId: codexAgentIdForOperation(operations.start),
		threadId: "thread-1",
		turnId: "turn-1",
		...extra,
	});
}

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Codex relay behavior", () => {
	it("accepts a start and collects its terminal result", async () => {
		const context = setup();
		const pending = context.route.handle(context.request(), {
			kind: "start",
			operationId: operations.start,
			prompt: "Audit the parser",
		});
		await Promise.resolve();
		accepted(context);
		await settle();
		const running = await (
			await context.route.handle(context.request(), {
				kind: "await",
				agentId: codexAgentIdForOperation(operations.start),
			})
		).json();
		expect(running).toMatchObject({
			agentId: codexAgentIdForOperation(operations.start),
			agentState: "working",
			running: "turn-1",
			turns: [],
		});
		context.feed(event(context, 1, { kind: "activity", itemId: "item-1", text: "reading" }));
		context.feed(event(context, 2, { kind: "terminal", state: "completed", finalResponse: "done" }));
		const started = CodexAgentResultSchema.parse(await (await pending).json());
		const body = await collectUntilTurn(context, started.agentId);

		expect(started).toMatchObject({
			agentState: "working",
			observation: "accepted",
			turn: { state: "inProgress" },
			delivery: "started",
		});
		expect(body).toMatchObject({
			agentId: started.agentId,
			agentState: "idle",
			running: null,
			turns: [
				{
					id: "turn-1",
					state: "completed",
					delivery: "started",
					activities: [{ kind: "commentary", text: "reading" }],
					finalResponse: "done",
				},
			],
		});
		const empty = await (
			await context.route.handle(context.request(), { kind: "await", agentId: started.agentId })
		).json();
		expect(empty).toMatchObject({ agentId: started.agentId, running: null, turns: [] });
		expect(context.agent()?.turns[0]).toMatchObject({ state: "completed", activities: [{ itemId: "item-1" }] });
		expect(context.commands().find((frame) => frame.kind === "start")).toMatchObject({
			ownerKey: context.store.teamOf(context.owner),
			agentId: body.agentId,
			kind: "start",
		});
	});

	it("maps a rejected start to an unavailable result and preserves the refusal", async () => {
		const context = setup();
		const pending = context.route.handle(context.request(), {
			kind: "start",
			operationId: operations.start,
			prompt: "Audit",
		});
		await Promise.resolve();
		const command = context.commands().find((frame) => frame.kind === "start")!;
		context.feed(
			CodexDaemonReceiptSchema.parse({
				type: "codex_receipt",
				kind: "rejected",
				requestId: command.requestId,
				ownerKey: context.store.teamOf(context.owner),
				daemonInstanceId: "daemon-1",
				eventId: 0,
				agentId: command.agentId,
				operationId: operations.start,
				error: "target unavailable",
			}),
		);
		await settle();
		const body = CodexAgentResultSchema.parse(await (await pending).json());
		expect(body).toMatchObject({
			agentState: "unavailable",
			observation: "indeterminate",
			error: { retryable: true },
		});
		expect(context.agent()).toMatchObject({ agentState: "unavailable" });
	});

	it.each([
		["interrupt receipt then terminal", ["receipt", "terminal"]],
		["terminal then interrupt receipt", ["terminal", "receipt"]],
	])("completes an interrupt race: %s", async (_name, order) => {
		const context = setup();
		await startWorking(context);
		const stop = context.route.handle(context.request(), {
			kind: "stop",
			operationId: operations.stop,
			agentId: codexAgentIdForOperation(operations.start),
		});
		await Promise.resolve();
		const interrupt = context.commands().find((frame) => frame.kind === "interrupt")!;
		for (const step of order) {
			if (step === "receipt") {
				context.feed(
					CodexDaemonReceiptSchema.parse({
						type: "codex_receipt",
						kind: "interruptResult",
						requestId: interrupt.requestId,
						ownerKey: context.store.teamOf(context.owner),
						daemonInstanceId: "daemon-1",
						targetId,
						generation: 1,
						eventId: 1,
						agentId: interrupt.agentId,
						operationId: operations.stop,
						threadId: "thread-1",
						turnId: "turn-1",
						ok: true,
					}),
				);
			} else context.feed(event(context, 2, { kind: "terminal", state: "completed", finalResponse: "finished" }));
			await settle();
		}
		await stop;
		expect(context.agent()).toMatchObject({ agentState: "idle", pendingInterrupt: undefined });
		expect(context.agent()?.turns[0]?.state).toBe("completed");
	});

	it("refuses a second message while the first delivery is unresolved", async () => {
		const context = setup();
		await startWorking(context);
		const first = context.route.handle(context.request(), {
			kind: "message",
			operationId: operations.message,
			agentId: codexAgentIdForOperation(operations.start),
			prompt: "Continue",
		});
		await Promise.resolve();
		const second = await context.route.handle(context.request(), {
			kind: "message",
			operationId: "223e4567-e89b-42d3-a456-426614174000",
			agentId: codexAgentIdForOperation(operations.start),
			prompt: "Again",
		});
		expect(second.status).toBe(400);
		context.feed(
			CodexDaemonReceiptSchema.parse({
				type: "codex_receipt",
				kind: "accepted",
				requestId: context.commands().find((frame) => frame.kind === "message")!.requestId,
				ownerKey: context.store.teamOf(context.owner),
				daemonInstanceId: "daemon-1",
				targetId,
				generation: 1,
				eventId: 3,
				agentId: codexAgentIdForOperation(operations.start),
				operationId: operations.message,
				resolvedTarget,
				threadId: "thread-1",
				turnId: "turn-2",
				delivery: "steered",
			}),
		);
		await first;
	});

	it.each([
		["a reaped target relaunched", "daemon-1", 2],
		["a restarted daemon", "daemon-2", 1],
	])(
		"accepts an idle agent's follow-up to %s and awaits its terminal result",
		async (_name, daemonInstanceId, generation) => {
			const context = setup({ waitBudgetMs: 1_000 });
			await startWorking(context);
			context.feed(event(context, 1, { kind: "terminal", state: "completed", finalResponse: "done" }));
			await settle();
			const agentId = codexAgentIdForOperation(operations.start);
			await collectUntilTurn(context, agentId);
			if (daemonInstanceId !== "daemon-1") context.registerHost(daemonInstanceId);
			const pending = context.route.handle(context.request(), {
				kind: "message",
				operationId: operations.message,
				agentId,
				prompt: "Again",
			});
			await settle();
			const command = context.commands().find((frame) => frame.kind === "message")!;
			const stream = { ownerKey: context.store.teamOf(context.owner), daemonInstanceId, targetId, generation };
			context.feed(
				CodexDaemonReceiptSchema.parse({
					type: "codex_receipt",
					kind: "accepted",
					requestId: command.requestId,
					...stream,
					eventId: 0,
					agentId,
					operationId: operations.message,
					resolvedTarget,
					threadId: "thread-1",
					turnId: "turn-2",
					delivery: "started",
				}),
			);
			context.feed(
				CodexDaemonEventSchema.parse({
					...event(context, 1, { kind: "terminal", state: "completed", finalResponse: "again" }),
					...stream,
					turnId: "turn-2",
				}),
			);

			const acceptedAnswer = CodexAgentResultSchema.parse(await (await pending).json());
			const terminalAnswer = await collectUntilTurn(context, agentId);
			expect(acceptedAnswer).toMatchObject({
				agentState: "working",
				observation: "accepted",
				turn: { id: "turn-2", state: "inProgress" },
				delivery: "started",
			});
			expect(terminalAnswer).toMatchObject({
				agentId,
				agentState: "idle",
				running: null,
				turns: [{ id: "turn-2", state: "completed", finalResponse: "again" }],
			});
		},
	);

	it("re-fences held frames after a new hello generation and ignores stale frames", async () => {
		const context = setup();
		await startWorking(context);
		context.feed(event(context, 1, { kind: "activity", turnId: "unknown-turn", itemId: "held", text: "held" }));
		await settle();
		context.registerHost("daemon-2");
		context.feed(
			CodexDaemonHelloSchema.parse({
				type: "codex_hello",
				daemonInstanceId: "daemon-2",
				targets: [{ targetId, generation: 2 }],
			}),
		);
		await settle();
		const reconcile = context
			.commands()
			.filter((frame) => frame.kind === "reconcile")
			.at(-1);
		expect(reconcile).toMatchObject({ agentId: codexAgentIdForOperation(operations.start), threadId: "thread-1" });
		context.feed(
			CodexDaemonReceiptSchema.parse({
				type: "codex_receipt",
				kind: "reconciled",
				requestId: reconcile!.requestId,
				ownerKey: context.store.teamOf(context.owner),
				daemonInstanceId: "daemon-2",
				targetId,
				generation: 2,
				eventId: 0,
				agentId: reconcile!.agentId,
				resolvedTarget,
				threadId: "thread-1",
				turnId: "turn-1",
				turnState: "inProgress",
			}),
		);
		context.feed(event(context, 0, { kind: "activity", itemId: "stale", text: "stale" }));
		context.feed(
			CodexDaemonEventSchema.parse({
				...event(context, 1, { kind: "activity", itemId: "fresh", text: "fresh" }),
				daemonInstanceId: "daemon-2",
				generation: 2,
			}),
		);
		await settle();
		expect(
			context.agent()?.turns[0]?.activities.flatMap((item) => (item.kind === "commentary" ? [item.itemId] : [])),
		).toEqual(["fresh"]);

		// Neither late answer moves the fence.
		const late = (stream: { daemonInstanceId: string; generation: number }) =>
			CodexDaemonReceiptSchema.parse({
				type: "codex_receipt",
				kind: "reconciled",
				requestId: reconcile!.requestId,
				ownerKey: context.store.teamOf(context.owner),
				...stream,
				targetId,
				eventId: 9,
				agentId: reconcile!.agentId,
				resolvedTarget,
				threadId: "thread-1",
			});
		context.feed(late({ daemonInstanceId: "daemon-1", generation: 1 }));
		context.feed(late({ daemonInstanceId: "daemon-2", generation: 1 }));
		await settle();
		expect(context.agent()?.fence).toMatchObject({ daemonInstanceId: "daemon-2", generation: 2 });
	});

	it("reasks after a refused reconciliation and settles the lost turn", async () => {
		let now = 1_000;
		const ambient = { ...processAmbient(), now: () => now };
		const context = setup({ ambient, waitBudgetMs: 1_000 });
		await startWorking(context);
		context.registerHost("daemon-2");
		context.feed(
			CodexDaemonHelloSchema.parse({
				type: "codex_hello",
				daemonInstanceId: "daemon-2",
				targets: [{ targetId, generation: 2 }],
			}),
		);
		await settle();
		const first = context.commands().find((command) => command.kind === "reconcile");
		expect(first).toBeDefined();
		context.feed(
			CodexDaemonReceiptSchema.parse({
				type: "codex_receipt",
				kind: "rejected",
				requestId: first!.requestId,
				ownerKey: context.store.teamOf(context.owner),
				daemonInstanceId: "daemon-2",
				eventId: 0,
				agentId: first!.agentId,
				error: "target unavailable",
			}),
		);
		await settle();

		now += 299_999;
		context.relay.reconcileStale(context.owner);
		await settle();
		expect(context.commands().filter((command) => command.kind === "reconcile")).toHaveLength(1);

		now += 1;
		context.relay.reconcileStale(context.owner);
		await settle();
		const second = context.commands().filter((command) => command.kind === "reconcile")[1];
		expect(second).toBeDefined();
		context.feed(
			CodexDaemonReceiptSchema.parse({
				type: "codex_receipt",
				kind: "reconciled",
				requestId: second!.requestId,
				ownerKey: context.store.teamOf(context.owner),
				daemonInstanceId: "daemon-2",
				targetId,
				generation: 2,
				eventId: 1,
				agentId: second!.agentId,
				resolvedTarget,
				threadId: "thread-1",
			}),
		);
		await settle();
		expect(context.agent()).toMatchObject({
			agentState: "idle",
			turns: [{ state: "interrupted", reason: "turn lost: its agent process ended" }],
		});
	});

	it("asks a new daemon immediately after the previous daemon refused", async () => {
		const context = setup();
		await startWorking(context);
		context.registerHost("daemon-2");
		await settle();
		context.feed(
			CodexDaemonHelloSchema.parse({
				type: "codex_hello",
				daemonInstanceId: "daemon-2",
				targets: [{ targetId, generation: 2 }],
			}),
		);
		await settle();
		const first = context.commands().find((command) => command.kind === "reconcile");
		expect(first).toBeDefined();
		context.feed(
			CodexDaemonReceiptSchema.parse({
				type: "codex_receipt",
				kind: "rejected",
				requestId: first!.requestId,
				ownerKey: context.store.teamOf(context.owner),
				daemonInstanceId: "daemon-2",
				eventId: 0,
				agentId: first!.agentId,
				error: "target unavailable",
			}),
		);
		await settle();

		context.registerHost("daemon-3");
		await settle();
		context.feed(
			CodexDaemonHelloSchema.parse({
				type: "codex_hello",
				daemonInstanceId: "daemon-3",
				targets: [{ targetId, generation: 3 }],
			}),
		);
		await settle();
		expect(context.commands().filter((command) => command.kind === "reconcile")).toHaveLength(2);
	});

	it("maps disconnect and timeout answers, isolates owners, and replays an operation answer", async () => {
		const disconnected = setup({ attached: false, waitBudgetMs: 1_000 });
		const disconnectedBody = CodexAgentResultSchema.parse(
			await (
				await disconnected.route.handle(disconnected.request(), {
					kind: "start",
					operationId: operations.start,
					prompt: "Audit",
				})
			).json(),
		);
		expect(disconnectedBody).toMatchObject({
			agentState: "unavailable",
			error: { code: "daemon_unavailable", retryable: true },
		});
		expect(disconnected.commands()).toEqual([]);
		const awaited = await (
			await disconnected.route.handle(disconnected.request(), {
				kind: "await",
				agentId: codexAgentIdForOperation(operations.start),
			})
		).json();
		expect(awaited).toMatchObject({ agentState: "unavailable", error: { code: "agent_dead" } });

		const context = setup({ waitBudgetMs: 10 });
		const first = { kind: "start", operationId: operations.start, prompt: "Audit" } as const;
		const firstBody = await (await context.route.handle(context.request(), first)).json();
		const replayBody = await (await context.route.handle(context.request(), first)).json();
		expect(replayBody).toEqual(firstBody);
		const other = context.store.mint({ spawn: "recipe-app", sessionLabel: "Other", harness: "claude" });
		const otherToken = context.store.ensureBindToken(other);
		context.store.activateBinding(other);
		context.store.confirm(context.store.teamOf(other));
		const foreign = await (await context.route.handle(context.request(otherToken), { kind: "list" })).json();
		expect(foreign.agents).toEqual([]);
	});
});
