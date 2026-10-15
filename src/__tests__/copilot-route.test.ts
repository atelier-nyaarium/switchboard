import { describe, expect, it } from "vitest";
import { CopilotAgentService } from "../gateway/copilotAgentService.js";
import { CopilotRelay } from "../gateway/copilotRelay.js";
import { CopilotRoute } from "../gateway/copilotRoute.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/wsTypes.js";
import { processAmbient } from "../shared/ambient.js";
import { CopilotAgentResultSchema, copilotAgentIdForOperation } from "../shared/copilot-agent.js";
import { type CopilotCatalogWriter, SessionStore } from "../shared/session-store.js";

const START_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const MESSAGE_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174001";
const STOP_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174002";

function setup(options: { dispatch?: boolean; waitBudgetMs?: number } = {}) {
	let catalogWriter: CopilotCatalogWriter | undefined;
	const sessionStore = new SessionStore({
		ambient: processAmbient(),
		copilotCatalogPersistence: {
			persistChecked: () => {},
			receiveWriter: (writer) => {
				catalogWriter = writer;
			},
		},
	});
	const registry: TeamRegistry = new Map();
	const auth = createSessionAuthority({
		sessionStore,
		registry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => "alice",
		localGatewayId: "sakura",
	});
	if (!catalogWriter) throw new Error("catalog writer unavailable");
	const service = new CopilotAgentService({
		auth,
		sessionStore,
		offlineCatalog: new Map([["recipe-app", "/trusted/recipe-app"]]),
		catalogWriter,
	});
	const sent: Record<string, unknown>[] = [];
	const relay = new CopilotRelay({
		service,
		sessionStore,
		ambient: processAmbient(),
		sendToHost: (message) => {
			if (options.dispatch === false) return false;
			sent.push(message);
			return true;
		},
	});
	const owner = sessionStore.mint({ spawn: "recipe-app", sessionLabel: "Work" });
	const token = sessionStore.ensureBindToken(owner);
	sessionStore.activateBinding(owner);
	sessionStore.confirm(sessionStore.teamOf(owner));
	const route = new CopilotRoute({
		service,
		relay,
		ambient: processAmbient(),
		waitBudgetMs: options.waitBudgetMs ?? 1_000,
	});
	return { route, relay, sent, owner, token, service, sessionStore };
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
	delivery: "started" | "followup",
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

describe("Copilot gateway route", () => {
	it("returns a terminal result after an accepted ACP turn", async () => {
		const context = setup();
		const agentId = copilotAgentIdForOperation(START_OPERATION_ID);
		const request = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
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
		const body = await response.json();
		expect(response.status).toBe(200);
		expect(() => CopilotAgentResultSchema.parse(body)).not.toThrow();
		expect(body).toMatchObject({
			agentId,
			observation: "terminal",
			turn: { id: "turn-1", state: "completed" },
			activities: [{ kind: "commentary", text: "Checking" }],
			finalResponse: "Done.",
		});
		expect(body.activities[0]).not.toHaveProperty("itemId");
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
	});

	it("does not let a stale terminal settle a newer turn, and closes a racing stop", async () => {
		const context = setup();
		const agentId = copilotAgentIdForOperation(START_OPERATION_ID);
		const start = context.route.handle(post(context.token), {
			kind: "start",
			operationId: START_OPERATION_ID,
			prompt: "Review the parser",
		});
		await flush();
		await accept(context, START_OPERATION_ID, "turn-1", 0, "started");
		await terminal(context, agentId, "turn-1", 1);
		await start;

		const message = context.route.handle(post(context.token), {
			kind: "message",
			operationId: MESSAGE_OPERATION_ID,
			agentId,
			prompt: "Continue",
		});
		await flush();
		await accept(context, MESSAGE_OPERATION_ID, "turn-2", 2, "followup");

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
		const agentId = copilotAgentIdForOperation(START_OPERATION_ID);
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
		const message = context.route.handle(post(context.token), {
			kind: "message",
			operationId: MESSAGE_OPERATION_ID,
			agentId,
			prompt: "Continue",
		});
		await flush();
		await accept(context, MESSAGE_OPERATION_ID, "turn-2", 0, "followup", relaunched);
		await terminal(context, agentId, "turn-2", 1, "Continued.", relaunched);

		expect(await (await message).json()).toMatchObject({ turn: { id: "turn-2", state: "completed" } });
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
			sessionId: "session-1",
			active: false,
		});
		await flush();
		expect(context.service.listOwnedAgents(context.owner)[0]?.fence?.daemonInstanceId).toBe("daemon-2");
	});
});
