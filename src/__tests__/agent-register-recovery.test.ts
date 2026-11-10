import { expect, it } from "vitest";
import { CodexAgentService } from "../gateway/codexAgentService.js";
import { CodexRelay } from "../gateway/codexRelay.js";
import { CopilotAgentService } from "../gateway/copilotAgentService.js";
import { CopilotRelay } from "../gateway/copilotRelay.js";
import { createSessionAuthority } from "../gateway/sessionAuthority.js";
import { resolveLiveIncarnation, type TeamRegistry } from "../gateway/wsTypes.js";
import { processAmbient } from "../shared/ambient.js";
import { codexAgentIdForOperation } from "../shared/codex-agent.js";
import { copilotAgentIdForOperation } from "../shared/copilot-agent.js";
import { type CodexCatalogWriter, type CopilotCatalogWriter, SessionStore } from "../shared/session-store.js";

const oldDaemon = "daemon-old";
const newDaemon = "daemon-new";
const codexOps = [
	"123e4567-e89b-42d3-a456-426614174000",
	"123e4567-e89b-42d3-a456-426614174001",
	"123e4567-e89b-42d3-a456-426614174002",
	"123e4567-e89b-42d3-a456-426614174003",
	"123e4567-e89b-42d3-a456-426614174004",
];
const copilotOps = [
	"223e4567-e89b-42d3-a456-426614174000",
	"223e4567-e89b-42d3-a456-426614174001",
	"223e4567-e89b-42d3-a456-426614174002",
	"223e4567-e89b-42d3-a456-426614174003",
	"223e4567-e89b-42d3-a456-426614174004",
];
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

it("abandons stale requested starts, messages, and stops before hello in both families", async () => {
	let codexCatalogWriter: CodexCatalogWriter | undefined;
	let copilotCatalogWriter: CopilotCatalogWriter | undefined;
	const store = new SessionStore({
		ambient: processAmbient(),
		codexCatalogPersistence: {
			persistChecked: () => true,
			receiveWriter: (writer) => {
				codexCatalogWriter = writer;
			},
		},
		copilotCatalogPersistence: {
			persistChecked: () => true,
			receiveWriter: (writer) => {
				copilotCatalogWriter = writer;
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
	const codex = new CodexAgentService({
		auth,
		sessionStore: store,
		offlineCatalog: new Map([["recipe-app", "/trusted/recipe-app"]]),
		catalogWriter: codexCatalogWriter!,
	});
	const copilot = new CopilotAgentService({
		auth,
		sessionStore: store,
		offlineCatalog: new Map([["recipe-app", "/trusted/recipe-app"]]),
		catalogWriter: copilotCatalogWriter!,
	});
	let liveDaemonInstanceId: string | undefined = oldDaemon;
	const codexRelay = new CodexRelay({
		service: codex,
		sessionStore: store,
		liveDaemonInstanceId: () => liveDaemonInstanceId,
		ambient: processAmbient(),
		sendToHost: () => true,
	});
	const copilotRelay = new CopilotRelay({
		service: copilot,
		sessionStore: store,
		liveDaemonInstanceId: () => liveDaemonInstanceId,
		ambient: processAmbient(),
		sendToHost: () => true,
	});
	const ownerKey = store.teamOf(owner);
	const at = 1_000;
	const codexStartIds = [codexOps[0]!, codexOps[1]!, codexOps[3]!];
	const copilotStartIds = [copilotOps[0]!, copilotOps[1]!, copilotOps[3]!];
	const codexAgents = codexStartIds.map(codexAgentIdForOperation);
	const copilotAgents = copilotStartIds.map(copilotAgentIdForOperation);
	const codexChanges = codexAgents.map(() => 0);
	const copilotChanges = copilotAgents.map(() => 0);
	for (const [index, agentId] of codexAgents.entries()) {
		codexRelay.onAgentChange(ownerKey, agentId, () => {
			codexChanges[index]! += 1;
		});
	}
	for (const [index, agentId] of copilotAgents.entries()) {
		copilotRelay.onAgentChange(ownerKey, agentId, () => {
			copilotChanges[index]! += 1;
		});
	}

	for (const operationId of codexStartIds) {
		codex.beginStart(owner, {
			agentId: codexAgentIdForOperation(operationId),
			operationId,
			daemonInstanceId: oldDaemon,
			prompt: "start",
			target: executionTarget,
			at,
		});
	}
	for (const operationId of copilotStartIds) {
		copilot.beginStart(owner, {
			agentId: copilotAgentIdForOperation(operationId),
			operationId,
			daemonInstanceId: oldDaemon,
			prompt: "start",
			target: executionTarget,
			at,
		});
	}

	for (const [index, operationId] of [codexOps[1]!, codexOps[3]!].entries()) {
		const agentId = codexAgentIdForOperation(operationId);
		codex.applyReceipt(
			{
				type: "codex_receipt",
				kind: "accepted",
				requestId: operationId,
				ownerKey,
				daemonInstanceId: oldDaemon,
				targetId: resolvedTarget.targetId,
				generation: 1,
				eventId: index,
				agentId,
				operationId,
				resolvedTarget,
				threadId: `thread-${index}`,
				turnId: `turn-${index}`,
				delivery: "started",
			},
			at,
		);
	}
	for (const [index, operationId] of [copilotOps[1]!, copilotOps[3]!].entries()) {
		const agentId = copilotAgentIdForOperation(operationId);
		copilot.applyReceipt(
			{
				type: "copilot_receipt",
				kind: "accepted",
				requestId: operationId,
				ownerKey,
				daemonInstanceId: oldDaemon,
				targetId: resolvedTarget.targetId,
				generation: 1,
				eventId: index,
				agentId,
				operationId,
				resolvedTarget,
				sessionId: `session-${index}`,
				turnId: `turn-${index}`,
				delivery: "started",
			},
			at,
		);
	}

	codex.beginMessage(owner, {
		agentId: codexAgents[1]!,
		operationId: codexOps[2]!,
		daemonInstanceId: oldDaemon,
		prompt: "message",
		at: at + 1,
	});
	codex.beginStop(owner, {
		agentId: codexAgents[2]!,
		operationId: codexOps[4]!,
		daemonInstanceId: oldDaemon,
		at: at + 1,
	});
	copilot.beginMessage(owner, {
		agentId: copilotAgents[1]!,
		operationId: copilotOps[2]!,
		daemonInstanceId: oldDaemon,
		prompt: "message",
		at: at + 1,
	});
	copilot.beginStop(owner, {
		agentId: copilotAgents[2]!,
		operationId: copilotOps[4]!,
		daemonInstanceId: oldDaemon,
		at: at + 1,
	});

	liveDaemonInstanceId = newDaemon;
	codexRelay.onHostRegister();
	copilotRelay.onHostRegister();
	await settle();

	const codexRows = codex.listOwnedAgents(owner);
	const copilotRows = copilot.listOwnedAgents(owner);
	expect(codexRows.find((agent) => agent.agentId === codexAgents[0])).toMatchObject({
		agentState: "unavailable",
		operations: [{ state: "indeterminate" }],
	});
	expect(codexRows.find((agent) => agent.agentId === codexAgents[1])).toMatchObject({
		agentState: "recovering",
		operations: [{ state: "accepted" }, { state: "indeterminate" }],
	});
	expect(codexRows.find((agent) => agent.agentId === codexAgents[2])).toMatchObject({
		pendingInterrupt: undefined,
		operations: [{ state: "accepted" }, { state: "indeterminate" }],
	});
	expect(copilotRows.find((agent) => agent.agentId === copilotAgents[0])).toMatchObject({
		agentState: "unavailable",
		operations: [{ state: "indeterminate" }],
	});
	expect(copilotRows.find((agent) => agent.agentId === copilotAgents[1])).toMatchObject({
		agentState: "recovering",
		operations: [{ state: "accepted" }, { state: "indeterminate" }],
	});
	expect(copilotRows.find((agent) => agent.agentId === copilotAgents[2])).toMatchObject({
		operations: [{ state: "accepted" }, { state: "indeterminate" }],
	});
	expect(codexChanges).toEqual([1, 1, 1]);
	expect(copilotChanges).toEqual([1, 1, 1]);
});
