// The Codex and Copilot catalogs, their host relays, and their HTTP routes.

import { agentHttpPath } from "../../shared/agent-backend.js";
import { type AgentProgressCounts, addAgentProgressCounts } from "../../shared/agent-counter.js";
import type { Ambient } from "../../shared/ambient.js";
import type { RosterAgent } from "../agentAwareness.js";
import { type CodexAgentCommands, createCodexAgentCommands } from "../codexAgentCommands.js";
import { CodexAgentService } from "../codexAgentService.js";
import { CodexRelay } from "../codexRelay.js";
import { CodexRoute } from "../codexRoute.js";
import { type CopilotAgentCommands, createCopilotAgentCommands } from "../copilotAgentCommands.js";
import { CopilotAgentService } from "../copilotAgentService.js";
import { CopilotRelay } from "../copilotRelay.js";
import { CopilotRoute } from "../copilotRoute.js";
import { reached, sendOn } from "../wsSend.js";
import type { HostStage } from "./composeHost.js";
import type { SessionsStage } from "./composeSessions.js";

export interface AgentsStageDeps {
	sessions: Pick<
		SessionsStage,
		"sessionAuthority" | "sessionStore" | "offlineCatalog" | "codexCatalogWriter" | "copilotCatalogWriter"
	>;
	host: Pick<HostStage, "readLiveness">;
	ambient: Ambient;
}

export interface AgentsStage {
	codexRelay: CodexRelay;
	copilotRelay: CopilotRelay;
	codexCommands: CodexAgentCommands;
	copilotCommands: CopilotAgentCommands;
	agentRoutes: Map<string, (req: Request, body: unknown) => Promise<Response>>;
	reconcileStaleAgents: () => void;
	/** Every agent of both families with its turns, for the awareness watch. */
	agentRoster: () => RosterAgent[];
	workflowProgress: (runId: string) => AgentProgressCounts;
}

function commentaryOf(activities: readonly { kind: string; text?: string }[]): string[] {
	return activities.flatMap((activity) =>
		activity.kind === "commentary" && activity.text !== undefined ? [activity.text] : [],
	);
}

export function composeAgents({ sessions, host, ambient }: AgentsStageDeps): AgentsStage {
	const sendToHost = (message: unknown): boolean => {
		const hostWs = host.readLiveness().socket;
		if (!hostWs) return false;
		return reached(sendOn(hostWs, JSON.stringify(message), "agent daemon command"));
	};

	const codexAgentService = new CodexAgentService({
		auth: sessions.sessionAuthority,
		sessionStore: sessions.sessionStore,
		offlineCatalog: sessions.offlineCatalog,
		catalogWriter: sessions.codexCatalogWriter,
	});
	const copilotAgentService = new CopilotAgentService({
		auth: sessions.sessionAuthority,
		sessionStore: sessions.sessionStore,
		offlineCatalog: sessions.offlineCatalog,
		catalogWriter: sessions.copilotCatalogWriter,
	});

	const codexRelay = new CodexRelay({
		service: codexAgentService,
		sessionStore: sessions.sessionStore,
		liveDaemonInstanceId: () => host.readLiveness().daemonInstanceId,
		sendToHost,
		ambient,
	});
	const copilotRelay = new CopilotRelay({
		service: copilotAgentService,
		sessionStore: sessions.sessionStore,
		liveDaemonInstanceId: () => host.readLiveness().daemonInstanceId,
		sendToHost,
		ambient,
	});
	const codexCommands = createCodexAgentCommands({
		service: codexAgentService,
		relay: codexRelay,
		readLiveness: host.readLiveness,
		ambient,
	});
	const copilotCommands = createCopilotAgentCommands({
		service: copilotAgentService,
		relay: copilotRelay,
		readLiveness: host.readLiveness,
		ambient,
	});
	const codexRoute = new CodexRoute({
		service: codexAgentService,
		relay: codexRelay,
		commands: codexCommands,
		ambient,
	});
	const copilotRoute = new CopilotRoute({
		service: copilotAgentService,
		relay: copilotRelay,
		commands: copilotCommands,
		ambient,
	});

	const agentRoutes = new Map<string, (req: Request, body: unknown) => Promise<Response>>([
		[agentHttpPath("codex"), (req, body) => codexRoute.handle(req, body)],
		[agentHttpPath("copilot"), (req, body) => copilotRoute.handle(req, body)],
	]);

	const agentRoster = (): RosterAgent[] =>
		sessions.sessionStore.list().flatMap((owner) => {
			const ownerKey = sessions.sessionStore.teamOf(owner);
			const families = [
				["codex", codexAgentService.listOwnedAgents(owner)],
				["copilot", copilotAgentService.listOwnedAgents(owner)],
			] as const;
			return families.flatMap(([family, agents]) =>
				agents
					.filter((agent) => agent.runId === undefined)
					.map((agent) => ({
						ownerKey,
						family,
						agentId: agent.agentId,
						agentState: agent.agentState,
						turns: agent.turns.map((turn) => ({
							id: turn.id,
							state: turn.state,
							updatedAt: turn.updatedAt,
							notes: commentaryOf(turn.activities),
							progress:
								family === "codex"
									? codexRelay.progressCounts(ownerKey, agent.agentId, turn.id)
									: copilotRelay.progressCounts(ownerKey, agent.agentId, turn.id),
						})),
					})),
			);
		});

	const workflowProgress = (runId: string): AgentProgressCounts =>
		addAgentProgressCounts(codexRelay.progressForRun(runId), copilotRelay.progressForRun(runId));

	const reconcileStaleAgents = (): void => {
		for (const owner of sessions.sessionStore.list()) {
			codexRelay.reconcileStale(owner);
			copilotRelay.reconcileStale(owner);
		}
	};

	return {
		codexRelay,
		copilotRelay,
		codexCommands,
		copilotCommands,
		agentRoutes,
		agentRoster,
		workflowProgress,
		reconcileStaleAgents,
	};
}
