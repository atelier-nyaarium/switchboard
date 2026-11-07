import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { createAgentWatch } from "../gateway/agentAwareness.js";
import { composeAgents } from "../gateway/compose/composeAgents.js";
import { composeBaseline } from "../gateway/compose/composeBaseline.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import type { WsData } from "../gateway/wsTypes.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/wsTypes.js";
import { agentHttpPath } from "../shared/agent-backend.js";
import { processAmbient } from "../shared/ambient.js";
import { codexAgentIdForOperation } from "../shared/codex-agent.js";
import { copilotAgentIdForOperation } from "../shared/copilot-agent.js";
import { SESSION_BASELINE_PATH } from "../shared/session-baseline.js";
import { type CodexCatalogWriter, type CopilotCatalogWriter, SessionStore } from "../shared/session-store.js";

const resolvedTarget = {
	kind: "devcontainer" as const,
	targetId: "container:recipe-app",
	cwd: "/workspace/recipe-app",
};

function setup() {
	const ambient = processAmbient();
	let codexCatalogWriter: CodexCatalogWriter | undefined;
	let copilotCatalogWriter: CopilotCatalogWriter | undefined;
	const sessionStore = new SessionStore({
		ambient,
		codexCatalogPersistence: {
			persistChecked: () => true,
			receiveWriter: (writer) => (codexCatalogWriter = writer),
		},
		copilotCatalogPersistence: {
			persistChecked: () => true,
			receiveWriter: (writer) => (copilotCatalogWriter = writer),
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
	const owner = sessionStore.mint({ spawn: "recipe-app", sessionLabel: "Work" });
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
			codexCatalogWriter: codexCatalogWriter!,
			copilotCatalogWriter: copilotCatalogWriter!,
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

function frameOf(context: ReturnType<typeof setup>, family: "codex" | "copilot", operationId: string) {
	return context.outbound.find((frame) => frame.type === `${family}_command` && frame.operationId === operationId)!;
}

async function accept(
	context: ReturnType<typeof setup>,
	family: "codex" | "copilot",
	operationId: string,
	turnId: string,
) {
	const command = frameOf(context, family, operationId);
	const receipt = {
		type: `${family}_receipt`,
		kind: "accepted",
		requestId: command.requestId,
		ownerKey: context.sessionStore.teamOf(context.owner),
		daemonInstanceId: "daemon-1",
		targetId: "container:recipe-app",
		generation: 1,
		eventId: context.outbound.filter((frame) => frame.type === `${family}_command`).length,
		agentId: command.agentId,
		operationId,
		resolvedTarget,
		...(family === "codex"
			? { threadId: `thread-${command.agentId}` }
			: { sessionId: `session-${command.agentId}` }),
		turnId,
		delivery: operationId.endsWith("000") ? "started" : "steered",
	};
	if (family === "codex") context.agents.codexRelay.handleHostMessage(receipt);
	else context.agents.copilotRelay.handleHostMessage(receipt);
	for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

const ids = {
	codex: {
		start: "123e4567-e89b-42d3-a456-426614174000",
		message: "123e4567-e89b-42d3-a456-426614174001",
		stop: "123e4567-e89b-42d3-a456-426614174002",
		missingCatalog: "123e4567-e89b-42d3-a456-426614174003",
		noHost: "123e4567-e89b-42d3-a456-426614174004",
	},
	copilot: {
		start: "223e4567-e89b-42d3-a456-426614174000",
		message: "223e4567-e89b-42d3-a456-426614174001",
		stop: "223e4567-e89b-42d3-a456-426614174002",
		missingCatalog: "223e4567-e89b-42d3-a456-426614174003",
		noHost: "223e4567-e89b-42d3-a456-426614174004",
	},
};

describe("agent command seams", () => {
	it("dispatches owner-based operations, gates container starts, and hides run agents", async () => {
		const context = setup();
		const { owner, agents } = context;
		for (const family of ["codex", "copilot"] as const) {
			const commands = family === "codex" ? agents.codexCommands : agents.copilotCommands;
			context.setDaemonInstanceId(undefined);
			const unavailable = commands.start(owner, {
				operationId: ids[family].noHost,
				prompt: "start",
			});
			expect(unavailable.kind).toBe("refused");
			expect(
				(family === "codex"
					? context.sessionStore.listCodexAgents(owner)
					: context.sessionStore.listCopilotAgents(owner)
				).length,
			).toBe(0);
			context.setDaemonInstanceId("daemon-1");
			context.setContainerInCatalog(false);
			const missing = commands.start(owner, {
				operationId: ids[family].missingCatalog,
				prompt: "start",
			});
			expect(missing).toMatchObject({ kind: "refused", reason: "container target is not in the host catalog" });
			expect(
				(family === "codex"
					? context.sessionStore.listCodexAgents(owner)
					: context.sessionStore.listCopilotAgents(owner)
				).length,
			).toBe(0);
			context.setContainerInCatalog(true);
		}

		const codexStart = agents.codexCommands.start(owner, {
			operationId: ids.codex.start,
			prompt: "start",
			runId: "run-codex",
		});
		const copilotStart = agents.copilotCommands.start(owner, {
			operationId: ids.copilot.start,
			prompt: "start",
			runId: "run-copilot",
		});
		expect(codexStart).toMatchObject({ kind: "committed", transition: { agent: { runId: "run-codex" } } });
		expect(copilotStart).toMatchObject({ kind: "committed", transition: { agent: { runId: "run-copilot" } } });
		for (const family of ["codex", "copilot"] as const) {
			const operationId = ids[family].start;
			const operation =
				family === "codex"
					? context.sessionStore.listCodexAgents(owner)[0]?.operations[0]
					: context.sessionStore.listCopilotAgents(owner)[0]?.operations[0];
			expect(operation?.daemonInstanceId).toBe("daemon-1");
			await accept(context, family, operationId, `turn-${family}`);
		}
		expect(context.sessionStore.listCodexAgents(owner)[0]?.agentState).toBe("working");
		expect(context.sessionStore.listCopilotAgents(owner)[0]?.agentState).toBe("working");
		expect(agents.codexCommands.retire(owner, codexAgentIdForOperation(ids.codex.start))).toEqual({
			retired: false,
			reason: "active_turn",
		});
		expect(agents.copilotCommands.retire(owner, copilotAgentIdForOperation(ids.copilot.start))).toEqual({
			retired: false,
			reason: "active_turn",
		});

		context.setDaemonInstanceId(undefined);
		const codexBefore = context.sessionStore.listCodexAgents(owner)[0]!.operations.length;
		const copilotBefore = context.sessionStore.listCopilotAgents(owner)[0]!.operations.length;
		expect(
			agents.codexCommands.message(owner, {
				agentId: codexAgentIdForOperation(ids.codex.start),
				operationId: ids.codex.message,
				prompt: "message",
			}).kind,
		).toBe("refused");
		expect(
			agents.codexCommands.stop(owner, {
				agentId: codexAgentIdForOperation(ids.codex.start),
				operationId: ids.codex.stop,
			}).kind,
		).toBe("refused");
		expect(
			agents.copilotCommands.message(owner, {
				agentId: copilotAgentIdForOperation(ids.copilot.start),
				operationId: ids.copilot.message,
				prompt: "message",
			}).kind,
		).toBe("refused");
		expect(
			agents.copilotCommands.stop(owner, {
				agentId: copilotAgentIdForOperation(ids.copilot.start),
				operationId: ids.copilot.stop,
			}).kind,
		).toBe("refused");
		expect(context.sessionStore.listCodexAgents(owner)[0]?.operations).toHaveLength(codexBefore);
		expect(context.sessionStore.listCopilotAgents(owner)[0]?.operations).toHaveLength(copilotBefore);
		context.setDaemonInstanceId("daemon-1");

		const codexMessage = agents.codexCommands.message(owner, {
			agentId: codexAgentIdForOperation(ids.codex.start),
			operationId: ids.codex.message,
			prompt: "message",
		});
		const copilotMessage = agents.copilotCommands.message(owner, {
			agentId: copilotAgentIdForOperation(ids.copilot.start),
			operationId: ids.copilot.message,
			prompt: "message",
		});
		expect(codexMessage).toMatchObject({
			kind: "committed",
			transition: { operation: { daemonInstanceId: "daemon-1" } },
		});
		expect(copilotMessage).toMatchObject({
			kind: "committed",
			transition: { operation: { daemonInstanceId: "daemon-1" } },
		});
		await accept(context, "codex", ids.codex.message, "turn-codex");
		await accept(context, "copilot", ids.copilot.message, "turn-copilot");
		const codexStop = agents.codexCommands.stop(owner, {
			agentId: codexAgentIdForOperation(ids.codex.start),
			operationId: ids.codex.stop,
		});
		const copilotStop = agents.copilotCommands.stop(owner, {
			agentId: copilotAgentIdForOperation(ids.copilot.start),
			operationId: ids.copilot.stop,
		});
		expect(codexStop).toMatchObject({
			kind: "committed",
			transition: { operation: { daemonInstanceId: "daemon-1" } },
		});
		expect(copilotStop).toMatchObject({
			kind: "committed",
			transition: { operation: { daemonInstanceId: "daemon-1" } },
		});

		const codexRequest = new Request("http://gateway/codex", { headers: { "x-session-token": context.token } });
		const copilotRequest = new Request("http://gateway/copilot", {
			headers: { "x-session-token": context.token },
		});
		const codexRoute = agents.agentRoutes.get(agentHttpPath("codex"))!;
		const copilotRoute = agents.agentRoutes.get(agentHttpPath("copilot"))!;
		for (const [route, request, family, agentId] of [
			[codexRoute, codexRequest, "codex", codexAgentIdForOperation(ids.codex.start)],
			[copilotRoute, copilotRequest, "copilot", copilotAgentIdForOperation(ids.copilot.start)],
		] as const) {
			const message = await route(request, {
				kind: "message",
				operationId: ids[family].noHost,
				agentId,
				prompt: "x",
			});
			const stop = await route(request, { kind: "stop", operationId: ids[family].missingCatalog, agentId });
			expect(message.status).toBe(400);
			expect(stop.status).toBe(400);
			expect(JSON.stringify(await message.json())).toContain("workflowStop");
			expect(JSON.stringify(await stop.json())).toContain("workflowStop");
		}

		expect(agents.agentRoster()).toEqual([]);
		const observations: unknown[] = [];
		createAgentWatch({
			roster: agents.agentRoster,
			observe: (rows) => observations.push(...rows),
			now: () => 10,
		}).tick();
		expect(observations).toEqual([]);
		const codexList = await codexRoute(codexRequest, { kind: "list" });
		const copilotList = await copilotRoute(copilotRequest, { kind: "list" });
		expect(await codexList.json()).toMatchObject({ agents: [] });
		expect(await copilotList.json()).toMatchObject({ agents: [] });
		const baselineRequest = await context.baseline.routes.get(SESSION_BASELINE_PATH)!(codexRequest, {});
		expect(await baselineRequest.json()).toMatchObject({ agents: [] });
	});
});
