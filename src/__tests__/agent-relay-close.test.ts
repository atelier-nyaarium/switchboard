import { describe, expect, it } from "vitest";
import { AgentRelay } from "../gateway/agentRelay.js";
import { HELD_FRAME_LIMIT_MS, RECONCILE_GUARD_MS } from "../gateway/agentRelayCore.js";
import { AgentService } from "../gateway/agentService.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/wsTypes.js";
import { AGENT_BACKENDS, type AgentBackendId } from "../shared/agent-backend.js";
import { AGENT_TURN_UNACCOUNTED_REASON, agentIdForOperation } from "../shared/agent-record.js";
import { type PersistedAgentCatalogWriter, SessionStore } from "../shared/session-store.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const BACKEND = AGENT_BACKENDS.find((backend) => backend.id === "opencode")!;
const DAEMON = "daemon-1";
const TARGET = { kind: "devcontainer" as const, project: "recipe-app", hostProjectPath: "/trusted/recipe-app" };
const RESOLVED = { kind: "devcontainer" as const, targetId: "container:recipe-app", cwd: "/workspace/recipe-app" };
const SESSION = "session-1";
const START = "123e4567-e89b-42d3-a456-426614174000";
const FOLLOW_UP = "123e4567-e89b-42d3-a456-426614174001";
const AGENT = agentIdForOperation(BACKEND.id, START);

function setup() {
	const ambient = fakeAmbient({ drive: "manual" });
	const writers = new Map<AgentBackendId, PersistedAgentCatalogWriter>();
	let disk = true;
	const store = new SessionStore({
		ambient,
		agentCatalogPersistence: { persistChecked: () => disk, receiveWriter: (id, writer) => writers.set(id, writer) },
	});
	const registry: TeamRegistry = new Map();
	const auth = createSessionAuthority({
		sessionStore: store,
		registry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => "alice",
		localGatewayId: "sakura",
	});
	const owner = store.mint({ spawn: "recipe-app", sessionLabel: "Work", harness: "claude" });
	store.ensureBindToken(owner);
	store.activateBinding(owner);
	store.confirm(store.teamOf(owner));
	const service = new AgentService({
		backend: BACKEND,
		auth,
		sessionStore: store,
		offlineCatalog: new Map([["recipe-app", "/trusted/recipe-app"]]),
		catalogWriter: writers.get(BACKEND.id)!,
	});
	const sent: Record<string, unknown>[] = [];
	let live: string | undefined = DAEMON;
	let changes = 0;
	let reaches = true;
	let tries = 0;
	const relay = new AgentRelay({
		backendId: BACKEND.id,
		service,
		sessionStore: store,
		liveDaemonInstanceId: () => live,
		ambient,
		sendToHost: (message) => {
			tries += 1;
			if (!reaches) return false;
			sent.push(message);
			return true;
		},
	});
	const ownerKey = store.teamOf(owner);
	relay.onAgentChange(ownerKey, AGENT, () => {
		changes += 1;
	});
	const frame = (type: "event" | "receipt", eventId: number, body: Record<string, unknown>, generation = 1) => ({
		type: `${BACKEND.id}_${type}`,
		ownerKey,
		daemonInstanceId: DAEMON,
		targetId: RESOLVED.targetId,
		generation,
		eventId,
		agentId: AGENT,
		sessionId: SESSION,
		...body,
	});
	const deliver = async (message: Record<string, unknown>) => {
		await relay.handleHostMessage(message);
		await ambient.advance(0);
	};
	return {
		ambient,
		service,
		owner,
		ownerKey,
		sent,
		deliver,
		setLive: (next: string | undefined) => {
			live = next;
		},
		changes: () => changes,
		relay,
		setReaches: (next: boolean) => {
			reaches = next;
		},
		tries: () => tries,
		setDisk: (next: boolean) => {
			disk = next;
		},
		terminal: (eventId: number, turnId: string) =>
			deliver(frame("event", eventId, { kind: "terminal", turnId, state: "completed", finalResponse: "done" })),
		/** Dropped frame count. */
		hello: (evicted?: number) =>
			deliver({
				type: `${BACKEND.id}_hello`,
				daemonInstanceId: DAEMON,
				targets: [{ targetId: RESOLVED.targetId, generation: 1 }],
				...(evicted ? { evicted: [{ targetId: RESOLVED.targetId, generation: 1, count: evicted }] } : {}),
			}),
		async start() {
			service.beginStart(owner, {
				agentId: AGENT,
				operationId: START,
				daemonInstanceId: DAEMON,
				prompt: "start",
				target: TARGET,
				at: ambient.now(),
			});
			await deliver(
				frame("receipt", 0, {
					kind: "accepted",
					requestId: START,
					operationId: START,
					resolvedTarget: RESOLVED,
					turnId: "turn-1",
					delivery: "started",
				}),
			);
		},
		activity: (eventId: number, turnId: string, generation = 1) =>
			deliver(
				frame(
					"event",
					eventId,
					{ kind: "activity", turnId, itemId: `item-${eventId}`, text: "working" },
					generation,
				),
			),
		reconciled: (eventId: number, turn?: { turnId: string; turnState: string }) =>
			deliver(
				frame("receipt", eventId, { kind: "reconciled", requestId: START, resolvedTarget: RESOLVED, ...turn }),
			),
		accepted: (eventId: number, operationId: string, turnId: string) =>
			deliver(
				frame("receipt", eventId, {
					kind: "accepted",
					requestId: operationId,
					operationId,
					resolvedTarget: RESOLVED,
					turnId,
					delivery: "started",
				}),
			),
		agent: () => service.listOwnedAgents(owner).find((agent) => agent.agentId === AGENT)!,
		asks: () => sent.filter((message) => message.kind === "reconcile"),
		ackedThrough: (generation = 1) =>
			sent
				.filter((message) => message.type === `${BACKEND.id}_ack` && message.generation === generation)
				.map((message) => message.throughEventId as number)
				.at(-1),
	};
}

describe("a hold nothing places is closed at its limit", () => {
	it("ends the record's turn and adopts the one the daemon kept reporting", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		await context.activity(1, "turn-2");
		await context.reconciled(2, { turnId: "turn-2", turnState: "inProgress" });
		expect(context.agent().activeTurnId).toBe("turn-1");
		expect(context.ackedThrough()).toBe(0);

		const asked = context.asks().length;
		await context.ambient.advance(RECONCILE_GUARD_MS);
		expect(context.asks().length).toBe(asked + 1);

		const before = context.changes();
		await context.ambient.advance(HELD_FRAME_LIMIT_MS - RECONCILE_GUARD_MS);

		const agent = context.agent();
		expect(agent.turns.find((turn) => turn.id === "turn-1")).toMatchObject({
			state: "interrupted",
			reason: AGENT_TURN_UNACCOUNTED_REASON,
		});
		expect(agent).toMatchObject({ agentState: "working", activeTurnId: "turn-2" });
		expect(agent.turns.find((turn) => turn.id === "turn-2")?.activities).toHaveLength(1);
		expect(context.ackedThrough()).toBe(2);
		expect(context.changes()).toBeGreaterThan(before);
	});

	it("ends a turn the daemon never accounted for, and lets its stream go", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		await context.activity(0, "turn-1", 2);
		expect(context.asks()).toHaveLength(1);
		expect(context.ackedThrough(2)).toBeUndefined();

		await context.ambient.advance(HELD_FRAME_LIMIT_MS);

		expect(context.agent()).toMatchObject({ agentState: "idle" });
		expect(context.agent().turns[0]).toMatchObject({ state: "interrupted", reason: AGENT_TURN_UNACCOUNTED_REASON });
		expect(context.ackedThrough(2)).toBe(0);
	});

	it("keeps a turn the daemon vouches for, and gives up only the frame and its operation", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		context.service.beginMessage(context.owner, {
			agentId: AGENT,
			operationId: FOLLOW_UP,
			daemonInstanceId: DAEMON,
			prompt: "more",
			at: context.ambient.now(),
		});
		// A second accepted turn cannot replace the active one.
		await context.accepted(1, FOLLOW_UP, "turn-2");
		await context.reconciled(2, { turnId: "turn-1", turnState: "inProgress" });
		expect(context.ackedThrough()).toBe(0);

		await context.ambient.advance(HELD_FRAME_LIMIT_MS);

		const agent = context.agent();
		expect(agent.turns.find((turn) => turn.id === "turn-1")?.state).toBe("inProgress");
		expect(agent.turns.some((turn) => turn.id === "turn-2")).toBe(false);
		expect(agent.operations.find((operation) => operation.operationId === FOLLOW_UP)?.state).toBe("indeterminate");
		expect(context.ackedThrough()).toBe(2);
	});

	it("asks about a working agent when its daemon says frames were dropped, once per report", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		// A live fence avoids an ask.
		await context.hello();
		expect(context.asks()).toHaveLength(0);

		await context.hello(3);
		expect(context.asks()).toHaveLength(1);
		await context.hello(3);
		expect(context.asks()).toHaveLength(1);
		// New drop reports trigger another ask.
		await context.hello(4);
		expect(context.asks()).toHaveLength(2);
	});

	it("asks about a turn that opens on a stream whose frames were dropped", async () => {
		const context = setup();
		await context.hello();
		context.service.beginStart(context.owner, {
			agentId: AGENT,
			operationId: START,
			daemonInstanceId: DAEMON,
			prompt: "start",
			target: TARGET,
			at: context.ambient.now(),
		});
		// Its receipt and its terminal may both be among them, and it is not working yet.
		await context.hello(3);
		expect(context.asks()).toHaveLength(0);

		await context.accepted(0, START, "turn-1");

		expect(context.agent().agentState).toBe("working");
		expect(context.asks()).toHaveLength(1);
	});

	it("starts the wait over at a hello", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		await context.activity(0, "turn-1", 2);

		await context.ambient.advance(HELD_FRAME_LIMIT_MS - 1_000);
		await context.hello();
		await context.ambient.advance(HELD_FRAME_LIMIT_MS - 1_000);
		expect(context.agent().agentState).toBe("working");

		await context.ambient.advance(RECONCILE_GUARD_MS);
		expect(context.agent().agentState).toBe("idle");
	});

	it("gives nothing up while no daemon is live", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		await context.activity(0, "turn-1", 2);

		context.setLive(undefined);
		await context.ambient.advance(HELD_FRAME_LIMIT_MS * 2);
		expect(context.agent().agentState).toBe("working");

		// A returning daemon starts a new hold.
		context.setLive(DAEMON);
		await context.hello();
		await context.ambient.advance(HELD_FRAME_LIMIT_MS - RECONCILE_GUARD_MS);
		expect(context.agent().agentState).toBe("working");
		await context.ambient.advance(RECONCILE_GUARD_MS * 2);
		expect(context.agent().agentState).toBe("idle");
	});

	it("holds on to the last millisecond, then lets go", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		await context.activity(0, "turn-1", 2);

		await context.ambient.advance(HELD_FRAME_LIMIT_MS - 1);
		expect(context.agent().agentState).toBe("working");
		expect(context.asks()).toHaveLength(2);

		await context.ambient.advance(1);
		expect(context.agent().agentState).toBe("idle");
	});

	it("keeps a turn that opened after the daemon was last asked", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		await context.activity(0, "turn-1", 2);
		await context.ambient.advance(RECONCILE_GUARD_MS + 60_000);
		await context.terminal(1, "turn-1");
		context.service.beginMessage(context.owner, {
			agentId: AGENT,
			operationId: FOLLOW_UP,
			daemonInstanceId: DAEMON,
			prompt: "more",
			at: context.ambient.now(),
		});
		await context.accepted(2, FOLLOW_UP, "turn-2");

		await context.ambient.advance(HELD_FRAME_LIMIT_MS - RECONCILE_GUARD_MS - 60_000);

		expect(context.agent()).toMatchObject({ agentState: "working", activeTurnId: "turn-2" });
		expect(context.ackedThrough(2)).toBe(0);
	});

	it("tries an ask that did not get out once a guard, never in a loop", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		await context.activity(0, "turn-1", 2);
		context.setReaches(false);
		const before = context.tries();

		await context.ambient.advance(RECONCILE_GUARD_MS);
		expect(context.tries() - before).toBe(1);

		// Asked at the hold, so its limit still closes it.
		await context.ambient.advance(HELD_FRAME_LIMIT_MS);
		expect(context.agent().agentState).toBe("idle");
	});

	it("gives nothing up to a daemon it could not ask since the hold began", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		context.setReaches(false);
		await context.activity(0, "turn-1", 2);

		await context.ambient.advance(HELD_FRAME_LIMIT_MS + RECONCILE_GUARD_MS);
		expect(context.agent().agentState).toBe("working");
		expect(context.ackedThrough(2)).toBeUndefined();

		// A successful ask permits closure.
		context.setReaches(true);
		await context.ambient.advance(RECONCILE_GUARD_MS * 2);
		expect(context.agent().agentState).toBe("idle");
	});

	it("keeps the frames of a close whose write is not on disk yet", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		await context.activity(0, "turn-1", 2);
		context.setDisk(false);

		await context.ambient.advance(HELD_FRAME_LIMIT_MS);
		expect(context.agent().agentState).toBe("idle");
		expect(context.ackedThrough(2)).toBeUndefined();

		context.setDisk(true);
		context.relay.reconcileStale(context.owner);
		await context.ambient.advance(0);
		expect(context.ackedThrough(2)).toBe(0);
	});

	it("keeps another stream's frames too while a close's write is not on disk", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		await context.activity(1, "turn-2");
		await context.reconciled(2, { turnId: "turn-2", turnState: "inProgress" });
		await context.activity(5, "turn-1", 2);
		context.setDisk(false);

		await context.ambient.advance(HELD_FRAME_LIMIT_MS);
		expect(context.agent()).toMatchObject({ agentState: "working", activeTurnId: "turn-2" });
		expect(context.ackedThrough(2)).toBeUndefined();

		context.setDisk(true);
		context.relay.reconcileStale(context.owner);
		await context.ambient.advance(0);
		expect(context.ackedThrough(2)).toBe(5);
	});

	it("asks about nothing and gives nothing up once it is stopped", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		await context.activity(0, "turn-1", 2);
		const asked = context.asks().length;

		context.relay.stop();
		await context.ambient.advance(HELD_FRAME_LIMIT_MS + RECONCILE_GUARD_MS);
		context.relay.reconcileStale(context.owner);

		expect(context.agent().agentState).toBe("working");
		expect(context.asks()).toHaveLength(asked);
	});

	it("gives nothing up for a daemon whose hello has not come", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		await context.activity(0, "turn-1", 2);

		context.setLive("daemon-2");
		await context.ambient.advance(HELD_FRAME_LIMIT_MS + RECONCILE_GUARD_MS);

		expect(context.agent().agentState).toBe("working");
	});

	it("asks about a dropped frame's agents again when the first ask did not get out", async () => {
		const context = setup();
		await context.hello();
		await context.start();
		context.setReaches(false);
		await context.hello(3);
		expect(context.asks()).toHaveLength(0);

		context.setReaches(true);
		await context.hello(3);
		expect(context.asks()).toHaveLength(1);
	});
});
