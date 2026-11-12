import { describe, expect, it } from "vitest";
import { AgentRelay } from "../gateway/agentRelay.js";
import type { AgentApplication } from "../gateway/agentRelayCore.js";
import type { AgentService } from "../gateway/agentService.js";
import { agentOperationIdentity } from "../shared/agent-identity.js";
import { type PersistedAgent, PersistedAgentSchema } from "../shared/agent-persisted.js";
import { agentOperationFingerprintOf } from "../shared/agent-record.js";
import { type AgentDaemonEvent, type AgentDaemonReceipt, agentWire } from "../shared/agent-wire.js";
import { processAmbient } from "../shared/ambient.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";

const OWNER_KEY = "recipe-app.work";
const AGENT_ID = "copilot_0123456789abcdef0123456789abcdef";
const DAEMON_INSTANCE_ID = "daemon-1";
const TARGET_ID = "container:recipe-app";
const GENERATION = 1;
const SESSION_ID = "session-1";
const TURN_ID = "turn-1";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const RESOLVED_TARGET = { kind: "devcontainer" as const, targetId: TARGET_ID, cwd: "/workspace/recipe-app" };
const COPILOT_WIRE = agentWire("copilot");
const REQUESTED_TARGET = {
	kind: "devcontainer" as const,
	project: "recipe-app",
	hostProjectPath: "/trusted/recipe-app",
};

const OWNER: SessionRecord = { id: "work", sessionLabel: "Work", spawn: "recipe-app", harness: "claude", lastSeen: 0 };

type ApplicationFactory = (
	owner: SessionRecord,
	agent: PersistedAgent,
	message: AgentDaemonEvent | AgentDaemonReceipt,
) => AgentApplication<PersistedAgent>;

interface SetupOptions {
	agent?: PersistedAgent;
	onEvent?: ApplicationFactory;
	onReceipt?: ApplicationFactory;
	attached?: boolean;
}

function applied(owner: SessionRecord, agent: PersistedAgent): AgentApplication<PersistedAgent> {
	return { disposition: "applied", owner, agent, catalogRevision: 1 };
}

function reconcile(owner: SessionRecord, agent: PersistedAgent): AgentApplication<PersistedAgent> {
	return { disposition: "reconcile", owner, agent };
}

function startOperation(state: "requested" | "accepted" = "accepted") {
	return {
		operationId: REQUEST_ID,
		kind: "start",
		prompt: "start",
		fingerprint: agentOperationFingerprintOf(
			agentOperationIdentity({ kind: "start", agentId: AGENT_ID, prompt: "start" }),
		),
		state,
		...(state === "accepted" ? { turnId: TURN_ID, sessionId: SESSION_ID, delivery: "started" } : {}),
		createdAt: 0,
		updatedAt: 0,
	};
}

function askableAgent(agentState: "working" | "idle" = "working"): PersistedAgent {
	return PersistedAgentSchema.parse({
		version: 2,
		agentId: AGENT_ID,
		agentState,
		requestedTarget: REQUESTED_TARGET,
		resolvedTarget: RESOLVED_TARGET,
		sessionId: SESSION_ID,
		...(agentState === "working" ? { activeTurnId: TURN_ID } : {}),
		operations: [startOperation()],
		turns:
			agentState === "working"
				? [{ id: TURN_ID, state: "inProgress", activities: [], updatedAt: 0 }]
				: [{ id: TURN_ID, state: "completed", activities: [], finalResponse: "done", updatedAt: 0 }],
		createdAt: 0,
		updatedAt: 0,
	});
}

function agentWithoutSession(): PersistedAgent {
	return PersistedAgentSchema.parse({
		version: 2,
		agentId: AGENT_ID,
		agentState: "creating",
		requestedTarget: REQUESTED_TARGET,
		operations: [startOperation("requested")],
		turns: [],
		createdAt: 0,
		updatedAt: 0,
	});
}

function eventFrame(eventId: number, kind: "activity" | "terminal" = "activity"): AgentDaemonEvent {
	if (kind === "activity")
		return COPILOT_WIRE.event.parse({
			type: "copilot_event",
			kind,
			ownerKey: OWNER_KEY,
			daemonInstanceId: DAEMON_INSTANCE_ID,
			targetId: TARGET_ID,
			generation: GENERATION,
			eventId,
			agentId: AGENT_ID,
			sessionId: SESSION_ID,
			turnId: TURN_ID,
			itemId: `item-${eventId}`,
			text: "activity",
		});
	return COPILOT_WIRE.event.parse({
		type: "copilot_event",
		kind,
		ownerKey: OWNER_KEY,
		daemonInstanceId: DAEMON_INSTANCE_ID,
		targetId: TARGET_ID,
		generation: GENERATION,
		eventId,
		agentId: AGENT_ID,
		sessionId: SESSION_ID,
		turnId: TURN_ID,
		state: "completed",
		finalResponse: "done",
	});
}

function acceptedReceipt(eventId: number): AgentDaemonReceipt {
	return COPILOT_WIRE.receipt.parse({
		type: "copilot_receipt",
		kind: "accepted",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		daemonInstanceId: DAEMON_INSTANCE_ID,
		targetId: TARGET_ID,
		generation: GENERATION,
		eventId,
		agentId: AGENT_ID,
		operationId: REQUEST_ID,
		resolvedTarget: RESOLVED_TARGET,
		sessionId: SESSION_ID,
		turnId: TURN_ID,
		delivery: "started",
	});
}

function reconciledReceipt(eventId: number, requestId: unknown = REQUEST_ID): AgentDaemonReceipt {
	return COPILOT_WIRE.receipt.parse({
		type: "copilot_receipt",
		kind: "reconciled",
		requestId,
		ownerKey: OWNER_KEY,
		daemonInstanceId: DAEMON_INSTANCE_ID,
		targetId: TARGET_ID,
		generation: GENERATION,
		eventId,
		agentId: AGENT_ID,
		sessionId: SESSION_ID,
		resolvedTarget: RESOLVED_TARGET,
	});
}

function helloFrame() {
	return COPILOT_WIRE.hello.parse({
		type: "copilot_hello",
		daemonInstanceId: DAEMON_INSTANCE_ID,
		targets: [{ targetId: TARGET_ID, generation: GENERATION }],
	});
}

function setup(options: SetupOptions = {}) {
	let agent = options.agent ?? askableAgent();
	let attached = options.attached ?? true;
	const sent: Record<string, unknown>[] = [];
	const liveDaemonInstanceId: string | undefined = DAEMON_INSTANCE_ID;
	const eventCalls: AgentDaemonEvent[] = [];
	const receiptCalls: AgentDaemonReceipt[] = [];
	const sessionStore = {
		list: () => [OWNER],
		teamOf: (record: SessionRecord) => `${record.spawn}.${record.id}`,
	} as unknown as SessionStore;
	const service = {
		listOwnedAgents: () => [agent],
		applyEvent: (event: AgentDaemonEvent) => {
			eventCalls.push(event);
			return options.onEvent?.(OWNER, agent, event) ?? applied(OWNER, agent);
		},
		applyReceipt: (receipt: AgentDaemonReceipt) => {
			receiptCalls.push(receipt);
			return options.onReceipt?.(OWNER, agent, receipt) ?? applied(OWNER, agent);
		},
	} as unknown as AgentService;
	const relay = new AgentRelay({
		backendId: "copilot",
		service,
		sessionStore,
		liveDaemonInstanceId: () => liveDaemonInstanceId,
		ambient: processAmbient(),
		sendToHost: (message) => {
			if (!attached) return false;
			sent.push(message);
			return true;
		},
	});
	return {
		relay,
		sent,
		eventCalls,
		receiptCalls,
		setAgent: (next: PersistedAgent) => {
			agent = next;
		},
		setAttached: (next: boolean) => {
			attached = next;
		},
	};
}

async function settleRelay(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function messagesOf(context: ReturnType<typeof setup>, type: string): Record<string, unknown>[] {
	return context.sent.filter((message) => message.type === type);
}

describe("Copilot relay acknowledgement", () => {
	it("sends a strict-schema ack for a decided event", async () => {
		const context = setup();
		const frame = eventFrame(7);

		context.relay.handleHostMessage(frame);
		await settleRelay();

		const parsed = COPILOT_WIRE.ack.safeParse(messagesOf(context, "copilot_ack")[0]);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.throughEventId).toBe(frame.eventId);
	});

	it("acknowledges a reconcile result for an agent without a session", async () => {
		const context = setup({
			agent: agentWithoutSession(),
			onEvent: (owner, agent) => reconcile(owner, agent),
		});

		context.relay.handleHostMessage(eventFrame(3));
		await settleRelay();

		expect(messagesOf(context, "copilot_ack")).toHaveLength(1);
		expect(messagesOf(context, "copilot_ack")[0]?.throughEventId).toBe(3);
		expect(messagesOf(context, "copilot_command")).toEqual([]);
	});

	it("holds a reconcile result for an askable agent", async () => {
		const context = setup({
			onEvent: (owner, agent) => reconcile(owner, agent),
		});

		context.relay.handleHostMessage(eventFrame(4));
		await settleRelay();

		expect(messagesOf(context, "copilot_ack")).toEqual([]);
		const commands = messagesOf(context, "copilot_command");
		expect(commands).toHaveLength(1);
		expect(COPILOT_WIRE.command.safeParse(commands[0]).success).toBe(true);
		expect(commands[0]).toMatchObject({
			kind: "reconcile",
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			target: RESOLVED_TARGET,
			sessionId: SESSION_ID,
		});
	});

	it("releases a held event only on the answer to its own reconciliation", async () => {
		let hold = true;
		const context = setup({
			onEvent: (owner, agent) => (hold ? reconcile(owner, agent) : applied(owner, agent)),
		});

		context.relay.handleHostMessage(eventFrame(4));
		await settleRelay();
		hold = false;
		context.relay.handleHostMessage(
			COPILOT_WIRE.receipt.parse({
				type: "copilot_receipt",
				kind: "rejected",
				requestId: REQUEST_ID,
				ownerKey: OWNER_KEY,
				daemonInstanceId: DAEMON_INSTANCE_ID,
				agentId: AGENT_ID,
				eventId: 0,
				error: "target unavailable",
			}),
		);
		context.relay.handleHostMessage(reconciledReceipt(5));
		await settleRelay();
		expect(messagesOf(context, "copilot_ack").some((ack) => (ack.throughEventId as number) >= 4)).toBe(false);

		const command = messagesOf(context, "copilot_command")[0];
		context.relay.handleHostMessage(reconciledReceipt(6, command?.requestId));
		await settleRelay();
		expect(messagesOf(context, "copilot_ack").at(-1)?.throughEventId).toBe(6);
	});

	it("evicts activity before terminal and receipt frames", async () => {
		let hold = true;
		const context = setup({
			onEvent: (owner, agent) => (hold ? reconcile(owner, agent) : applied(owner, agent)),
			onReceipt: (owner, agent) => (hold ? reconcile(owner, agent) : applied(owner, agent)),
		});

		// The terminal is OLDEST on purpose: an oldest-first eviction would drop it, activity-first keeps it.
		context.relay.handleHostMessage(eventFrame(1, "terminal"));
		for (let eventId = 2; eventId <= 130; eventId += 1) context.relay.handleHostMessage(eventFrame(eventId));
		context.relay.handleHostMessage(acceptedReceipt(131));
		await settleRelay();
		const eventCallsBeforeDrain = context.eventCalls.length;
		const receiptCallsBeforeDrain = context.receiptCalls.length;

		hold = false;
		context.relay.handleHostMessage(reconciledReceipt(132, messagesOf(context, "copilot_command")[0]?.requestId));
		await settleRelay();

		const replayedEvents = context.eventCalls.slice(eventCallsBeforeDrain);
		const replayedReceipts = context.receiptCalls.slice(receiptCallsBeforeDrain);
		const replayedActivities = replayedEvents
			.filter((event) => event.kind === "activity")
			.map((event) => event.eventId);
		expect(replayedActivities).toHaveLength(126);
		expect(replayedActivities.every((eventId) => eventId >= 5)).toBe(true);
		expect(replayedEvents).toContainEqual(expect.objectContaining({ kind: "terminal", eventId: 1 }));
		expect(replayedReceipts).toContainEqual(expect.objectContaining({ kind: "accepted", eventId: 131 }));
	});

	it("holds outcomes past the cap, and one per stream under a shared event id", async () => {
		let hold = true;
		const context = setup({
			onEvent: (owner, agent) => (hold ? reconcile(owner, agent) : applied(owner, agent)),
			onReceipt: (owner, agent) => (hold ? reconcile(owner, agent) : applied(owner, agent)),
		});
		for (let eventId = 1; eventId <= 130; eventId += 1)
			context.relay.handleHostMessage(eventFrame(eventId, "terminal"));
		context.relay.handleHostMessage({ ...eventFrame(1, "terminal"), generation: GENERATION + 1 });
		await settleRelay();
		const before = context.eventCalls.length;

		hold = false;
		context.relay.handleHostMessage(reconciledReceipt(131, messagesOf(context, "copilot_command")[0]?.requestId));
		await settleRelay();

		const replayed = context.eventCalls.slice(before);
		expect(replayed.filter((event) => event.generation === GENERATION)).toHaveLength(130);
		expect(replayed.filter((event) => event.generation === GENERATION + 1)).toHaveLength(1);
	});

	it("reasks for deferred work when hello sees an idle agent", async () => {
		const context = setup({
			attached: false,
			onEvent: (owner, agent) => reconcile(owner, agent),
		});

		context.relay.handleHostMessage(eventFrame(1));
		await settleRelay();
		context.setAttached(true);
		context.setAgent(askableAgent("idle"));
		context.relay.handleHostMessage(helloFrame());
		await settleRelay();

		const commands = messagesOf(context, "copilot_command");
		expect(commands).toHaveLength(1);
		expect(commands[0]).toMatchObject({ kind: "reconcile", agentId: AGENT_ID });
	});
});
