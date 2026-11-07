import type { Ambient } from "../../shared/ambient.js";
import type { SessionRecord, SessionStore } from "../../shared/session-store.js";
import type { CodexAgentCommands } from "../codexAgentCommands.js";
import type { CodexRelay } from "../codexRelay.js";
import type { CopilotAgentCommands } from "../copilotAgentCommands.js";
import type { CopilotRelay } from "../copilotRelay.js";
import type { HostLivenessReader } from "../hostLiveness.js";
import type { AgentFamilies } from "./agentFamilies.js";
import type { AgentView } from "./agentViews.js";

interface TerminalAgentDeps {
	ambient: Pick<Ambient, "newId">;
	readLiveness: HostLivenessReader;
	sessionStore: Pick<SessionStore, "teamOf">;
	codex: Pick<CodexAgentCommands, "stop">;
	copilot: Pick<CopilotAgentCommands, "stop">;
	codexRelay: CodexRelay;
	copilotRelay: CopilotRelay;
}

export function createTerminalAgents(
	deps: TerminalAgentDeps,
	families: AgentFamilies,
	ownerOf: (team: string) => SessionRecord | undefined,
) {
	const { listRunAgents, listAgent, retire, abandon, familyOfAgent } = families;
	const stopSent = new WeakMap<object, Set<string>>();
	const idleListeners = new Map<string, () => void>();

	function stopAgent(owner: SessionRecord, backend: "codex" | "copilot", agent: AgentView): boolean {
		const live = deps.readLiveness();
		if (!live.socket || !live.daemonInstanceId) return false;
		let sentForSocket = stopSent.get(live.socket);
		if (!sentForSocket) {
			sentForSocket = new Set();
			stopSent.set(live.socket, sentForSocket);
		}
		if (sentForSocket.has(agent.agentId)) return true;
		if (agent.operations.some((operation) => operation.kind === "stop" && operation.state === "requested")) {
			sentForSocket.add(agent.agentId);
			return true;
		}
		const operationId = deps.ambient.newId();
		sentForSocket.add(agent.agentId);
		try {
			const result =
				backend === "codex"
					? deps.codex.stop(owner, { agentId: agent.agentId, operationId })
					: deps.copilot.stop(owner, { agentId: agent.agentId, operationId });
			if (result.kind === "committed") {
				return result.dispatched;
			}
		} catch {}
		return false;
	}
	function watchIdle(
		owner: SessionRecord,
		backend: "codex" | "copilot",
		agentId: string,
		afterIdle: (agent: AgentView | undefined) => void,
	): void {
		const ownerKey = deps.sessionStore.teamOf(owner);
		const key = `${ownerKey}:${backend}:${agentId}`;
		if (idleListeners.has(key)) return;
		const relay = backend === "codex" ? deps.codexRelay : deps.copilotRelay;
		const unsubscribe = relay.onAgentChange(ownerKey, agentId, () => {
			const agent = listAgent(owner, backend, agentId);
			if (agent && agent.state !== "idle" && agent.state !== "unavailable") {
				afterIdle(agent);
				return;
			}
			unsubscribe();
			idleListeners.delete(key);
			afterIdle(agent);
		});
		idleListeners.set(key, unsubscribe);
	}
	function ensureTerminalAgent(
		owner: SessionRecord,
		run: { runId: string; team: string },
		agent: AgentView,
	): boolean {
		const family = familyOfAgent(owner, agent.agentId);
		if (!family) return true;
		if (agent.state === "working" || agent.turns.some((turn) => turn.state === "inProgress")) {
			stopAgent(owner, family, agent);
			const current = listAgent(owner, family, agent.agentId);
			if (current && (current.state === "idle" || current.state === "unavailable")) {
				return retire(owner, family, agent.agentId);
			}
			watchIdle(owner, family, agent.agentId, (current) => {
				if (!current || current.state === "idle" || current.state === "unavailable") {
					retire(owner, family, agent.agentId);
					return;
				}
				if (current.state === "working") stopAgent(owner, family, current);
			});
			return false;
		}
		if (agent.state === "idle" || agent.state === "unavailable") return retire(owner, family, agent.agentId);
		watchIdle(owner, family, agent.agentId, (current) => {
			if (!current || current.state === "idle" || current.state === "unavailable")
				retire(owner, family, agent.agentId);
			else ensureTerminalAgent(owner, run, current);
		});
		return false;
	}

	function retireRun(run: { runId: string; team: string }): boolean {
		const owner = ownerOf(run.team);
		if (!owner) return true;
		let complete = true;
		for (const agent of listRunAgents(owner, run.runId)) {
			const family = familyOfAgent(owner, agent.agentId);
			if (!family) continue;
			for (const operation of agent.operations) {
				if (operation.state === "requested") abandon(owner, family, agent.agentId, operation.operationId);
			}
			const current = listAgent(owner, family, agent.agentId);
			if (current && !ensureTerminalAgent(owner, run, current)) complete = false;
		}
		return complete;
	}
	function clearIdleListeners(): void {
		for (const unsubscribe of idleListeners.values()) unsubscribe();
		idleListeners.clear();
	}

	return { stopAgent, watchIdle, ensureTerminalAgent, retireRun, clearIdleListeners };
}
