import type { AgentBackendDescriptor } from "../shared/agent-backend.js";
import { agentListAnswer, agentListRow, collectAnswer } from "../shared/agent-collect.js";
import { agentErrorText } from "../shared/agent-identity.js";
import { type AgentStoredTurn, interruptingOperation, type PersistedAgent } from "../shared/agent-persisted.js";
import { agentIdForOperation, publishedActivities } from "../shared/agent-record.js";
import {
	type AgentErrorCode,
	type AgentGatewayRequest,
	AgentGatewayRequestSchema,
	AgentRequestErrorSchema,
	type AgentResult,
	AgentResultSchema,
	agentRequestIssue,
	agentResultDelivery,
} from "../shared/agent-state.js";
import type { Clock } from "../shared/ambient.js";
import type { SessionRecord } from "../shared/session-store.js";
import type { AgentCommands } from "./agentCommands.js";
import type { AgentRelay } from "./agentRelay.js";
import { AGENT_FAILURE_ANSWERS, AgentTransitionError, jsonResponse as json } from "./agentRouteEnvelope.js";
import type { AgentService } from "./agentService.js";
import { presentedByRequest } from "./sessionAuthority.js";

////////////////////////////////
//  Interfaces & Types

export interface AgentRouteDeps {
	backend: AgentBackendDescriptor;
	service: AgentService;
	relay: AgentRelay;
	commands: AgentCommands;
	ambient: Clock;
	waitBudgetMs?: number;
	onCollected?: (ownerKey: string, agentId: string, turnIds: readonly string[]) => void;
}

type Asked<Kind extends AgentGatewayRequest["kind"]> = Extract<AgentGatewayRequest, { kind: Kind }>;

////////////////////////////////
//  Class

export class AgentRoute {
	private readonly name: string;

	constructor(private readonly deps: AgentRouteDeps) {
		this.name = deps.backend.displayName;
	}

	async handle(req: Request, body: unknown): Promise<Response> {
		const parsed = AgentGatewayRequestSchema.safeParse(body);
		if (!parsed.success) return this.refused(`invalid ${this.name} request`);
		const issue = agentRequestIssue(this.deps.backend, parsed.data);
		if (issue) return this.refused(issue);

		const owner = this.deps.service.resolveOwner(req);
		if (!owner) {
			if (!presentedByRequest(req).token) {
				return json(
					{
						error: `this session is not bound to the gateway (launch it from the console, or install the ${this.deps.backend.binaryName} CLI for a local agent)`,
					},
					401,
				);
			}
			// Unknown tokens return 404.
			return json({ error: "not found" }, 404);
		}

		const request = parsed.data;
		try {
			switch (request.kind) {
				case "start":
					return json(await this.start(owner, request));
				case "message":
					return json(await this.message(owner, request));
				case "await":
					return json(this.collect(req, owner, request.agentId, request.operationId));
				case "stop":
					return json(this.stop(owner, request));
				case "list":
					return json(this.list(owner, request));
			}
		} catch (error) {
			if (!(error instanceof AgentTransitionError)) throw error;
			const answer = AGENT_FAILURE_ANSWERS[error.code];
			if (answer.kind === "request") return this.refused(agentErrorText(error.message));
			const agentId =
				"agentId" in request
					? request.agentId
					: request.kind === "start"
						? agentIdForOperation(this.deps.backend.id, request.operationId)
						: undefined;
			if (!agentId) throw error;
			return json(this.unavailable(agentId, answer.code, answer.retryable, error.message));
		}
	}

	private async start(owner: SessionRecord, request: Asked<"start">): Promise<AgentResult> {
		const result = this.deps.commands.start(owner, request);
		if (result.kind === "refused") return this.unavailable(result.agentId, result.code, true, result.reason);
		return this.settle(owner, result.transition.agent.agentId, request.operationId, result.dispatched);
	}

	private async message(owner: SessionRecord, request: Asked<"message">): Promise<AgentResult> {
		this.refuseRunAgent(owner, request.agentId);
		const result = this.deps.commands.message(owner, request);
		if (result.kind === "refused")
			return this.unavailable(request.agentId, result.code, result.code !== "not_found", result.reason);
		return this.settle(owner, request.agentId, request.operationId, result.dispatched);
	}

	private stop(owner: SessionRecord, request: Asked<"stop">): AgentResult {
		this.refuseRunAgent(owner, request.agentId);
		const result = this.deps.commands.stop(owner, request);
		if (result.kind === "refused")
			return this.unavailable(request.agentId, result.code, result.code !== "not_found", result.reason);
		const agent = this.current(owner, request.agentId) ?? result.transition.agent;
		return this.describe(agent, agent.activeTurnId);
	}

	private collect(req: Request, owner: SessionRecord, agentId: string, operationId: string | undefined): unknown {
		const owned = this.deps.service.resolveOwnedAgent(req, agentId);
		if (!owned || owned.agent.runId) return this.notFound(agentId);
		if (!owned.agent.activeTurnId) this.deps.relay.reconcileStale(owner);
		const collected = this.deps.service.collect(owner, agentId, operationId);
		if (!collected) return this.notFound(agentId);
		this.deps.onCollected?.(this.deps.service.ownerKeyOf(owner), agentId, collected.turnIds);
		const { agent } = collected;
		const trouble = this.trouble(agent);
		return {
			...collectAnswer(agent, collected.turnIds, (turn) => this.turnView(agent, turn)),
			...(trouble ? { error: trouble } : {}),
		};
	}

	private list(owner: SessionRecord, request: Asked<"list">): unknown {
		this.deps.relay.reconcileStale(owner);
		return agentListAnswer(this.deps.service.listOwnedAgents(owner), request, (agent) =>
			agentListRow(agent, this.deps.backend.id, {
				model: agent.operations.find((operation) => operation.kind === "start")?.model,
				latestPrompt: agent.operations.findLast((operation) => operation.prompt !== undefined)?.prompt,
			}),
		);
	}

	/** Waits for acceptance only. */
	private async settle(
		owner: SessionRecord,
		agentId: string,
		operationId: string,
		dispatched: boolean,
	): Promise<AgentResult> {
		const operationOf = (agent: PersistedAgent | undefined) =>
			agent?.operations.find((candidate) => candidate.operationId === operationId);
		const deadline = this.now() + (dispatched ? (this.deps.waitBudgetMs ?? this.deps.backend.waitBudgetMs) : 0);
		await this.deps.relay.waitFor(
			this.deps.service.ownerKeyOf(owner),
			agentId,
			() => operationOf(this.current(owner, agentId))?.state !== "requested",
			deadline,
		);
		const agent = this.current(owner, agentId);
		if (!agent) return this.notFound(agentId);
		const operation = operationOf(agent);
		if (operation?.state === "accepted" && operation.turnId) return this.describe(agent, operation.turnId, true);

		// Acceptance arrives by notice.
		if (agent.agentState === "creating" && dispatched) {
			return AgentResultSchema.parse({
				agentId,
				agentState: "creating",
				observation: "waitTimedOut",
				activities: [],
			});
		}
		const settled =
			operation?.state === "requested"
				? (this.deps.commands.abandon(owner, agentId, operationId, this.now()) ?? agent)
				: agent;
		const refusal = this.deps.commands.observe(owner, agentId, operationId).refusal;
		if (!dispatched)
			return this.unavailable(
				agentId,
				"daemon_unavailable",
				true,
				`the host daemon is not connected, so ${this.name} never received this`,
			);
		if (refusal?.code) return this.unavailable(agentId, refusal.code, true, refusal.message);
		// Unconfirmed delivery stays indeterminate.
		return AgentResultSchema.parse({
			agentId,
			agentState: settled.agentState === "unavailable" ? "unavailable" : "recovering",
			observation: "indeterminate",
			activities: [],
			error: {
				code: "indeterminate",
				retryable: true,
				message: refusal?.message ?? `${this.name} delivery was not confirmed within the wait budget`,
			},
		});
	}

	/** Acceptance precedes completion. */
	private describe(agent: PersistedAgent, turnId: string | undefined, accepted = false): AgentResult {
		const trouble = this.trouble(agent);
		// Trouble hides settled turns.
		if (trouble) {
			return AgentResultSchema.parse({
				agentId: agent.agentId,
				agentState: agent.agentState,
				observation: "unavailable",
				activities: [],
				error: trouble,
			});
		}
		const turn = turnId ? agent.turns.find((candidate) => candidate.id === turnId) : undefined;
		if (!turn) {
			return AgentResultSchema.parse({
				agentId: agent.agentId,
				agentState: agent.agentState === "working" ? "idle" : agent.agentState,
				observation: agent.agentState === "creating" ? "waitTimedOut" : "idle",
				activities: [],
			});
		}
		const activities = publishedActivities(turn.activities);
		const delivery = this.deliveryOf(agent, turn);
		if (turn.state === "inProgress") {
			const interrupting = interruptingOperation(agent) !== undefined;
			return AgentResultSchema.parse({
				agentId: agent.agentId,
				agentState: "working",
				observation: interrupting ? "interruptRequested" : accepted && delivery ? "accepted" : "waitTimedOut",
				turn: { id: turn.id, state: turn.state },
				...(interrupting || !delivery ? {} : { delivery }),
				activities,
			});
		}
		return AgentResultSchema.parse({
			agentId: agent.agentId,
			agentState: "idle",
			observation: "terminal",
			turn: {
				id: turn.id,
				state: turn.state,
				...(turn.state === "interrupted" && turn.reason !== undefined ? { reason: turn.reason } : {}),
			},
			...(delivery ? { delivery } : {}),
			activities,
			...(turn.state === "completed" ? { finalResponse: turn.finalResponse } : {}),
			...(turn.state === "failed"
				? { error: { code: "turn_failed", message: turn.error, retryable: false } }
				: {}),
		});
	}

	private turnView(agent: PersistedAgent, turn: AgentStoredTurn) {
		const delivery = this.deliveryOf(agent, turn);
		return {
			id: turn.id,
			state: turn.state === "inProgress" ? "lost" : turn.state,
			...(turn.state === "interrupted" && turn.reason !== undefined ? { reason: turn.reason } : {}),
			...(delivery ? { delivery } : {}),
			activities: publishedActivities(turn.activities),
			...(turn.state === "completed" ? { finalResponse: turn.finalResponse } : {}),
			...(turn.state === "failed" ? { error: turn.error } : {}),
		};
	}

	private deliveryOf(agent: PersistedAgent, turn: AgentStoredTurn): AgentResult["delivery"] {
		const operation = agent.operations.findLast(
			(candidate) => candidate.turnId === turn.id && candidate.delivery !== undefined,
		);
		return operation && agentResultDelivery(operation.kind, operation.delivery);
	}

	private trouble(agent: PersistedAgent) {
		if (agent.agentState === "unavailable")
			return { code: "agent_dead", retryable: false, message: `${this.name} agent is dead` } as const;
		if (agent.agentState === "recovering")
			return {
				code: "agent_unreachable",
				retryable: true,
				message: `${this.name} agent is alive but unreachable`,
			} as const;
		return undefined;
	}

	private refuseRunAgent(owner: SessionRecord, agentId: string): void {
		if (this.current(owner, agentId)?.runId)
			throw new AgentTransitionError("state_conflict", "run agents must be controlled with workflowStop");
	}

	private unavailable(agentId: string, code: AgentErrorCode, retryable: boolean, message: string): AgentResult {
		return AgentResultSchema.parse({
			agentId,
			agentState: "unavailable",
			observation: "unavailable",
			activities: [],
			error: { code, message: agentErrorText(message) || `${this.name} is unavailable`, retryable },
		});
	}

	private notFound(agentId: string): AgentResult {
		return this.unavailable(agentId, "not_found", false, `${this.name} agent was not found`);
	}

	private refused(message: string): Response {
		return json(
			AgentRequestErrorSchema.parse({ error: { code: "invalid_input", retryable: false, message } }),
			400,
		);
	}

	private current(owner: SessionRecord, agentId: string): PersistedAgent | undefined {
		return this.deps.commands.observe(owner, agentId).agent;
	}

	private now(): number {
		return this.deps.ambient.now();
	}
}
