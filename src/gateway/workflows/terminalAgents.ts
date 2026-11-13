import type { AgentBackendId } from "../../shared/agent-backend.js";
import type { Ambient } from "../../shared/ambient.js";
import type { SessionRecord, SessionStore } from "../../shared/session-store.js";
import type { AgentStacks } from "../agentStack.js";
import type { HostLivenessReader } from "../hostLiveness.js";
import type { AgentView } from "./agentViews.js";
import type { StackAgents } from "./stackAgents.js";

interface TerminalAgentDeps {
	ambient: Pick<Ambient, "newId">;
	readLiveness: HostLivenessReader;
	sessionStore: Pick<SessionStore, "teamOf">;
	stacks: AgentStacks;
}

export function createTerminalAgents(
	deps: TerminalAgentDeps,
	stackAgents: StackAgents,
	ownerOf: (team: string) => SessionRecord | undefined,
) {
	const { listRunAgents, listAgent, retire, abandon, backendOfAgent } = stackAgents;
	const stopSent = new WeakMap<object, Set<string>>();
	const idleListeners = new Map<string, () => void>();

	function stopAgent(owner: SessionRecord, backend: AgentBackendId, agent: AgentView): boolean {
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
			const result = deps.stacks.get(backend)?.stop(owner, { agentId: agent.agentId, operationId });
			if (result?.kind === "committed") {
				return result.dispatched;
			}
		} catch {}
		return false;
	}
	function watchIdle(
		owner: SessionRecord,
		backend: AgentBackendId,
		agentId: string,
		afterIdle: (agent: AgentView | undefined) => void,
	): void {
		const ownerKey = deps.sessionStore.teamOf(owner);
		const key = `${ownerKey}:${backend}:${agentId}`;
		const relay = deps.stacks.get(backend)?.relay;
		if (!relay || idleListeners.has(key)) return;
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
	/** Stops a current or arriving turn and retains the agent. */
	function quiet(owner: SessionRecord, agent: AgentView): void {
		const backend = backendOfAgent(owner, agent.agentId);
		if (!backend || agent.state === "idle" || agent.state === "unavailable") return;
		if (agent.state === "working") stopAgent(owner, backend, agent);
		watchIdle(owner, backend, agent.agentId, (current) => {
			if (current?.state === "working") stopAgent(owner, backend, current);
		});
	}
	/** An agent a resumed run took is that run's. */
	function ensureTerminalAgent(
		owner: SessionRecord,
		run: { runId: string; team: string },
		agent: AgentView,
	): boolean {
		const backend = backendOfAgent(owner, agent.agentId);
		if (!backend) return true;
		if (agent.state === "working" || agent.turns.some((turn) => turn.state === "inProgress")) {
			stopAgent(owner, backend, agent);
			const current = listAgent(owner, backend, agent.agentId);
			if (current && (current.state === "idle" || current.state === "unavailable")) {
				return retire(owner, backend, agent.agentId);
			}
			watchIdle(owner, backend, agent.agentId, (current) => {
				if (current && current.runId !== run.runId) return;
				if (!current || current.state === "idle" || current.state === "unavailable") {
					retire(owner, backend, agent.agentId);
					return;
				}
				if (current.state === "working") stopAgent(owner, backend, current);
			});
			return false;
		}
		if (agent.state === "idle" || agent.state === "unavailable") return retire(owner, backend, agent.agentId);
		watchIdle(owner, backend, agent.agentId, (current) => {
			if (current && current.runId !== run.runId) return;
			if (!current || current.state === "idle" || current.state === "unavailable")
				retire(owner, backend, agent.agentId);
			else ensureTerminalAgent(owner, run, current);
		});
		return false;
	}

	function retireRun(run: { runId: string; team: string }): boolean {
		const owner = ownerOf(run.team);
		if (!owner) return true;
		let complete = true;
		const liveDaemon = deps.readLiveness().daemonInstanceId;
		for (const agent of listRunAgents(owner, run.runId)) {
			const backend = backendOfAgent(owner, agent.agentId);
			if (!backend) continue;
			for (const operation of agent.operations) {
				// A live daemon may still open the requested thread.
				if (operation.state === "requested" && operation.daemonInstanceId !== liveDaemon)
					abandon(owner, backend, agent.agentId, operation.operationId);
			}
			const current = listAgent(owner, backend, agent.agentId);
			if (current && !ensureTerminalAgent(owner, run, current)) complete = false;
		}
		return complete;
	}
	function clearIdleListeners(): void {
		for (const unsubscribe of idleListeners.values()) unsubscribe();
		idleListeners.clear();
	}

	return { stopAgent, watchIdle, quiet, ensureTerminalAgent, retireRun, clearIdleListeners };
}
