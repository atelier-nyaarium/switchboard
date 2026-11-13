import { AGENT_BACKENDS, type AgentBackendId, agentHttpPath } from "../../shared/agent-backend.js";
import { threadExpired } from "../../shared/agent-collect.js";
import {
	type AgentProgressCounts,
	addAgentProgressCounts,
	emptyAgentProgressCounts,
} from "../../shared/agent-counter.js";
import { marksOf } from "../../shared/agent-turn-marks.js";
import type { Ambient } from "../../shared/ambient.js";
import type { RosterAgent } from "../agentAwareness.js";
import { resolveAgentExecutionTarget } from "../agentExecutionTarget.js";
import { type AgentStack, type AgentStacks, createAgentStack } from "../agentStack.js";
import { threadItemOf } from "../sessionEnd.js";
import { createWorkflowAgentDispatch, type WorkflowAgentDispatch } from "../workflows/agentDispatch.js";
import type { WorkflowRunner } from "../workflows/runner.js";
import { reached, sendOn } from "../wsSend.js";
import type { HostStage } from "./composeHost.js";
import type { SessionsStage } from "./composeSessions.js";

export interface AgentsStageDeps {
	sessions: Pick<
		SessionsStage,
		| "sessionAuthority"
		| "sessionStore"
		| "offlineCatalog"
		| "agentCatalogWriters"
		| "purgeQueue"
		| "saveSessionsChecked"
	>;
	host: Pick<HostStage, "readLiveness" | "relayToHost">;
	ambient: Ambient;
}

export type TurnsCollected = (
	ownerKey: string,
	backend: AgentBackendId,
	agentId: string,
	turnIds: readonly string[],
) => void;

export interface AgentsStage {
	stacks: AgentStacks;
	agentRoutes: Map<string, (req: Request, body: unknown) => Promise<Response>>;
	reconcileStaleAgents: () => void;
	agentRoster: () => RosterAgent[];
	workflowProgress: (runId: string) => AgentProgressCounts;
	/** Ends every relay's watch over held frames. */
	stopRelays: () => void;
	/** Expires threads idle for one day. */
	expireThreads: (runRunning: (runId: string) => boolean) => number;
	/** False means marking failed. */
	markTurnNotified: (ownerKey: string, backend: AgentBackendId, agentId: string, turnId: string) => boolean;
	onTurnsCollected: (listener: TurnsCollected) => void;
	createWorkflowDispatch: (runner: WorkflowRunner) => WorkflowAgentDispatch;
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

	let collectedListener: TurnsCollected | undefined;
	const shared = {
		auth: sessions.sessionAuthority,
		sessionStore: sessions.sessionStore,
		offlineCatalog: sessions.offlineCatalog,
		readLiveness: host.readLiveness,
		relayToHost: host.relayToHost,
		sendToHost,
		ambient,
		onCollected: (backend: AgentBackendId, ownerKey: string, agentId: string, turnIds: readonly string[]) =>
			collectedListener?.(ownerKey, backend, agentId, turnIds),
	};
	const built: AgentStack[] = AGENT_BACKENDS.map((backend) => {
		const catalogWriter = sessions.agentCatalogWriters.get(backend.id);
		if (!catalogWriter) throw new Error(`no catalog writer for ${backend.id} agents`);
		return createAgentStack({
			...shared,
			backend,
			catalogWriter,
			threadEnded: (agent) => {
				const item = threadItemOf(backend.id, agent);
				if (!item) return undefined;
				const queued = sessions.purgeQueue.add([item]);
				return () => sessions.purgeQueue.withdraw(queued);
			},
		});
	});
	const stacks: AgentStacks = new Map(built.map((stack) => [stack.backend.id, stack]));

	const agentRoutes = new Map(
		built.map((stack) => [
			agentHttpPath(stack.backend.id),
			(req: Request, body: unknown) => stack.route(req, body),
		]),
	);

	const agentRoster = (): RosterAgent[] =>
		sessions.sessionStore.list().flatMap((owner) => {
			const ownerKey = sessions.sessionStore.teamOf(owner);
			return built.flatMap((stack) =>
				stack
					.list(owner)
					.filter((agent) => agent.runId === undefined)
					.map((agent) => ({
						ownerKey,
						backend: stack.backend.id,
						agentId: agent.agentId,
						agentState: agent.agentState,
						turns: agent.turns.map((turn) => ({
							id: turn.id,
							state: turn.state,
							collected: marksOf(agent).collected.includes(turn.id),
							notified: marksOf(agent).notified.includes(turn.id),
							updatedAt: turn.updatedAt,
							notes: commentaryOf(turn.activities),
							progress: stack.relay.progressCounts(ownerKey, agent.agentId, turn.id),
						})),
					})),
			);
		});

	return {
		stacks,
		agentRoutes,
		agentRoster,
		stopRelays: () => {
			for (const stack of built) stack.relay.stop();
		},
		expireThreads: (runRunning) => {
			const now = ambient.now();
			let ended = 0;
			for (const owner of sessions.sessionStore.list())
				for (const stack of built)
					for (const agent of stack.list(owner))
						if (threadExpired(agent, now, runRunning) && stack.expire(owner, agent.agentId, now))
							ended += 1;
			return ended;
		},
		workflowProgress: (runId) =>
			built.reduce(
				(counts, stack) => addAgentProgressCounts(counts, stack.relay.progressForRun(runId)),
				emptyAgentProgressCounts(),
			),
		markTurnNotified: (ownerKey, backend, agentId, turnId) => {
			const owner = sessions.sessionStore.getByTeam(ownerKey);
			return owner !== undefined && (stacks.get(backend)?.markTurnNotified(owner, agentId, turnId) ?? false);
		},
		onTurnsCollected: (listener) => {
			collectedListener = listener;
		},
		createWorkflowDispatch: (runner) =>
			createWorkflowAgentDispatch({
				sessionStore: sessions.sessionStore,
				ambient,
				runner,
				readLiveness: host.readLiveness,
				relayToHost: host.relayToHost,
				stacks,
				resolveTarget: (owner) =>
					resolveAgentExecutionTarget(owner, undefined, sessions.sessionStore, sessions.offlineCatalog),
				purges: {
					add: (items) => sessions.purgeQueue.add(items),
					saved: () => sessions.saveSessionsChecked(),
					found: (count, what) => sessions.purgeQueue.found(count, what),
				},
			}),
		reconcileStaleAgents: () => {
			for (const owner of sessions.sessionStore.list())
				for (const stack of built) stack.relay.reconcileStale(owner);
		},
	};
}
