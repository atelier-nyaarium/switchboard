import { describe, expect, it } from "vitest";
import { createAgentCommands } from "../gateway/agentCommands.js";
import { AgentRelay } from "../gateway/agentRelay.js";
import { RECONCILE_GUARD_MS } from "../gateway/agentRelayCore.js";
import { AgentRoute } from "../gateway/agentRoute.js";
import { AgentService } from "../gateway/agentService.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/wsTypes.js";
import { CopilotBackendSession, copilotFailureCode } from "../mcp/agents/copilotSession.js";
import { AgentDaemonService } from "../mcp/devcontainer/agentDaemonService.js";
import type { AgentChild, TargetSupervisor } from "../mcp/devcontainer/agentTargets.js";
import type { CopilotHeadlessClient } from "../mcp/devcontainer/copilotHeadless.js";
import { COPILOT_BACKEND } from "../shared/agent-backend.js";
import { agentIdForOperation } from "../shared/agent-record.js";
import { AgentResultSchema } from "../shared/agent-state.js";
import { processAmbient } from "../shared/ambient.js";
import { type PersistedAgentCatalogWriter, SessionStore } from "../shared/session-store.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const START_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const MESSAGE_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174001";
const STOP_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174002";

function setup(
	options: {
		dispatch?: boolean;
		waitBudgetMs?: number;
		restore?: unknown;
		ambient?: ReturnType<typeof processAmbient>;
		listModels?: ConstructorParameters<typeof AgentRoute>[0]["listModels"];
	} = {},
) {
	const ambient = options.ambient ?? processAmbient();
	let catalogWriter: PersistedAgentCatalogWriter | undefined;
	let writesLand: boolean | "throw" = true;
	const sessionStore = new SessionStore({
		ambient,
		agentCatalogPersistence: {
			persistChecked: () => {
				if (writesLand === "throw") throw new Error("disk full");
				return writesLand ? undefined : false;
			},
			receiveWriter: (backend, writer) => {
				if (backend === "copilot") catalogWriter = writer;
			},
		},
	});
	if (options.restore) sessionStore.restore(options.restore);
	const registry: TeamRegistry = new Map();
	const auth = createSessionAuthority({
		sessionStore,
		registry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => "alice",
		localGatewayId: "sakura",
	});
	if (!catalogWriter) throw new Error("catalog writer unavailable");
	const service = new AgentService({
		backend: COPILOT_BACKEND,
		auth,
		sessionStore,
		offlineCatalog: new Map([["recipe-app", "/trusted/recipe-app"]]),
		catalogWriter,
	});
	const sent: Record<string, unknown>[] = [];
	let liveDaemonInstanceId: string | undefined = "daemon-1";
	const relay = new AgentRelay({
		backendId: "copilot",
		service,
		sessionStore,
		liveDaemonInstanceId: () => liveDaemonInstanceId,
		ambient,
		sendToHost: (message) => {
			if (options.dispatch === false) return false;
			sent.push(message);
			return true;
		},
	});
	const owner =
		sessionStore.list()[0] ?? sessionStore.mint({ spawn: "recipe-app", sessionLabel: "Work", harness: "claude" });
	const token = sessionStore.ensureBindToken(owner);
	sessionStore.activateBinding(owner);
	sessionStore.confirm(sessionStore.teamOf(owner));
	const route = new AgentRoute({
		backend: COPILOT_BACKEND,
		service,
		relay,
		commands: createAgentCommands({
			backend: COPILOT_BACKEND,
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
		waitBudgetMs: options.waitBudgetMs ?? 1_000,
		listModels: options.listModels,
	});
	return {
		route,
		relay,
		sent,
		owner,
		token,
		service,
		sessionStore,
		registerHost: (daemonInstanceId: string) => {
			liveDaemonInstanceId = daemonInstanceId;
			relay.onHostRegister();
		},
		/** False leaves the write held and unconfirmed; "throw" rolls it back. */
		writes: (land: boolean | "throw") => {
			writesLand = land;
		},
	};
}

function post(token: string): Request {
	return new Request("http://gateway/copilot", {
		method: "POST",
		headers: { "x-session-token": token },
	});
}

async function flush(): Promise<void> {
	for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

async function collectUntilSettled(context: ReturnType<typeof setup>, agentId: string) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const response = await context.route.handle(post(context.token), { kind: "await", agentId });
		const body = (await response.json()) as { turns?: unknown[]; error?: { code?: string } };
		if (!Array.isArray(body.turns)) throw new Error(`collect for ${agentId} did not return turns`);
		if (body.turns.length > 0) return body;
		if (body.error) throw new Error(`collect for ${agentId} failed: ${body.error.code ?? "unknown error"}`);
		await flush();
	}
	throw new Error(`Copilot turn did not settle for ${agentId} after 20 collects`);
}

function commandFor(context: ReturnType<typeof setup>, operationId: string): Record<string, unknown> {
	const command = context.sent.find(
		(message) => message.type === "copilot_command" && message.operationId === operationId,
	);
	if (!command) throw new Error(`command not found: ${operationId}`);
	return command;
}

const FIRST_CHILD = { daemonInstanceId: "daemon-1", generation: 1 };

async function accept(
	context: ReturnType<typeof setup>,
	operationId: string,
	turnId: string,
	eventId: number,
	delivery: "started" | "steered",
	stream = FIRST_CHILD,
): Promise<void> {
	const command = commandFor(context, operationId);
	context.relay.handleHostMessage({
		type: "copilot_receipt",
		kind: "accepted",
		requestId: command.requestId,
		ownerKey: context.sessionStore.teamOf(context.owner),
		...stream,
		targetId: "container:recipe-app",
		eventId,
		agentId: command.agentId,
		operationId,
		resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
		sessionId: "session-1",
		turnId,
		delivery,
	});
	await flush();
}

async function terminal(
	context: ReturnType<typeof setup>,
	agentId: string,
	turnId: string,
	eventId: number,
	finalResponse = "Done.",
	stream = FIRST_CHILD,
): Promise<void> {
	context.relay.handleHostMessage({
		type: "copilot_event",
		kind: "terminal",
		ownerKey: context.sessionStore.teamOf(context.owner),
		...stream,
		targetId: "container:recipe-app",
		eventId,
		agentId,
		sessionId: "session-1",
		turnId,
		state: "completed",
		finalResponse,
	});
	await flush();
}

function hello(context: ReturnType<typeof setup>, daemonInstanceId: string, generation: number): Promise<void> {
	return context.relay.handleHostMessage({
		type: "copilot_hello",
		daemonInstanceId,
		targets: [{ targetId: "container:recipe-app", generation }],
	});
}

describe("the agent gateway route", () => {
	it("returns acceptance first and collects the terminal result", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const request = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		const runningCollect = await (
			await context.route.handle(post(context.token), { kind: "await", agentId })
		).json();
		expect(runningCollect).toMatchObject({ agentId, agentState: "working", running: "turn-1", turns: [] });
		context.relay.handleHostMessage({
			type: "copilot_event",
			kind: "activity",
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-1",
			targetId: "container:recipe-app",
			generation: 1,
			eventId: 1,
			agentId,
			sessionId: "session-1",
			turnId: "turn-1",
			itemId: "private-item",
			text: "Checking",
		});
		await flush();
		await terminal(context, agentId, "turn-1", 2);

		const response = await request;
		const acceptedBody = await response.json();
		const body = await collectUntilSettled(context, agentId);
		expect(response.status).toBe(200);
		expect(body).toMatchObject({ agentId, agentState: "idle", running: null, turns: expect.any(Array) });
		expect(acceptedBody).toMatchObject({
			agentState: "working",
			observation: "accepted",
			turn: { id: "turn-1", state: "inProgress" },
			delivery: "started",
		});
		expect(body).toMatchObject({
			agentId,
			turns: [
				{
					id: "turn-1",
					state: "completed",
					delivery: "started",
					activities: [{ kind: "commentary", text: "Checking" }],
					finalResponse: "Done.",
				},
			],
		});
		expect(body.turns?.[0]).toMatchObject({ activities: [{ kind: "commentary", text: "Checking" }] });
		expect(body.turns?.[0]).not.toHaveProperty("activities.0.itemId");
	});

	it("settles a turn when a restarted target cannot resume its session", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const starting = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await starting;

		context.registerHost("daemon-2");
		context.relay.handleHostMessage({
			type: "copilot_hello",
			daemonInstanceId: "daemon-2",
			targets: [{ targetId: "container:recipe-app", generation: 2 }],
		});
		await flush();
		const reconcile = context.sent.findLast(
			(frame) => frame.type === "copilot_command" && frame.kind === "reconcile",
		);
		expect(reconcile).toBeDefined();

		const receipts: Record<string, unknown>[] = [];
		const client = {
			onEvent: () => {},
			createSession: async () => "session-2",
			listModels: async () => [],
			resumeSession: async () => {
				throw new Error("session is no longer available");
			},
			send: async () => "message-1",
			abort: async () => {},
			close: () => {},
		} as unknown as CopilotHeadlessClient;
		const child = { onExit: () => {} } as unknown as AgentChild;
		const targets: TargetSupervisor = {
			acquire: () => ({ state: "running", lease: { generation: 2, child } }),
			release: () => {},
		};
		const daemon = new AgentDaemonService({
			backend: COPILOT_BACKEND,
			targets,
			daemonInstanceId: "daemon-2",
			send: (frame) => receipts.push(frame),
			open: (nextChild) => CopilotBackendSession.open(nextChild, async () => client),
			resolveHostCwd: () => "/home/agent",
			failureCode: copilotFailureCode,
		});
		daemon.handleCommand(reconcile);
		await flush();
		expect(receipts[0]).toMatchObject({
			kind: "reconciled",
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			turnId: "turn-1",
		});
		expect(receipts[0]).not.toHaveProperty("turnState");
		context.relay.handleHostMessage(receipts[0]!);
		await flush();

		const collected = await collectUntilSettled(context, agentId);
		expect(collected).toMatchObject({
			agentState: "idle",
			running: null,
			turns: [{ id: "turn-1", state: "interrupted", reason: "turn lost: its agent process ended" }],
		});
	});

	it("settles the prior turn before adopting a different turn from a new process", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const starting = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await starting;

		context.registerHost("daemon-2");
		context.relay.handleHostMessage({
			type: "copilot_hello",
			daemonInstanceId: "daemon-2",
			targets: [{ targetId: "container:recipe-app", generation: 2 }],
		});
		await flush();
		const reconcile = context.sent.findLast(
			(frame) => frame.type === "copilot_command" && frame.kind === "reconcile",
		);
		expect(reconcile).toBeDefined();
		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "reconciled",
			requestId: reconcile!.requestId,
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-2",
			targetId: "container:recipe-app",
			generation: 2,
			eventId: 0,
			agentId,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			sessionId: "session-1",
			turnState: "inProgress",
			turnId: "turn-2",
		});
		await flush();

		expect(context.service.listOwnedAgents(context.owner)[0]).toMatchObject({
			agentState: "working",
			activeTurnId: "turn-2",
			turns: [
				{ id: "turn-1", state: "interrupted", reason: "turn lost: its agent process ended" },
				{ id: "turn-2", state: "inProgress" },
			],
		});
	});

	it("steers a follow-up into the running turn the Gateway named, without a second turn", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
			reasoningEffort: "low",
			outputSchema: { type: "object" },
		});
		await flush();
		expect(commandFor(context, START_OPERATION_ID)).toMatchObject({
			reasoningEffort: "low",
			outputSchema: { type: "object" },
		});
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await started;

		const steered = context.route.handle(post(context.token), {
			kind: "message",
			operationId: MESSAGE_OPERATION_ID,
			agentId,
			prompt: "Also the lexer",
		});
		await flush();
		expect(commandFor(context, MESSAGE_OPERATION_ID)).toMatchObject({ expectedTurnId: "turn-1" });
		await accept(context, MESSAGE_OPERATION_ID, "turn-1", 1, "steered");
		const body = await (await steered).json();
		expect(() => AgentResultSchema.parse(body)).not.toThrow();
		expect(body).toMatchObject({
			agentState: "working",
			observation: "accepted",
			turn: { id: "turn-1", state: "inProgress" },
			delivery: "steered",
		});

		await terminal(context, agentId, "turn-1", 2);
		const settled = await collectUntilSettled(context, agentId);
		expect(settled.turns).toMatchObject([{ id: "turn-1", state: "completed", delivery: "steered" }]);
		const listed = await (await context.route.handle(post(context.token), { kind: "list", agentId })).json();
		expect(listed.agents[0]).toMatchObject({ running: false, uncollected: 0, turnCount: 1 });
	});

	it("answers a disconnected start without waiting out the budget", async () => {
		const context = setup({ dispatch: false, waitBudgetMs: 1_000 });
		const startedAt = performance.now();
		const response = await context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		const elapsed = performance.now() - startedAt;
		const body = await response.json();

		expect(elapsed).toBeLessThan(100);
		expect(body).toMatchObject({
			agentState: "unavailable",
			observation: "unavailable",
			error: { code: "daemon_unavailable", retryable: true },
		});
		expect(context.sent.filter((message) => message.type === "copilot_command")).toEqual([]);
		const dead = await (
			await context.route.handle(post(context.token), {
				kind: "await",
				agentId: agentIdForOperation("copilot", START_OPERATION_ID),
			})
		).json();
		expect(dead).toMatchObject({ agentState: "unavailable", error: { code: "agent_dead" } });
	});

	it("does not let a stale terminal settle a newer turn, and closes a racing stop", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const start = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await terminal(context, agentId, "turn-1", 1);
		const startAnswer = await start;
		expect(await startAnswer.json()).toMatchObject({
			observation: "accepted",
			turn: { id: "turn-1", state: "inProgress" },
		});

		const message = context.route.handle(post(context.token), {
			kind: "message",
			operationId: MESSAGE_OPERATION_ID,
			agentId,
			prompt: "Continue",
		});
		await flush();
		await accept(context, MESSAGE_OPERATION_ID, "turn-2", 2, "started");

		await terminal(context, agentId, "turn-1", 3, "stale");
		expect(context.service.listOwnedAgents(context.owner)[0]).toMatchObject({
			agentState: "working",
			activeTurnId: "turn-2",
		});

		const stop = await context.route.handle(post(context.token), {
			kind: "stop",
			operationId: STOP_OPERATION_ID,
			agentId,
		});
		expect(stop.status).toBe(200);
		await terminal(context, agentId, "turn-2", 4);
		await message;

		const agent = context.service.listOwnedAgents(context.owner)[0]!;
		expect(agent.agentState).toBe("idle");
		expect(agent.operations.find((operation) => operation.operationId === STOP_OPERATION_ID)?.state).toBe(
			"accepted",
		);
	});

	it("takes an idle agent's follow-up from a relaunched child, then drops a replaced daemon's reconciliation", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const start = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await terminal(context, agentId, "turn-1", 1);
		await start;

		const relaunched = { daemonInstanceId: "daemon-2", generation: 1 };
		context.registerHost(relaunched.daemonInstanceId);
		const message = context.route.handle(post(context.token), {
			kind: "message",
			operationId: MESSAGE_OPERATION_ID,
			agentId,
			prompt: "Continue",
		});
		await flush();
		await accept(context, MESSAGE_OPERATION_ID, "turn-2", 0, "started", relaunched);
		await terminal(context, agentId, "turn-2", 1, "Continued.", relaunched);

		const messageResponse = await message;
		expect(await messageResponse.json()).toMatchObject({
			observation: "accepted",
			turn: { id: "turn-2", state: "inProgress" },
			delivery: "followup",
		});
		const awaited = await collectUntilSettled(context, agentId);
		expect(awaited.turns).toMatchObject([
			{ id: "turn-1", state: "completed", delivery: "started", finalResponse: "Done." },
			{ id: "turn-2", state: "completed", delivery: "followup", finalResponse: "Continued." },
		]);
		expect(context.sent.filter((frame) => frame.kind === "reconcile")).toEqual([]);

		context.relay.handleHostMessage({
			type: "copilot_hello",
			daemonInstanceId: relaunched.daemonInstanceId,
			targets: [],
		});
		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "reconciled",
			requestId: "123e4567-e89b-42d3-a456-426614174009",
			ownerKey: context.sessionStore.teamOf(context.owner),
			...FIRST_CHILD,
			targetId: "container:recipe-app",
			eventId: 9,
			agentId,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			sessionId: "session-1",
		});
		await flush();
		expect(context.service.listOwnedAgents(context.owner)[0]?.fence?.daemonInstanceId).toBe("daemon-2");
	});

	it("takes an idle agent's follow-up after its target relaunches and ignores the old generation", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const start = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await terminal(context, agentId, "turn-1", 1);
		await start;

		const relaunched = { daemonInstanceId: "daemon-1", generation: 2 };
		await hello(context, relaunched.daemonInstanceId, relaunched.generation);
		const message = context.route.handle(post(context.token), {
			kind: "message",
			operationId: MESSAGE_OPERATION_ID,
			agentId,
			prompt: "Continue",
		});
		await flush();
		await accept(context, MESSAGE_OPERATION_ID, "turn-2", 0, "started", relaunched);
		await terminal(context, agentId, "turn-2", 1, "Continued.", relaunched);

		expect(await (await message).json()).toMatchObject({
			observation: "accepted",
			turn: { id: "turn-2", state: "inProgress" },
			delivery: "followup",
		});
		const collected = await collectUntilSettled(context, agentId);
		expect(collected.turns).toMatchObject([
			{ id: "turn-1", state: "completed" },
			{ id: "turn-2", state: "completed", finalResponse: "Continued." },
		]);

		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "reconciled",
			requestId: "123e4567-e89b-42d3-a456-426614174009",
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-1",
			targetId: "container:recipe-app",
			generation: 1,
			eventId: 9,
			agentId,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			sessionId: "session-1",
			turnId: "turn-1",
			turnState: "inProgress",
		});
		await flush();
		const listed = await (await context.route.handle(post(context.token), { kind: "list", agentId })).json();
		expect(listed.agents[0]).toMatchObject({ running: false, turnCount: 2 });
	});

	it("decides an event that can never be placed, and asks nothing about it", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const start = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await terminal(context, agentId, "turn-1", 1);
		await start;
		const relaunched = { daemonInstanceId: "daemon-1", generation: 2 };
		await hello(context, relaunched.daemonInstanceId, relaunched.generation);
		const message = context.route.handle(post(context.token), {
			kind: "message",
			operationId: MESSAGE_OPERATION_ID,
			agentId,
			prompt: "Continue",
		});
		await flush();
		await accept(context, MESSAGE_OPERATION_ID, "turn-2", 0, "started", relaunched);
		await message;
		const asks = () =>
			context.sent.filter((frame) => frame.type === "copilot_command" && frame.kind === "reconcile").length;
		const asked = asks();
		const activity = (generation: number, eventId: number, turnId: string) => ({
			type: "copilot_event",
			kind: "activity",
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-1",
			targetId: "container:recipe-app",
			generation,
			eventId,
			agentId,
			sessionId: "session-1",
			turnId,
			itemId: `late-${generation}`,
			text: "late",
		});

		context.relay.handleHostMessage(activity(1, 5, "turn-lost"));
		context.relay.handleHostMessage(activity(3, 0, "turn-1"));
		await flush();

		const acknowledged = context.sent
			.filter((frame) => frame.type === "copilot_ack")
			.map((frame) => [frame.generation, frame.throughEventId]);
		expect(acknowledged).toContainEqual([1, 5]);
		expect(acknowledged).toContainEqual([3, 0]);
		expect(asks()).toBe(asked);
	});

	it("takes a new turn for a steer whose turn ended under it", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await started;

		const message = context.route.handle(post(context.token), {
			kind: "message",
			operationId: MESSAGE_OPERATION_ID,
			agentId,
			prompt: "Also the lexer",
		});
		await flush();
		expect(commandFor(context, MESSAGE_OPERATION_ID)).toMatchObject({ expectedTurnId: "turn-1" });
		await terminal(context, agentId, "turn-1", 1);
		await accept(context, MESSAGE_OPERATION_ID, "turn-2", 2, "started");

		expect(await (await message).json()).toMatchObject({
			agentState: "working",
			observation: "accepted",
			turn: { id: "turn-2", state: "inProgress" },
			delivery: "followup",
		});
		const collected = await collectUntilSettled(context, agentId);
		expect(collected).toMatchObject({ running: "turn-2", turns: [{ id: "turn-1", state: "completed" }] });
	});

	it("refuses a second message while the first delivery is unresolved", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await started;

		const first = context.route.handle(post(context.token), {
			kind: "message",
			operationId: MESSAGE_OPERATION_ID,
			agentId,
			prompt: "Continue",
		});
		await flush();
		const refused = await context.route.handle(post(context.token), {
			kind: "message",
			operationId: "123e4567-e89b-42d3-a456-426614174003",
			agentId,
			prompt: "Again",
		});
		const commands = context.sent.filter((frame) => frame.type === "copilot_command");
		expect(refused.status).toBe(400);
		expect(commands).toHaveLength(2);

		await accept(context, MESSAGE_OPERATION_ID, "turn-1", 1, "steered");
		expect(await (await first).json()).toMatchObject({ observation: "accepted", delivery: "steered" });
	});

	it.each([
		["interrupt result then terminal", ["receipt", "terminal"]],
		["terminal then interrupt result", ["terminal", "receipt"]],
	])("settles an interrupt race: %s", async (_name, order) => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await started;

		await context.route.handle(post(context.token), {
			kind: "stop",
			operationId: STOP_OPERATION_ID,
			agentId,
		});
		const interrupt = commandFor(context, STOP_OPERATION_ID);
		let eventId = 1;
		for (const step of order) {
			if (step === "receipt") {
				context.relay.handleHostMessage({
					type: "copilot_receipt",
					kind: "interruptResult",
					requestId: interrupt.requestId,
					ownerKey: context.sessionStore.teamOf(context.owner),
					daemonInstanceId: "daemon-1",
					targetId: "container:recipe-app",
					generation: 1,
					eventId,
					agentId,
					operationId: STOP_OPERATION_ID,
					sessionId: "session-1",
					turnId: "turn-1",
					ok: true,
				});
			} else {
				await terminal(context, agentId, "turn-1", eventId);
			}
			eventId += 1;
			await flush();
		}

		const collected = await collectUntilSettled(context, agentId);
		expect(collected).toMatchObject({
			agentState: "idle",
			running: null,
			turns: [{ id: "turn-1", state: "completed" }],
		});
	});

	it("refuses a message and a second stop while an interrupt is pending, and reopens when it fails", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await started;

		const stop = await context.route.handle(post(context.token), {
			kind: "stop",
			operationId: STOP_OPERATION_ID,
			agentId,
		});
		expect(await stop.json()).toMatchObject({ observation: "interruptRequested", turn: { id: "turn-1" } });
		const interrupt = commandFor(context, STOP_OPERATION_ID);
		expect(interrupt).toMatchObject({ kind: "interrupt", sessionId: "session-1", turnId: "turn-1" });

		const refusedMessage = await context.route.handle(post(context.token), {
			kind: "message",
			operationId: MESSAGE_OPERATION_ID,
			agentId,
			prompt: "Also the lexer",
		});
		const refusedStop = await context.route.handle(post(context.token), {
			kind: "stop",
			operationId: "123e4567-e89b-42d3-a456-426614174003",
			agentId,
		});
		expect([refusedMessage.status, refusedStop.status]).toEqual([400, 400]);
		expect(context.sent.filter((frame) => frame.type === "copilot_command")).toHaveLength(2);

		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "interruptResult",
			requestId: interrupt.requestId,
			ownerKey: context.sessionStore.teamOf(context.owner),
			...FIRST_CHILD,
			targetId: "container:recipe-app",
			eventId: 1,
			agentId,
			operationId: STOP_OPERATION_ID,
			sessionId: "session-1",
			turnId: "turn-1",
			ok: false,
			error: "abort timed out",
		});
		await flush();
		expect(context.service.listOwnedAgents(context.owner)[0]).toMatchObject({
			agentState: "working",
			activeTurnId: "turn-1",
		});

		const steered = context.route.handle(post(context.token), {
			kind: "message",
			operationId: "123e4567-e89b-42d3-a456-426614174004",
			agentId,
			prompt: "Also the lexer",
		});
		await flush();
		await accept(context, "123e4567-e89b-42d3-a456-426614174004", "turn-1", 2, "steered");
		expect(await (await steered).json()).toMatchObject({ observation: "accepted", delivery: "steered" });
	});

	it("waits for the terminal of a turn its child reports settled", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await started;

		const relaunched = { daemonInstanceId: "daemon-2", generation: 2 };
		context.registerHost(relaunched.daemonInstanceId);
		context.relay.handleHostMessage({
			type: "copilot_hello",
			daemonInstanceId: relaunched.daemonInstanceId,
			targets: [{ targetId: "container:recipe-app", generation: 2 }],
		});
		await flush();
		const reconcile = context.sent.findLast(
			(frame) => frame.type === "copilot_command" && frame.kind === "reconcile",
		);
		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "reconciled",
			requestId: reconcile!.requestId,
			ownerKey: context.sessionStore.teamOf(context.owner),
			...relaunched,
			targetId: "container:recipe-app",
			eventId: 0,
			agentId,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			sessionId: "session-1",
			turnId: "turn-1",
			turnState: "completed",
		});
		await flush();
		expect(context.service.listOwnedAgents(context.owner)[0]).toMatchObject({
			agentState: "recovering",
			activeTurnId: "turn-1",
			turns: [{ id: "turn-1", state: "inProgress" }],
		});

		await terminal(context, agentId, "turn-1", 1, "Recovered.", relaunched);
		const collected = await collectUntilSettled(context, agentId);
		expect(collected).toMatchObject({
			agentState: "idle",
			turns: [{ id: "turn-1", state: "completed", finalResponse: "Recovered." }],
		});
	});

	it("asks where an agent stands when an event names a turn it does not hold, and adopts the answer", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await terminal(context, agentId, "turn-1", 1);
		await started;

		const stream = { ownerKey: context.sessionStore.teamOf(context.owner), ...FIRST_CHILD, agentId };
		const ackedThrough = () =>
			Math.max(
				...context.sent.flatMap((frame) =>
					frame.type === "copilot_ack" ? [frame.throughEventId as number] : [],
				),
			);
		context.relay.handleHostMessage({
			type: "copilot_event",
			kind: "activity",
			...stream,
			targetId: "container:recipe-app",
			eventId: 2,
			sessionId: "session-1",
			turnId: "turn-2",
			itemId: "item-1",
			text: "Checking",
		});
		await flush();
		const reconcile = context.sent.findLast(
			(frame) => frame.type === "copilot_command" && frame.kind === "reconcile",
		);
		expect(reconcile).toMatchObject({ agentId, sessionId: "session-1" });
		expect(ackedThrough()).toBe(1);

		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "reconciled",
			requestId: reconcile!.requestId,
			...stream,
			targetId: "container:recipe-app",
			eventId: 3,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			sessionId: "session-1",
			turnId: "turn-2",
			turnState: "inProgress",
		});
		await flush();
		expect(ackedThrough()).toBe(3);
		const running = await (await context.route.handle(post(context.token), { kind: "await", agentId })).json();
		expect(running).toMatchObject({ agentState: "working", running: "turn-2" });
	});

	it("asks again once the guard lifts, while a frame is still held", async () => {
		const ambient = fakeAmbient({ drive: "manual" });
		const context = setup({ ambient });
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await terminal(context, agentId, "turn-1", 1);
		await started;

		const stream = { ownerKey: context.sessionStore.teamOf(context.owner), ...FIRST_CHILD, agentId };
		const asks = () =>
			context.sent.filter((frame) => frame.type === "copilot_command" && frame.kind === "reconcile");
		context.relay.handleHostMessage({
			type: "copilot_event",
			kind: "activity",
			...stream,
			targetId: "container:recipe-app",
			eventId: 2,
			sessionId: "session-1",
			turnId: "turn-2",
			itemId: "item-1",
			text: "Checking",
		});
		await flush();
		// Unplaceable events remain held.
		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "reconciled",
			requestId: asks()[0]!.requestId,
			...stream,
			targetId: "container:recipe-app",
			eventId: 3,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			sessionId: "session-1",
		});
		await flush();
		expect(asks()).toHaveLength(1);

		await ambient.advance(RECONCILE_GUARD_MS);
		await flush();
		expect(asks()).toHaveLength(2);
	});

	it("keeps an agent idle through a reconciliation that reports its ended turn as running", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await terminal(context, agentId, "turn-1", 1);
		await started;

		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "reconciled",
			requestId: "123e4567-e89b-42d3-a456-426614174009",
			ownerKey: context.sessionStore.teamOf(context.owner),
			...FIRST_CHILD,
			agentId,
			targetId: "container:recipe-app",
			eventId: 2,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			sessionId: "session-1",
			turnId: "turn-1",
			turnState: "inProgress",
		});
		await flush();

		const settled = await (await context.route.handle(post(context.token), { kind: "await", agentId })).json();
		expect(settled).toMatchObject({
			agentState: "idle",
			running: null,
			turns: [{ id: "turn-1", state: "completed" }],
		});
		// Acknowledgment stops replay.
		expect(context.sent.findLast((frame) => frame.type === "copilot_ack")).toMatchObject({ throughEventId: 2 });
	});

	it("drops a held event from a replaced generation", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await started;

		context.relay.handleHostMessage({
			type: "copilot_event",
			kind: "activity",
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-1",
			targetId: "container:recipe-app",
			generation: 1,
			eventId: 1,
			agentId,
			sessionId: "session-1",
			turnId: "unknown-turn",
			itemId: "held",
			text: "held",
		});
		await flush();
		context.registerHost("daemon-2");
		await hello(context, "daemon-2", 2);
		await flush();
		const reconcile = context.sent.findLast(
			(frame) => frame.type === "copilot_command" && frame.kind === "reconcile",
		);
		expect(reconcile).toBeDefined();
		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "reconciled",
			requestId: reconcile!.requestId,
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-2",
			targetId: "container:recipe-app",
			generation: 2,
			eventId: 0,
			agentId,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			sessionId: "session-1",
			turnId: "turn-1",
			turnState: "inProgress",
		});
		await flush();
		context.relay.handleHostMessage({
			type: "copilot_event",
			kind: "activity",
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-1",
			targetId: "container:recipe-app",
			generation: 1,
			eventId: 2,
			agentId,
			sessionId: "session-1",
			turnId: "turn-1",
			itemId: "stale",
			text: "stale",
		});
		context.relay.handleHostMessage({
			type: "copilot_event",
			kind: "activity",
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-2",
			targetId: "container:recipe-app",
			generation: 2,
			eventId: 1,
			agentId,
			sessionId: "session-1",
			turnId: "turn-1",
			itemId: "fresh",
			text: "fresh",
		});
		await flush();
		await terminal(context, agentId, "turn-1", 2, "Done.", { daemonInstanceId: "daemon-2", generation: 2 });
		const collected = await collectUntilSettled(context, agentId);
		expect(collected.turns?.[0]).toMatchObject({ activities: [{ kind: "commentary", text: "fresh" }] });
	});

	it("applies what a turn said while its acceptance waited on a reconciliation", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await started;

		// Lost turns start fresh.
		const relaunched = { daemonInstanceId: "daemon-2", generation: 1 };
		context.registerHost("daemon-2");
		const message = context.route.handle(post(context.token), {
			kind: "message",
			operationId: MESSAGE_OPERATION_ID,
			agentId,
			prompt: "Also the lexer",
		});
		await flush();
		await accept(context, MESSAGE_OPERATION_ID, "turn-2", 0, "started", relaunched);
		await terminal(context, agentId, "turn-2", 1, "Lexer done.", relaunched);
		const reconcile = context.sent.findLast(
			(frame) => frame.type === "copilot_command" && frame.kind === "reconcile",
		);
		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "reconciled",
			requestId: reconcile!.requestId,
			ownerKey: context.sessionStore.teamOf(context.owner),
			...relaunched,
			targetId: "container:recipe-app",
			eventId: 2,
			agentId,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			sessionId: "session-1",
			turnId: "turn-1",
		});
		await flush();

		expect(await (await message).json()).toMatchObject({ turn: { id: "turn-2" }, delivery: "followup" });
		const collected = await collectUntilSettled(context, agentId);
		expect(collected.turns).toMatchObject([
			{ id: "turn-1", state: "interrupted" },
			{ id: "turn-2", state: "completed", finalResponse: "Lexer done." },
		]);
	});

	it("holds a new daemon's turn unacknowledged until the old turn's end lets it be placed", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await started;

		const relaunched = { daemonInstanceId: "daemon-2", generation: 1 };
		context.registerHost("daemon-2");
		const message = context.route.handle(post(context.token), {
			kind: "message",
			operationId: MESSAGE_OPERATION_ID,
			agentId,
			prompt: "Also the lexer",
		});
		await flush();
		await accept(context, MESSAGE_OPERATION_ID, "turn-2", 0, "started", relaunched);
		await terminal(context, agentId, "turn-2", 1, "Lexer done.", relaunched);
		const reconcile = context.sent.findLast(
			(frame) => frame.type === "copilot_command" && frame.kind === "reconcile",
		);
		const acked = () =>
			context.sent.flatMap((frame) =>
				frame.type === "copilot_ack" && frame.daemonInstanceId === "daemon-2" ? [frame.throughEventId] : [],
			);
		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "reconciled",
			requestId: reconcile!.requestId,
			ownerKey: context.sessionStore.teamOf(context.owner),
			...relaunched,
			targetId: "container:recipe-app",
			eventId: 2,
			agentId,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			sessionId: "session-1",
			turnId: "turn-1",
			turnState: "completed",
		});
		await flush();
		expect(acked()).toEqual([]);

		await terminal(context, agentId, "turn-1", 3, "Parser done.", relaunched);
		expect(await (await message).json()).toMatchObject({ turn: { id: "turn-2" }, delivery: "followup" });
		const collected = await collectUntilSettled(context, agentId);
		expect(collected.turns).toMatchObject([
			{ id: "turn-1", state: "completed", finalResponse: "Parser done." },
			{ id: "turn-2", state: "completed", finalResponse: "Lexer done." },
		]);
		expect(acked().at(-1)).toBe(3);
	});

	it("reasks after a refused reconciliation and settles the lost turn", async () => {
		let now = 1_000;
		const ambient = { ...processAmbient(), now: () => now };
		const context = setup({ ambient, waitBudgetMs: 1_000 });
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await started;

		context.registerHost("daemon-2");
		await hello(context, "daemon-2", 2);
		await flush();
		const first = context.sent.find((frame) => frame.type === "copilot_command" && frame.kind === "reconcile");
		expect(first).toBeDefined();
		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "rejected",
			requestId: first!.requestId,
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-2",
			eventId: 0,
			agentId,
			error: "target unavailable",
		});
		await flush();

		now += 299_999;
		context.relay.reconcileStale(context.owner);
		await flush();
		expect(
			context.sent.filter((frame) => frame.type === "copilot_command" && frame.kind === "reconcile"),
		).toHaveLength(1);

		now += 1;
		context.relay.reconcileStale(context.owner);
		await flush();
		const second = context.sent.filter(
			(frame) => frame.type === "copilot_command" && frame.kind === "reconcile",
		)[1];
		expect(second).toBeDefined();
		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "reconciled",
			requestId: second!.requestId,
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-2",
			targetId: "container:recipe-app",
			generation: 2,
			eventId: 1,
			agentId,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			sessionId: "session-1",
		});
		await flush();

		const settled = await collectUntilSettled(context, agentId);
		expect(settled).toMatchObject({
			agentState: "idle",
			running: null,
			turns: [{ id: "turn-1", state: "interrupted" }],
		});
	});

	it("asks a new daemon immediately after the previous daemon refused", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await started;

		context.registerHost("daemon-2");
		await hello(context, "daemon-2", 2);
		await flush();
		const first = context.sent.find((frame) => frame.type === "copilot_command" && frame.kind === "reconcile");
		expect(first).toBeDefined();
		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "rejected",
			requestId: first!.requestId,
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-2",
			eventId: 0,
			agentId,
			error: "target unavailable",
		});
		await flush();

		context.registerHost("daemon-3");
		await hello(context, "daemon-3", 3);
		await flush();
		expect(
			context.sent.filter((frame) => frame.type === "copilot_command" && frame.kind === "reconcile"),
		).toHaveLength(2);
	});

	it("binds a message to the turn reconciliation adopted before its receipt could land", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await started;
		const message = context.route.handle(post(context.token), {
			kind: "message",
			operationId: MESSAGE_OPERATION_ID,
			agentId,
			prompt: "Also the lexer",
		});
		await flush();
		await terminal(context, agentId, "turn-1", 1);

		context.writes("throw");
		await accept(context, MESSAGE_OPERATION_ID, "turn-2", 2, "started");
		context.writes(true);
		const reconcile = context.sent.findLast(
			(frame) => frame.type === "copilot_command" && frame.kind === "reconcile",
		);
		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "reconciled",
			requestId: reconcile!.requestId,
			ownerKey: context.sessionStore.teamOf(context.owner),
			...FIRST_CHILD,
			targetId: "container:recipe-app",
			eventId: 3,
			agentId,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			sessionId: "session-1",
			turnId: "turn-2",
			turnState: "inProgress",
		});
		await flush();

		expect(await (await message).json()).toMatchObject({
			observation: "accepted",
			turn: { id: "turn-2", state: "inProgress" },
			delivery: "followup",
		});
		await terminal(context, agentId, "turn-2", 4, "Both done.");
		const collected = await collectUntilSettled(context, agentId);
		expect(collected.turns).toMatchObject([
			{ id: "turn-1", state: "completed" },
			{ id: "turn-2", state: "completed", finalResponse: "Both done." },
		]);
	});

	it("answers a refused start with the daemon's failure code", async () => {
		const context = setup();
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		const command = commandFor(context, START_OPERATION_ID);
		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "rejected",
			requestId: command.requestId,
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-1",
			eventId: 0,
			agentId: command.agentId,
			operationId: START_OPERATION_ID,
			failureCode: "authentication_required",
			error: "Copilot login required",
		});
		expect(await (await started).json()).toMatchObject({
			agentState: "unavailable",
			observation: "unavailable",
			error: { code: "authentication_required", message: "Copilot login required", retryable: true },
		});
	});

	it("preserves a refused start without a failure code", async () => {
		const context = setup();
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		const command = commandFor(context, START_OPERATION_ID);
		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "rejected",
			requestId: command.requestId,
			ownerKey: context.sessionStore.teamOf(context.owner),
			daemonInstanceId: "daemon-1",
			eventId: 0,
			agentId: command.agentId,
			operationId: START_OPERATION_ID,
			error: "target unavailable",
		});
		expect(await (await started).json()).toMatchObject({
			agentState: "unavailable",
			observation: "indeterminate",
			error: { retryable: true },
		});
	});

	it("sends nothing for a write that does not land, and leaves the agent able to take the next", async () => {
		const fresh = setup();
		fresh.writes(false);
		const refusedStart = await fresh.route.handle(post(fresh.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		expect(await refusedStart.json()).toMatchObject({ error: { code: "daemon_unavailable", retryable: true } });
		expect(fresh.sent).toEqual([]);

		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await started;
		context.writes(false);
		const sentBefore = context.sent.length;
		for (const request of [
			{ kind: "stop" as const, operationId: STOP_OPERATION_ID, agentId },
			{ kind: "message" as const, operationId: MESSAGE_OPERATION_ID, agentId, prompt: "Also the lexer" },
		]) {
			const refused = await context.route.handle(post(context.token), request);
			expect(await refused.json()).toMatchObject({ error: { code: "daemon_unavailable", retryable: true } });
		}
		expect(context.sent).toHaveLength(sentBefore);

		context.writes(true);
		await context.route.handle(post(context.token), { kind: "list", agentId });
		await flush();
		const reconcile = context.sent.findLast(
			(frame) => frame.type === "copilot_command" && frame.kind === "reconcile",
		);
		context.relay.handleHostMessage({
			type: "copilot_receipt",
			kind: "reconciled",
			requestId: reconcile!.requestId,
			ownerKey: context.sessionStore.teamOf(context.owner),
			...FIRST_CHILD,
			targetId: "container:recipe-app",
			eventId: 1,
			agentId,
			resolvedTarget: { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace/recipe-app" },
			sessionId: "session-1",
			turnId: "turn-1",
			turnState: "inProgress",
		});
		await flush();
		const retryId = "123e4567-e89b-42d3-a456-426614174006";
		const retried = context.route.handle(post(context.token), {
			kind: "message",
			operationId: retryId,
			agentId,
			prompt: "Also the lexer",
		});
		await flush();
		await accept(context, retryId, "turn-1", 2, "steered");
		expect(await (await retried).json()).toMatchObject({ observation: "accepted", delivery: "steered" });
	});

	it("keeps a collected turn collected across a restart, and replays its collect", async () => {
		const context = setup();
		const agentId = agentIdForOperation("copilot", START_OPERATION_ID);
		const started = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await terminal(context, agentId, "turn-1", 1);
		await started;
		const collectId = "123e4567-e89b-42d3-a456-426614174005";
		const collect = { kind: "await" as const, agentId, operationId: collectId };
		const first = await (await context.route.handle(post(context.token), collect)).json();
		expect(first.turns).toMatchObject([{ id: "turn-1", state: "completed" }]);

		const restarted = setup({ restore: JSON.parse(JSON.stringify(context.sessionStore.snapshot())) });
		const listed = await (await restarted.route.handle(post(restarted.token), { kind: "list", agentId })).json();
		expect(listed.agents[0]).toMatchObject({ uncollected: 0, turnCount: 1 });
		const replayed = await (await restarted.route.handle(post(restarted.token), collect)).json();
		expect(replayed.turns).toEqual(first.turns);
		const later = await (await restarted.route.handle(post(restarted.token), { kind: "await", agentId })).json();
		expect(later.turns).toEqual([]);
	});

	it("lists the newest model of each family where the owner's agents run, and says when it cannot", async () => {
		const asked: unknown[] = [];
		const listing = setup({
			listModels: async (target) => {
				asked.push(target);
				return { kind: "listed", models: ["gpt-6-luna", "gpt-6.1-luna", "gpt-5-sol", "gpt-6.1-sol"] };
			},
		});
		const listed = await listing.route.handle(post(listing.token), { kind: "models" });
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual({
			models: [{ id: "gpt-6-luna", default: true }, { id: "gpt-6.1-luna" }, { id: "gpt-6.1-sol" }],
		});
		expect(asked).toEqual([
			{ kind: "devcontainer", project: "recipe-app", hostProjectPath: "/trusted/recipe-app" },
		]);

		for (const answer of [{ kind: "unreachable" as const }, { kind: "refused" as const, reason: "no CLI" }]) {
			const failing = setup({ listModels: async () => answer });
			const refused = await failing.route.handle(post(failing.token), { kind: "models" });
			expect(refused.status).toBe(503);
			expect(await refused.json()).toMatchObject({ error: { retryable: true } });
		}
	});

	it("replays a timed-out operation answer and isolates it to its owner", async () => {
		const context = setup({ waitBudgetMs: 10 });
		const request = {
			kind: "start" as const,
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		};
		const first = await (await context.route.handle(post(context.token), request)).json();
		const replay = await (await context.route.handle(post(context.token), request)).json();
		expect(first).toMatchObject({ agentState: "creating", observation: "waitTimedOut" });
		expect(replay).toEqual(first);

		const other = context.sessionStore.mint({ spawn: "recipe-app", sessionLabel: "Other", harness: "claude" });
		const otherToken = context.sessionStore.ensureBindToken(other);
		context.sessionStore.activateBinding(other);
		context.sessionStore.confirm(context.sessionStore.teamOf(other));
		const foreign = await (await context.route.handle(post(otherToken), { kind: "list" })).json();
		expect(foreign.agents).toEqual([]);
	});

	it("lists for an older plugin that still sends `detail`", async () => {
		const context = setup({ waitBudgetMs: 10 });
		const listed = await context.route.handle(post(context.token), { kind: "list", detail: "summary" });
		expect(listed.status).toBe(200);
		expect((await listed.json()).agents).toEqual([]);
	});
});
