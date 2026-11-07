import type { Ambient } from "../../shared/ambient.js";
import type { SessionRecord } from "../../shared/session-store.js";
import type { CodexAgentCommands } from "../codexAgentCommands.js";
import type { CopilotAgentCommands } from "../copilotAgentCommands.js";
import type { AgentView } from "./agentViews.js";
import { normalizeCodex, normalizeCopilot } from "./agentViews.js";

interface AgentFamilyDeps {
	ambient: Pick<Ambient, "now">;
	codex: CodexAgentCommands;
	copilot: CopilotAgentCommands;
}

export interface AgentFamilies {
	snapshot(
		owner: SessionRecord,
		backend: "codex" | "copilot",
		agentId: string,
		operationId?: string,
	): AgentView | undefined;
	listRunAgents(owner: SessionRecord, runId: string): AgentView[];
	listAgent(owner: SessionRecord, backend: "codex" | "copilot", agentId: string): AgentView | undefined;
	retire(owner: SessionRecord, backend: "codex" | "copilot", agentId: string): boolean;
	abandon(owner: SessionRecord, backend: "codex" | "copilot", agentId: string, operationId: string): void;
	familyOfAgent(owner: SessionRecord, agentId: string): "codex" | "copilot" | undefined;
}

/** Owns family agent views. */
export function createAgentFamilies(deps: AgentFamilyDeps): AgentFamilies {
	function snapshot(
		owner: SessionRecord,
		backend: "codex" | "copilot",
		agentId: string,
		operationId?: string,
	): AgentView | undefined {
		if (backend === "codex") {
			const result = deps.codex.observe(owner, agentId, operationId);
			return normalizeCodex(result.agent, result.refusalReason, operationId);
		}
		const result = deps.copilot.observe(owner, agentId, operationId);
		return normalizeCopilot(result.agent, result.refusal, operationId);
	}
	function listRunAgents(owner: SessionRecord, runId: string): AgentView[] {
		return [
			...deps.codex
				.list(owner)
				.filter((agent) => agent.runId === runId)
				.flatMap((agent) => {
					const view = normalizeCodex(agent);
					return view ? [view] : [];
				}),
			...deps.copilot
				.list(owner)
				.filter((agent) => agent.runId === runId)
				.flatMap((agent) => {
					const view = normalizeCopilot(agent);
					return view ? [view] : [];
				}),
		];
	}
	function listAgent(owner: SessionRecord, backend: "codex" | "copilot", agentId: string): AgentView | undefined {
		if (backend === "codex")
			return normalizeCodex(deps.codex.list(owner).find((agent) => agent.agentId === agentId));
		return normalizeCopilot(deps.copilot.list(owner).find((agent) => agent.agentId === agentId));
	}
	function retire(owner: SessionRecord, backend: "codex" | "copilot", agentId: string): boolean {
		const result = backend === "codex" ? deps.codex.retire(owner, agentId) : deps.copilot.retire(owner, agentId);
		return result.retired;
	}
	function abandon(owner: SessionRecord, backend: "codex" | "copilot", agentId: string, operationId: string): void {
		if (backend === "codex") deps.codex.abandon(owner, agentId, operationId, deps.ambient.now());
		else deps.copilot.abandon(owner, agentId, operationId, deps.ambient.now());
	}
	function familyOfAgent(owner: SessionRecord, agentId: string): "codex" | "copilot" | undefined {
		if (deps.codex.list(owner).some((agent) => agent.agentId === agentId)) return "codex";
		if (deps.copilot.list(owner).some((agent) => agent.agentId === agentId)) return "copilot";
		return undefined;
	}
	return { snapshot, listRunAgents, listAgent, retire, abandon, familyOfAgent };
}
