import type { AgentBackendId } from "../../shared/agent-backend.js";
import type { Ambient } from "../../shared/ambient.js";
import type { SessionRecord } from "../../shared/session-store.js";
import type { AgentStacks } from "../agentStack.js";
import type { AgentView } from "./agentViews.js";
import { agentView } from "./agentViews.js";

interface AgentFamilyDeps {
	ambient: Pick<Ambient, "now">;
	stacks: AgentStacks;
}

export interface AgentFamilies {
	snapshot(
		owner: SessionRecord,
		backend: AgentBackendId,
		agentId: string,
		operationId?: string,
	): AgentView | undefined;
	listRunAgents(owner: SessionRecord, runId: string): AgentView[];
	listAgent(owner: SessionRecord, backend: AgentBackendId, agentId: string): AgentView | undefined;
	retire(owner: SessionRecord, backend: AgentBackendId, agentId: string): boolean;
	abandon(owner: SessionRecord, backend: AgentBackendId, agentId: string, operationId: string): void;
	familyOfAgent(owner: SessionRecord, agentId: string): AgentBackendId | undefined;
}

export function createAgentFamilies(deps: AgentFamilyDeps): AgentFamilies {
	const stacks = [...deps.stacks.values()];
	return {
		snapshot(owner, backend, agentId, operationId) {
			const seen = deps.stacks.get(backend)?.observe(owner, agentId, operationId);
			return seen && agentView(seen.agent, seen.refusal, operationId);
		},
		listRunAgents(owner, runId) {
			return stacks.flatMap((stack) =>
				stack
					.list(owner)
					.filter((agent) => agent.runId === runId)
					.flatMap((agent) => agentView(agent) ?? []),
			);
		},
		listAgent(owner, backend, agentId) {
			return agentView(
				deps.stacks
					.get(backend)
					?.list(owner)
					.find((agent) => agent.agentId === agentId),
			);
		},
		retire(owner, backend, agentId) {
			return deps.stacks.get(backend)?.retire(owner, agentId).retired ?? false;
		},
		abandon(owner, backend, agentId, operationId) {
			deps.stacks.get(backend)?.abandon(owner, agentId, operationId, deps.ambient.now());
		},
		familyOfAgent(owner, agentId) {
			return stacks.find((stack) => stack.list(owner).some((agent) => agent.agentId === agentId))?.backend.id;
		},
	};
}
