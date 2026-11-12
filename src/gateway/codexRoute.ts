import { agentListAnswer, agentListRow, collectAnswer } from "../shared/agent-collect.js";
import { publishedActivities } from "../shared/agent-record.js";
import { agentResultDelivery } from "../shared/agent-state.js";
import type { Clock } from "../shared/ambient.js";
import {
	CODEX_WAIT_BUDGET_MS,
	type CodexAgentResult,
	CodexAgentResultSchema,
	type CodexErrorCode,
	CodexGatewayRequestSchema,
	type CodexPersistedAgent,
	CodexRequestErrorSchema,
	type CodexStoredTurn,
	codexAgentIdForOperation,
	sanitizeCodexErrorText,
} from "../shared/codex-agent.js";
import type { SessionRecord } from "../shared/session-store.js";
import { AGENT_FAILURE_ANSWERS, AgentTransitionError, jsonResponse as json } from "./agentRouteEnvelope.js";
import type { CodexAgentCommands } from "./codexAgentCommands.js";
import type { CodexAgentService } from "./codexAgentService.js";
import type { CodexRelay } from "./codexRelay.js";
import { presentedByRequest } from "./sessionAuthority.js";

export interface CodexRouteDeps {
	service: CodexAgentService;
	relay: CodexRelay;
	commands: CodexAgentCommands;
	ambient: Clock;
	/** Dispatch wait budget. */
	waitBudgetMs?: number;
	onCollected?: (ownerKey: string, agentId: string, turnIds: readonly string[]) => void;
}

const DEFAULT_WAIT_BUDGET_MS = CODEX_WAIT_BUDGET_MS;

function unavailable(
	agentId: string,
	error: { code: CodexErrorCode; retryable: boolean },
	message: string,
): CodexAgentResult {
	return CodexAgentResultSchema.parse({
		agentId,
		agentState: "unavailable",
		observation: "unavailable",
		activities: [],
		error: { code: error.code, message, retryable: error.retryable },
	});
}

const TARGET_UNAVAILABLE = { code: "daemon_unavailable" as const, retryable: true };
const AGENT_NOT_FOUND = { code: "not_found" as const, retryable: false };

function turnOf(agent: CodexPersistedAgent, turnId: string | undefined): CodexStoredTurn | undefined {
	return turnId ? agent.turns.find((turn) => turn.id === turnId) : undefined;
}

/** `accepted` names a turn the daemon took and nothing yet waited on, as a start or message answers. */
function describeAgent(
	agent: CodexPersistedAgent,
	waitedTurnId: string | undefined,
	accepted = false,
): CodexAgentResult {
	// Unavailable and recovering states override any previously settled turn.
	if (agent.agentState === "unavailable" || agent.agentState === "recovering") {
		const dead = agent.agentState === "unavailable";
		return CodexAgentResultSchema.parse({
			agentId: agent.agentId,
			agentState: agent.agentState,
			observation: "unavailable",
			activities: [],
			error: {
				code: dead ? "agent_dead" : "agent_unreachable",
				retryable: !dead,
				message: dead ? "codex agent is dead" : "codex agent is alive but unreachable",
			},
		});
	}
	const turn = turnOf(agent, waitedTurnId);
	const activities = publishedActivities(turn?.activities);
	if (!turn) {
		return CodexAgentResultSchema.parse({
			agentId: agent.agentId,
			agentState: agent.agentState === "working" ? "idle" : agent.agentState,
			observation: agent.agentState === "creating" ? "waitTimedOut" : "idle",
			activities: [],
		});
	}
	const exchange = agent.exchanges.findLast((candidate) => candidate.turnId === turn.id);
	const delivery = exchange && agentResultDelivery(exchange.kind, exchange.delivery);
	if (turn.state === "inProgress") {
		const interrupting = agent.pendingInterrupt !== undefined;
		const delivered = accepted && delivery !== undefined;
		return CodexAgentResultSchema.parse({
			agentId: agent.agentId,
			agentState: "working",
			observation: interrupting ? "interruptRequested" : delivered ? "accepted" : "waitTimedOut",
			turn: { id: turn.id, state: turn.state },
			// Interrupting turns omit delivery.
			delivery: interrupting ? undefined : delivery,
			activities,
		});
	}
	return CodexAgentResultSchema.parse({
		agentId: agent.agentId,
		agentState: "idle",
		observation: "terminal",
		turn: { id: turn.id, state: turn.state, ...(turn.state === "interrupted" ? { reason: turn.reason } : {}) },
		delivery,
		activities,
		...(turn.state === "completed" ? { finalResponse: turn.finalResponse } : {}),
		...(turn.state === "failed" ? { error: { code: "turn_failed", message: turn.error, retryable: false } } : {}),
	});
}

/** Dead-agent turns become lost. */
function turnView(agent: CodexPersistedAgent, turn: CodexStoredTurn) {
	const exchange = agent.exchanges.findLast((candidate) => candidate.turnId === turn.id);
	const delivery = exchange && agentResultDelivery(exchange.kind, exchange.delivery);
	return {
		id: turn.id,
		state: turn.state === "inProgress" ? "lost" : turn.state,
		...(turn.state === "interrupted" ? { reason: turn.reason } : {}),
		...(delivery === undefined ? {} : { delivery }),
		activities: publishedActivities(turn.activities),
		...(turn.state === "completed" ? { finalResponse: turn.finalResponse } : {}),
		...(turn.state === "failed" ? { error: turn.error } : {}),
	};
}

function agentTrouble(agent: CodexPersistedAgent) {
	if (agent.agentState === "unavailable")
		return { code: "agent_dead", retryable: false, message: "codex agent is dead" } as const;
	if (agent.agentState === "recovering")
		return { code: "agent_unreachable", retryable: true, message: "codex agent is alive but unreachable" } as const;
	return undefined;
}

export class CodexRoute {
	constructor(private readonly deps: CodexRouteDeps) {}

	async handle(req: Request, body: unknown): Promise<Response> {
		const parsed = CodexGatewayRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid Codex request" }, 400);

		const owner = this.deps.service.resolveOwner(req);
		if (!owner) {
			if (!presentedByRequest(req).token) {
				return json(
					{
						error: "this session is not bound to the gateway (launch it from the console, or install the codex CLI for a local agent)",
					},
					401,
				);
			}
			// Unknown tokens remain indistinguishable from unknown agents.
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
					return json(await this.stop(owner, request));
				case "list":
					return json(this.list(owner, request));
				default:
					return json({ error: "unsupported Codex request" }, 400);
			}
		} catch (error) {
			if (error instanceof AgentTransitionError) {
				const answer = AGENT_FAILURE_ANSWERS[error.code];
				if (answer.kind === "request") {
					return json(
						CodexRequestErrorSchema.parse({
							error: {
								code: "invalid_input",
								retryable: false,
								message: sanitizeCodexErrorText(error.message),
							},
						}),
						400,
					);
				}
				const agentId =
					"agentId" in request
						? request.agentId
						: request.kind === "start"
							? codexAgentIdForOperation(request.operationId)
							: undefined;
				if (!agentId) throw error;
				return json(unavailable(agentId, answer, error.message));
			}
			throw error;
		}
	}

	private async start(
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CodexGatewayRequestSchema.parse>, { kind: "start" }>,
	): Promise<CodexAgentResult> {
		const result = this.deps.commands.start(owner, request);
		if (result.kind === "refused") return unavailable(result.agentId, TARGET_UNAVAILABLE, result.reason);
		return this.settle(owner, result.transition.agent.agentId, request.operationId, result.dispatched);
	}

	private async message(
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CodexGatewayRequestSchema.parse>, { kind: "message" }>,
	): Promise<CodexAgentResult> {
		if (this.deps.commands.observe(owner, request.agentId).agent?.runId)
			throw new AgentTransitionError("state_conflict", "run agents must be controlled with workflowStop");
		const result = this.deps.commands.message(owner, request);
		if (result.kind === "refused")
			return unavailable(
				request.agentId,
				result.code === "not_found" ? AGENT_NOT_FOUND : TARGET_UNAVAILABLE,
				result.reason,
			);
		return this.settle(owner, request.agentId, request.operationId, result.dispatched);
	}

	private async stop(
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CodexGatewayRequestSchema.parse>, { kind: "stop" }>,
	): Promise<CodexAgentResult> {
		if (this.deps.commands.observe(owner, request.agentId).agent?.runId)
			throw new AgentTransitionError("state_conflict", "run agents must be controlled with workflowStop");
		const result = this.deps.commands.stop(owner, request);
		if (result.kind === "refused")
			return unavailable(
				request.agentId,
				result.code === "not_found" ? AGENT_NOT_FOUND : TARGET_UNAVAILABLE,
				result.reason,
			);
		const agent = this.deps.commands.observe(owner, request.agentId).agent ?? result.transition.agent;
		return describeAgent(agent, agent.activeTurnId);
	}

	private collect(req: Request, owner: SessionRecord, agentId: string, operationId: string | undefined): unknown {
		const owned = this.deps.service.resolveOwnedAgent(req, agentId);
		if (!owned || owned.agent.runId) return unavailable(agentId, AGENT_NOT_FOUND, "codex agent was not found");
		if (!owned.agent.activeTurnId) this.deps.relay.reconcileStale(owner);
		const collected = this.deps.service.collect(owner, agentId, operationId);
		if (!collected) return unavailable(agentId, AGENT_NOT_FOUND, "codex agent was not found");
		this.deps.onCollected?.(this.ownerKey(owner), agentId, collected.turnIds);
		const { agent } = collected;
		return {
			...collectAnswer(agent, collected.turnIds, (turn) => turnView(agent, turn)),
			...(agentTrouble(agent) ? { error: agentTrouble(agent) } : {}),
		};
	}

	private list(
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CodexGatewayRequestSchema.parse>, { kind: "list" }>,
	): unknown {
		this.deps.relay.reconcileStale(owner);
		return agentListAnswer(this.deps.service.listOwnedAgents(owner), request, (agent) =>
			agentListRow(agent, "codex", {
				model: agent.exchanges.find((exchange) => exchange.kind === "start")?.model,
				latestPrompt: agent.exchanges.at(-1)?.prompt,
			}),
		);
	}

	/** Waits for the daemon to take the turn, not for the turn; a completion notice follows it. */
	private async settle(
		owner: SessionRecord,
		agentId: string,
		operationId: string,
		dispatched = true,
	): Promise<CodexAgentResult> {
		const deadline = dispatched ? this.deadline() : this.now();
		const accepted = await this.waitForAcceptance(owner, agentId, operationId, deadline);
		const agent = this.current(owner, agentId);
		if (!agent) return unavailable(agentId, AGENT_NOT_FOUND, "codex agent was not found");
		const turnId = accepted?.turnId;
		if (!turnId) {
			// Nothing asks about an unsent start again.
			if (agent.agentState === "creating" && dispatched) {
				return CodexAgentResultSchema.parse({
					agentId,
					agentState: "creating",
					observation: "waitTimedOut",
					activities: [],
				});
			}
			const recovering = this.deps.commands.abandon(owner, agentId, operationId, this.now());
			const refusalReason = this.deps.commands.observe(owner, agentId, operationId).refusalReason;
			if (!dispatched) {
				return unavailable(
					agentId,
					{ code: "daemon_unavailable", retryable: true },
					"the host daemon is not connected, so codex never received this",
				);
			}
			// Unconfirmed delivery is reported as recovery, never as idle.
			return CodexAgentResultSchema.parse({
				agentId,
				agentState: recovering?.agentState === "unavailable" ? "unavailable" : "recovering",
				observation: "indeterminate",
				activities: [],
				error: {
					code: "indeterminate",
					retryable: true,
					message: refusalReason ?? "codex delivery was not confirmed within the wait budget",
				},
			});
		}
		return describeAgent(this.current(owner, agentId) ?? agent, turnId, true);
	}

	private async waitForAcceptance(
		owner: SessionRecord,
		agentId: string,
		operationId: string,
		deadline: number,
	): Promise<{ turnId: string } | undefined> {
		const accepted = () => {
			const operation = this.current(owner, agentId)?.operations.find(
				(candidate) => candidate.operationId === operationId,
			);
			return operation?.state === "requested" ? undefined : operation;
		};
		await this.deps.relay.waitFor(this.ownerKey(owner), agentId, () => accepted() !== undefined, deadline);
		const settled = accepted();
		return settled?.turnId ? { turnId: settled.turnId } : undefined;
	}

	private current(owner: SessionRecord, agentId: string): CodexPersistedAgent | undefined {
		return this.deps.commands.observe(owner, agentId).agent;
	}

	private ownerKey(owner: SessionRecord): string {
		return this.deps.service.ownerKeyOf(owner);
	}

	private deadline(): number {
		return this.now() + (this.deps.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS);
	}

	private now(): number {
		return this.deps.ambient.now();
	}
}
