import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { createAgentWatch } from "../gateway/agentAwareness.js";
import { composeAgents } from "../gateway/compose/composeAgents.js";
import { composeBaseline } from "../gateway/compose/composeBaseline.js";
import { createPurgeQueue } from "../gateway/purgeQueue.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import type { WsData } from "../gateway/wsTypes.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/wsTypes.js";
import { AGENT_BACKEND_IDS, type AgentBackendId, agentHttpPath } from "../shared/agent-backend.js";
import { agentIdForOperation } from "../shared/agent-record.js";
import { processAmbient } from "../shared/ambient.js";
import { SESSION_BASELINE_PATH } from "../shared/session-baseline.js";
import { type PersistedAgentCatalogWriter, SessionStore } from "../shared/session-store.js";

const resolvedTarget = {
	kind: "devcontainer" as const,
	targetId: "container:recipe-app",
	cwd: "/workspace/recipe-app",
};

function setup() {
	const ambient = processAmbient();
	const agentCatalogWriters = new Map<AgentBackendId, PersistedAgentCatalogWriter>();
	const sessionStore = new SessionStore({
		ambient,
		agentCatalogPersistence: {
			persistChecked: () => true,
			receiveWriter: (backend, writer) => {
				agentCatalogWriters.set(backend, writer);
			},
		},
	});
	const registry: TeamRegistry = new Map();
	const sessionAuthority = createSessionAuthority({
		sessionStore,
		registry,
		resolveLive: resolveLiveIncarnation,
		localDomainId: () => "alice",
		localGatewayId: "sakura",
	});
	const owner = sessionStore.mint({ spawn: "recipe-app", sessionLabel: "Work", harness: "claude" });
	const token = sessionStore.ensureBindToken(owner);
	sessionStore.activateBinding(owner);
	sessionStore.confirm(sessionStore.teamOf(owner));
	const outbound: Record<string, unknown>[] = [];
	const socket = {
		readyState: 1,
		send(payload: string) {
			outbound.push(JSON.parse(payload) as Record<string, unknown>);
			return 1;
		},
	} as unknown as ServerWebSocket<WsData>;
	let daemonInstanceId: string | undefined = "daemon-1";
	let containerInCatalog = true;
	const agents = composeAgents({
		sessions: {
			sessionAuthority,
			sessionStore,
			offlineCatalog: new Map([["recipe-app", "/trusted/recipe-app"]]),
			agentCatalogWriters,
			purgeQueue: createPurgeQueue(processAmbient()),
			saveSessionsChecked: () => true,
		},
		host: {
			readLiveness: () => ({
				socket: daemonInstanceId ? socket : undefined,
				daemonInstanceId,
				containerInCatalog: (target) => target.kind === "devcontainer" && containerInCatalog,
			}),
			relayToHost: async () => ({ ok: false, error: "not used" }),
		},
		ambient,
	});
	const baseline = composeBaseline({
		context: { slice: () => null } as never,
		stores: { jobs: { conversationsTo: () => [] } } as never,
		sessions: { sessionAuthority, sessionStore } as never,
		routines: { openRuns: () => [] },
		workflows: { runner: { running: () => [] }, engine: { phase: () => null } } as never,
		assistant: { baselineFor: () => undefined },
	});
	return {
		agents,
		ambient,
		baseline,
		outbound,
		owner,
		sessionStore,
		token,
		setDaemonInstanceId: (value: string | undefined) => (daemonInstanceId = value),
		setContainerInCatalog: (value: boolean) => (containerInCatalog = value),
	};
}

async function accept(context: ReturnType<typeof setup>, backend: AgentBackendId, operationId: string) {
	const commands = context.outbound.filter((frame) => frame.type === `${backend}_command`);
	const command = commands.find((frame) => frame.operationId === operationId)!;
	context.agents.stacks.get(backend)!.relay.handleHostMessage({
		type: `${backend}_receipt`,
		kind: "accepted",
		requestId: command.requestId,
		ownerKey: context.sessionStore.teamOf(context.owner),
		daemonInstanceId: "daemon-1",
		targetId: "container:recipe-app",
		generation: 1,
		eventId: commands.length,
		agentId: command.agentId,
		operationId,
		resolvedTarget,
		sessionId: `session-${command.agentId}`,
		turnId: `turn-${backend}`,
		delivery: operationId.endsWith("000") ? "started" : "steered",
	});
	for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

/** Each backend's own operation ids. */
function idsOf(index: number) {
	const id = (tail: number) => `${index + 1}23e4567-e89b-42d3-a456-42661417400${tail}`;
	return { start: id(0), message: id(1), stop: id(2), missingCatalog: id(3), noHost: id(4) };
}

describe("agent command seams", () => {
	it.each(AGENT_BACKEND_IDS.map((backend, index) => [backend, idsOf(index)] as const))(
		"%s dispatches owner-based operations, gates container starts, and hides run agents",
		async (backend, ids) => {
			const context = setup();
			const { owner, agents, sessionStore } = context;
			const stack = agents.stacks.get(backend)!;
			const held = () => sessionStore.listAgents(owner, backend);
			const agentId = agentIdForOperation(backend, ids.start);

			context.setDaemonInstanceId(undefined);
			expect(stack.start(owner, { operationId: ids.noHost, prompt: "start" }).kind).toBe("refused");
			expect(held()).toHaveLength(0);
			context.setDaemonInstanceId("daemon-1");
			context.setContainerInCatalog(false);
			expect(stack.start(owner, { operationId: ids.missingCatalog, prompt: "start" })).toMatchObject({
				kind: "refused",
				reason: "container target is not in the host catalog",
			});
			expect(held()).toHaveLength(0);
			context.setContainerInCatalog(true);

			expect(stack.start(owner, { operationId: ids.start, prompt: "start", runId: "run-1" })).toMatchObject({
				kind: "committed",
			});
			expect(held()[0]?.runId).toBe("run-1");
			expect(held()[0]?.operations[0]?.daemonInstanceId).toBe("daemon-1");
			await accept(context, backend, ids.start);
			expect(held()[0]?.agentState).toBe("working");
			expect(stack.retire(owner, agentId)).toEqual({ retired: false, reason: "active_turn" });

			context.setDaemonInstanceId(undefined);
			const before = held()[0]!.operations.length;
			expect(stack.message(owner, { agentId, operationId: ids.message, prompt: "message" }).kind).toBe("refused");
			expect(stack.stop(owner, { agentId, operationId: ids.stop }).kind).toBe("refused");
			expect(held()[0]?.operations).toHaveLength(before);
			context.setDaemonInstanceId("daemon-1");

			expect(stack.message(owner, { agentId, operationId: ids.message, prompt: "message" })).toMatchObject({
				kind: "committed",
			});
			expect(held()[0]?.operations.at(-1)?.daemonInstanceId).toBe("daemon-1");
			await accept(context, backend, ids.message);
			expect(stack.stop(owner, { agentId, operationId: ids.stop })).toMatchObject({ kind: "committed" });
			expect(held()[0]?.operations.at(-1)?.daemonInstanceId).toBe("daemon-1");

			const request = new Request(`http://gateway/${backend}`, { headers: { "x-session-token": context.token } });
			const route = agents.agentRoutes.get(agentHttpPath(backend))!;
			const message = await route(request, { kind: "message", operationId: ids.noHost, agentId, prompt: "x" });
			const stop = await route(request, { kind: "stop", operationId: ids.missingCatalog, agentId });
			expect(message.status).toBe(400);
			expect(stop.status).toBe(400);
			expect(JSON.stringify(await message.json())).toContain("workflowStop");
			expect(JSON.stringify(await stop.json())).toContain("workflowStop");

			expect(agents.agentRoster()).toEqual([]);
			const observations: unknown[] = [];
			createAgentWatch({
				roster: agents.agentRoster,
				observe: (rows) => observations.push(...rows),
				now: () => 10,
			}).tick();
			expect(observations).toEqual([]);
			expect(await (await route(request, { kind: "list" })).json()).toMatchObject({ agents: [] });
			const baseline = await context.baseline.routes.get(SESSION_BASELINE_PATH)!(request, {});
			expect(await baseline.json()).toMatchObject({ agents: [] });
		},
	);
});
