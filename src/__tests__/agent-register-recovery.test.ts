import { expect, it } from "vitest";
import { AgentRelay } from "../gateway/agentRelay.js";
import { AgentService } from "../gateway/agentService.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/wsTypes.js";
import { AGENT_BACKENDS, type AgentBackendId } from "../shared/agent-backend.js";
import { agentIdForOperation } from "../shared/agent-record.js";
import { processAmbient } from "../shared/ambient.js";
import { type PersistedAgentCatalogWriter, SessionStore } from "../shared/session-store.js";

const oldDaemon = "daemon-old";
const newDaemon = "daemon-new";
const executionTarget = {
	kind: "devcontainer" as const,
	project: "recipe-app",
	hostProjectPath: "/trusted/recipe-app",
};
const resolvedTarget = {
	kind: "devcontainer" as const,
	targetId: "container:recipe-app",
	cwd: "/workspace/recipe-app",
};

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

it.each(AGENT_BACKENDS.map((backend, index) => [backend.id, backend, index] as const))(
	"%s abandons stale requested starts, messages, and stops before hello",
	async (backendId, backend, index) => {
		const ops = [0, 1, 2, 3, 4].map((tail) => `${index + 1}23e4567-e89b-42d3-a456-42661417400${tail}`);
		const writers = new Map<AgentBackendId, PersistedAgentCatalogWriter>();
		const store = new SessionStore({
			ambient: processAmbient(),
			agentCatalogPersistence: {
				persistChecked: () => true,
				receiveWriter: (id, writer) => {
					writers.set(id, writer);
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
		const owner = store.mint({ spawn: "recipe-app", sessionLabel: "Work", harness: "claude" });
		store.ensureBindToken(owner);
		store.activateBinding(owner);
		store.confirm(store.teamOf(owner));
		const service = new AgentService({
			backend,
			auth,
			sessionStore: store,
			offlineCatalog: new Map([["recipe-app", "/trusted/recipe-app"]]),
			catalogWriter: writers.get(backendId)!,
		});
		let liveDaemonInstanceId: string | undefined = oldDaemon;
		const relay = new AgentRelay({
			backendId,
			service,
			sessionStore: store,
			liveDaemonInstanceId: () => liveDaemonInstanceId,
			ambient: processAmbient(),
			sendToHost: () => true,
		});
		const ownerKey = store.teamOf(owner);
		const at = 1_000;
		const startIds = [ops[0]!, ops[1]!, ops[3]!];
		const agents = startIds.map((operationId) => agentIdForOperation(backendId, operationId));
		const changes = agents.map(() => 0);
		for (const [held, agentId] of agents.entries()) {
			relay.onAgentChange(ownerKey, agentId, () => {
				changes[held]! += 1;
			});
		}

		for (const operationId of startIds) {
			service.beginStart(owner, {
				agentId: agentIdForOperation(backendId, operationId),
				operationId,
				daemonInstanceId: oldDaemon,
				prompt: "start",
				target: executionTarget,
				at,
			});
		}
		for (const [eventId, operationId] of [ops[1]!, ops[3]!].entries()) {
			service.applyReceipt(
				{
					type: `${backendId}_receipt`,
					kind: "accepted",
					requestId: operationId,
					ownerKey,
					daemonInstanceId: oldDaemon,
					targetId: resolvedTarget.targetId,
					generation: 1,
					eventId,
					agentId: agentIdForOperation(backendId, operationId),
					operationId,
					resolvedTarget,
					sessionId: `session-${eventId}`,
					turnId: `turn-${eventId}`,
					delivery: "started",
				},
				at,
			);
		}
		service.beginMessage(owner, {
			agentId: agents[1]!,
			operationId: ops[2]!,
			daemonInstanceId: oldDaemon,
			prompt: "message",
			at: at + 1,
		});
		service.beginStop(owner, {
			agentId: agents[2]!,
			operationId: ops[4]!,
			daemonInstanceId: oldDaemon,
			at: at + 1,
		});

		liveDaemonInstanceId = newDaemon;
		relay.onHostRegister();
		await settle();

		const rows = service.listOwnedAgents(owner);
		expect(rows.find((agent) => agent.agentId === agents[0])).toMatchObject({
			agentState: "unavailable",
			operations: [{ state: "indeterminate" }],
		});
		expect(rows.find((agent) => agent.agentId === agents[1])).toMatchObject({
			agentState: "recovering",
			operations: [{ state: "accepted" }, { state: "indeterminate" }],
		});
		expect(rows.find((agent) => agent.agentId === agents[2])).toMatchObject({
			operations: [{ state: "accepted" }, { state: "indeterminate" }],
		});
		expect(changes).toEqual([1, 1, 1]);
	},
);
