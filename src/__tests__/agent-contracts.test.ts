import { describe, expect, it } from "vitest";
import { AgentService } from "../gateway/agentService.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/wsTypes.js";
import { AgentActivitySchema } from "../shared/agent-activities.js";
import { CODEX_BACKEND } from "../shared/agent-backend.js";
import { PersistedAgentCatalogSchema, restorePersistedAgentCatalog } from "../shared/agent-catalog.js";
import { agentListAnswer, agentListRow } from "../shared/agent-collect.js";
import { AgentErrorTextSchema, agentErrorText, agentOperationIdentity } from "../shared/agent-identity.js";
import { type PersistedAgent, PersistedAgentSchema } from "../shared/agent-persisted.js";
import {
	AGENT_ACTIVITY_MAX_BYTES,
	AGENT_ERROR_MAX_BYTES,
	AGENT_PROMPT_MAX_BYTES,
	agentOperationFingerprintOf,
} from "../shared/agent-record.js";
import { AgentGatewayRequestSchema, AgentResultSchema, AgentStartInputSchema } from "../shared/agent-state.js";
import { agentWire } from "../shared/agent-wire.js";
import { processAmbient } from "../shared/ambient.js";
import { type PersistedAgentCatalogWriter, SessionStore } from "../shared/session-store.js";

const AGENT_ID = "codex_0123456789abcdef0123456789abcdef";
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const TARGET = { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/trusted/recipe-app" } as const;
const RESOLVED = { kind: "devcontainer", targetId: "container:recipe-app", cwd: "/workspace" } as const;

function creatingAgent(agentId = AGENT_ID, operationId = OPERATION_ID): PersistedAgent {
	return PersistedAgentSchema.parse({
		version: 2,
		agentId,
		agentState: "creating",
		requestedTarget: TARGET,
		operations: [
			{
				operationId,
				kind: "start",
				prompt: "Review",
				fingerprint: agentOperationFingerprintOf(
					agentOperationIdentity({ kind: "start", agentId, prompt: "Review" }),
				),
				state: "requested",
				createdAt: 10,
				updatedAt: 10,
			},
		],
		turns: [],
		createdAt: 10,
		updatedAt: 10,
	});
}

function ownedService() {
	let writer: PersistedAgentCatalogWriter | undefined;
	const sessionStore = new SessionStore({
		ambient: processAmbient(),
		agentCatalogPersistence: {
			persistChecked: () => undefined,
			receiveWriter: (backend, value) => {
				if (backend === "codex") writer = value;
			},
		},
	});
	const auth = createSessionAuthority({
		sessionStore,
		registry: new Map() as TeamRegistry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => "alice",
		localGatewayId: "sakura",
	});
	const offlineCatalog = new Map<string, string>();
	const service = new AgentService({
		backend: CODEX_BACKEND,
		auth,
		sessionStore,
		offlineCatalog,
		catalogWriter: writer!,
	});
	return { service, sessionStore, offlineCatalog, writer: writer! };
}

function owner(sessionStore: SessionStore, spawn: string) {
	const record = sessionStore.mint({ spawn, sessionLabel: "Work", harness: "claude" });
	sessionStore.ensureBindToken(record);
	sessionStore.activateBinding(record);
	sessionStore.confirm(sessionStore.teamOf(record));
	return record;
}

describe("the generic agent contract for Codex", () => {
	it("accepts public inputs and private gateway requests at their boundaries", () => {
		expect(AgentStartInputSchema.parse({ prompt: "Review" })).toEqual({ prompt: "Review" });
		expect(AgentStartInputSchema.safeParse({ prompt: "Review", operationId: OPERATION_ID }).success).toBe(false);
		expect(
			AgentGatewayRequestSchema.safeParse({ kind: "start", operationId: OPERATION_ID, prompt: "Review" }).success,
		).toBe(true);
		expect(AgentGatewayRequestSchema.safeParse({ kind: "list" }).success).toBe(true);
	});

	it("bounds UTF-8 prompts and activity text", () => {
		expect(AgentStartInputSchema.safeParse({ prompt: "x".repeat(AGENT_PROMPT_MAX_BYTES) }).success).toBe(true);
		expect(AgentStartInputSchema.safeParse({ prompt: "x".repeat(AGENT_PROMPT_MAX_BYTES + 1) }).success).toBe(false);
		expect(AgentStartInputSchema.safeParse({ prompt: "  \n" }).success).toBe(false);
		expect(
			AgentActivitySchema.safeParse({ kind: "commentary", text: "x".repeat(AGENT_ACTIVITY_MAX_BYTES + 1) })
				.success,
		).toBe(false);
	});

	it("sanitizes error text into an idempotent bounded value", () => {
		const value = agentErrorText(` daemon\nfailed\u0000 ${"🙂".repeat(AGENT_ERROR_MAX_BYTES)} `);
		expect(agentErrorText(value)).toBe(value);
		expect(AgentErrorTextSchema.safeParse(value).success).toBe(true);
		expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(AGENT_ERROR_MAX_BYTES);
	});

	it("keeps result observations consistent with native turn state", () => {
		const base = { agentId: AGENT_ID, activities: [] };
		expect(
			AgentResultSchema.safeParse({ ...base, agentState: "creating", observation: "waitTimedOut" }).success,
		).toBe(true);
		expect(
			AgentResultSchema.safeParse({
				...base,
				agentState: "working",
				observation: "accepted",
				turn: { id: "turn-1", state: "inProgress" },
				delivery: "started",
			}).success,
		).toBe(true);
		expect(AgentResultSchema.safeParse({ ...base, agentState: "working", observation: "accepted" }).success).toBe(
			false,
		);
		expect(
			AgentResultSchema.safeParse({
				...base,
				agentState: "idle",
				observation: "idle",
				turn: { id: "turn-1", state: "inProgress" },
			}).success,
		).toBe(false);
	});

	it("validates daemon commands, receipts, and events on the generic wire", () => {
		const wire = agentWire("codex");
		const command = {
			type: "codex_command",
			kind: "start",
			requestId: OPERATION_ID,
			ownerKey: "recipe-app.owner",
			operationId: OPERATION_ID,
			agentId: AGENT_ID,
			target: TARGET,
			prompt: "Review",
		};
		expect(wire.command.safeParse(command).success).toBe(true);
		expect(wire.command.safeParse({ ...command, target: { ...TARGET, project: "../other" } }).success).toBe(false);

		const accepted = {
			type: "codex_receipt",
			kind: "accepted",
			requestId: OPERATION_ID,
			ownerKey: "recipe-app.owner",
			operationId: OPERATION_ID,
			daemonInstanceId: "daemon-1",
			targetId: RESOLVED.targetId,
			generation: 1,
			eventId: 2,
			agentId: AGENT_ID,
			resolvedTarget: RESOLVED,
			sessionId: "thread-1",
			turnId: "turn-1",
			delivery: "started",
		};
		expect(wire.receipt.safeParse(accepted).success).toBe(true);
		expect(wire.receipt.safeParse({ ...accepted, turnId: undefined }).success).toBe(false);

		const event = {
			type: "codex_event",
			kind: "terminal",
			ownerKey: "recipe-app.owner",
			daemonInstanceId: "daemon-1",
			targetId: "host",
			generation: 1,
			eventId: 3,
			agentId: AGENT_ID,
			sessionId: "thread-1",
			turnId: "turn-1",
		};
		expect(wire.event.safeParse({ ...event, state: "completed", finalResponse: "Done" }).success).toBe(true);
		expect(wire.event.safeParse({ ...event, state: "completed" }).success).toBe(false);
	});

	it("lists busy and uncollected agents, newest first, within the limit", () => {
		const starting = creatingAgent();
		const second = creatingAgent("codex_abcdef0123456789abcdef0123456789", "223e4567-e89b-42d3-a456-426614174000");
		const done = { ...second, agentId: "codex_00000000000000000000000000000001", agentState: "idle" as const };
		const row = (agent: PersistedAgent) => agentListRow(agent, "codex", {});
		expect(agentListAnswer([starting, second, done], { limit: 1 }, row)).toMatchObject({
			omitted: 1,
			agents: [{ agentId: second.agentId, running: true, uncollected: 0 }],
		});
		expect(agentListAnswer([done], {}, row).agents).toEqual([]);
		expect(agentListAnswer([done], { agentId: done.agentId }, row).agents).toHaveLength(1);
	});

	it("restores valid entries and drops malformed or ambiguous ones", () => {
		const valid = creatingAgent();
		const kept = restorePersistedAgentCatalog({ version: 1, revision: 7, agents: [valid, { broken: true }] });
		expect(kept).toEqual({
			version: 1,
			revision: 7,
			agents: [{ ...valid, turnMarks: { collected: [], notified: [] } }],
		});

		const duplicate = creatingAgent(
			"codex_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"123e4567-e89b-42d3-a456-426614174001",
		);
		const ambiguous = restorePersistedAgentCatalog({
			version: 1,
			revision: 7,
			agents: [valid, { ...duplicate, operations: [{ ...duplicate.operations[0]!, operationId: OPERATION_ID }] }],
		});
		expect(ambiguous).toEqual({ version: 1, revision: 7, agents: [] });

		expect(
			restorePersistedAgentCatalog({ version: 1, revision: Number.MAX_VALUE, agents: [valid] }),
		).toBeUndefined();
		expect(PersistedAgentCatalogSchema.safeParse({ version: 1, revision: 0, agents: [valid] }).success).toBe(true);
	});

	it("accepts a valid persisted lifecycle and rejects dangling references", () => {
		const persisted = creatingAgent();
		const fence = { daemonInstanceId: "daemon-1", targetId: RESOLVED.targetId, generation: 1, lastEventId: 2 };
		const accepted = {
			...persisted,
			agentState: "idle",
			resolvedTarget: RESOLVED,
			sessionId: "thread-1",
			turns: [{ id: "turn-1", state: "completed", activities: [], finalResponse: "Done", updatedAt: 12 }],
			operations: [
				{
					...persisted.operations[0]!,
					state: "accepted",
					delivery: "started",
					sessionId: "thread-1",
					turnId: "turn-1",
					updatedAt: 11,
				},
			],
			fence,
			updatedAt: 12,
		};
		expect(PersistedAgentSchema.safeParse(accepted).success).toBe(true);
		expect(
			PersistedAgentSchema.safeParse({ ...accepted, activeTurnId: "missing", agentState: "working" }).success,
		).toBe(false);
		expect(PersistedAgentSchema.safeParse({ ...persisted, unknown: true }).success).toBe(false);
	});

	it("resolves owners and execution targets from SessionStore state", () => {
		const { service, sessionStore, offlineCatalog } = ownedService();
		const record = owner(sessionStore, "recipe-app");
		const request = new Request("http://gateway/codex?session=other", {
			headers: { "x-session-token": record.bindToken! },
		});
		expect(service.resolveOwner(request)).toBe(record);
		expect(service.resolveOwner(new Request("http://gateway/codex"))).toBeNull();
		expect(service.resolveExecutionTarget(record)).toBeNull();
		offlineCatalog.set("recipe-app", "/trusted/recipe-app");
		expect(service.resolveExecutionTarget(record)).toEqual(TARGET);
		const host = sessionStore.mint({
			spawn: "host",
			workdirHint: "Original",
			workdirPath: "/projects/chosen",
			harness: "claude",
		});
		expect(service.resolveExecutionTarget(host)).toEqual({ kind: "host", workdirHint: "/projects/chosen" });
	});

	it("reads an unchanged catalog as one frozen view, and as a new one after a commit", () => {
		const { service, sessionStore } = ownedService();
		const record = owner(sessionStore, "recipe-app");
		service.beginStart(record, {
			agentId: AGENT_ID,
			operationId: OPERATION_ID,
			prompt: "Review",
			target: TARGET,
			at: 20,
		});
		const first = sessionStore.agentCatalog(record, "codex")!;
		const again = sessionStore.agentCatalog(record, "codex")!;
		service.beginStart(record, {
			agentId: "codex_fedcba9876543210fedcba9876543210",
			operationId: "123e4567-e89b-42d3-a456-426614174001",
			prompt: "Second",
			target: TARGET,
			at: 22,
		});
		const after = sessionStore.agentCatalog(record, "codex")!;

		expect(again).toBe(first);
		expect(() => (first.agents as unknown[]).push({})).toThrow(TypeError);
		expect(first.agents).toHaveLength(1);
		expect(after.agents).toHaveLength(2);
	});
});
