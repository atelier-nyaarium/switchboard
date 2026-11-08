import { agentListAnswer, agentListRow, collectAnswer } from "../shared/agent-collect.js";
import { publishedActivities } from "../shared/agent-record.js";
import type { Clock } from "../shared/ambient.js";
import {
	COPILOT_WAIT_BUDGET_MS,
	type CopilotAgentResult,
	CopilotAgentResultSchema,
	type CopilotErrorCode,
	CopilotGatewayRequestSchema,
	type CopilotPersistedAgent,
	CopilotRequestErrorSchema,
	type CopilotStoredTurn,
	copilotAgentIdForOperation,
	sanitizeCopilotErrorText,
} from "../shared/copilot-agent.js";
import type { SessionRecord } from "../shared/session-store.js";
import { AGENT_FAILURE_ANSWERS, AgentTransitionError, jsonResponse as json } from "./agentRouteEnvelope.js";
import type { CopilotAgentCommands } from "./copilotAgentCommands.js";
import type { CopilotAgentService } from "./copilotAgentService.js";
import type { CopilotRelay } from "./copilotRelay.js";
import { presentedByRequest } from "./sessionAuthority.js";

export interface CopilotRouteDeps {
	service: CopilotAgentService;
	relay: CopilotRelay;
	commands: CopilotAgentCommands;
	ambient: Clock;
	waitBudgetMs?: number;
	onCollected?: (ownerKey: string, agentId: string, turnIds: readonly string[]) => void;
}

function unavailable(agentId: string, code: CopilotErrorCode, message: string): CopilotAgentResult {
	return CopilotAgentResultSchema.parse({
		agentId,
		agentState: code === "indeterminate" ? "recovering" : "unavailable",
		observation: code === "indeterminate" ? "indeterminate" : "unavailable",
		activities: [],
		error: { code, message, retryable: code !== "not_found" },
	});
}

function turnOf(agent: CopilotPersistedAgent, turnId?: string): CopilotStoredTurn | undefined {
	return turnId ? agent.turns.find((turn) => turn.id === turnId) : undefined;
}

function describeAgent(
	agent: CopilotPersistedAgent,
	options: {
		observation?: CopilotAgentResult["observation"];
		turnId?: string;
		delivery?: "started" | "followup" | "steered";
		includeLastSettled?: boolean;
	} = {},
): CopilotAgentResult {
	const uncertain = agent.agentState === "recovering" || agent.agentState === "unavailable";
	const turn = uncertain
		? undefined
		: (turnOf(agent, options.turnId ?? agent.activeTurnId) ??
			(options.includeLastSettled
				? agent.turns.findLast((candidate) => candidate.state !== "inProgress")
				: undefined));
	const activities = publishedActivities(turn?.activities);
	const result: CopilotAgentResult = {
		agentId: agent.agentId,
		agentState: agent.agentState,
		observation:
			options.observation ??
			(agent.agentState === "idle"
				? turn
					? "terminal"
					: "idle"
				: agent.agentState === "working"
					? "waitTimedOut"
					: agent.agentState === "creating"
						? "waitTimedOut"
						: agent.agentState === "recovering"
							? "indeterminate"
							: "unavailable"),
		activities,
		...(turn
			? {
					turn: {
						id: turn.id,
						state: turn.state,
						...(turn.state === "interrupted" ? { reason: turn.reason } : {}),
					},
				}
			: {}),
		...(options.delivery && !uncertain ? { delivery: options.delivery } : {}),
	};
	if (uncertain) {
		result.error = {
			code: agent.agentState === "recovering" ? "indeterminate" : "daemon_unavailable",
			message:
				agent.agentState === "recovering"
					? "Copilot state could not be confirmed"
					: "Copilot agent is unavailable",
			retryable: true,
		};
	}
	if (turn?.state === "completed") result.finalResponse = turn.finalResponse;
	if (turn?.state === "failed") result.error = { code: "turn_failed", message: turn.error, retryable: false };
	return CopilotAgentResultSchema.parse(result);
}

/** Dead-agent turns become lost. */
function turnView(turn: CopilotStoredTurn) {
	return {
		id: turn.id,
		state: turn.state === "inProgress" ? "lost" : turn.state,
		...(turn.state === "interrupted" ? { reason: turn.reason } : {}),
		activities: publishedActivities(turn.activities),
		...(turn.state === "completed" ? { finalResponse: turn.finalResponse } : {}),
		...(turn.state === "failed" ? { error: turn.error } : {}),
	};
}

function agentTrouble(agent: CopilotPersistedAgent) {
	if (agent.agentState === "unavailable")
		return { code: "daemon_unavailable", retryable: true, message: "Copilot agent is unavailable" } as const;
	if (agent.agentState === "recovering")
		return { code: "indeterminate", retryable: true, message: "Copilot state could not be confirmed" } as const;
	return undefined;
}

export class CopilotRoute {
	constructor(private readonly deps: CopilotRouteDeps) {}

	async handle(req: Request, body: unknown): Promise<Response> {
		const parsed = CopilotGatewayRequestSchema.safeParse(body);
		if (!parsed.success)
			return json(
				CopilotRequestErrorSchema.parse({
					error: { code: "invalid_input", retryable: false, message: "invalid Copilot request" },
				}),
				400,
			);
		const owner = this.deps.service.resolveOwner(req);
		if (!owner) {
			// Preserve not-found responses for unknown tokens.
			if (!presentedByRequest(req).token) {
				return json(
					{
						error: "this session is not bound to the gateway (launch it from the console, or install the copilot CLI for a local agent)",
					},
					401,
				);
			}
			return json({ error: "not found" }, 404);
		}
		try {
			switch (parsed.data.kind) {
				case "start":
					return json(await this.start(owner, parsed.data));
				case "message":
					return json(await this.message(owner, parsed.data));
				case "await":
					return json(this.collect(req, owner, parsed.data.agentId, parsed.data.operationId));
				case "stop":
					return json(await this.stop(owner, parsed.data));
				case "list":
					return json(this.list(owner, parsed.data));
			}
		} catch (error) {
			if (error instanceof AgentTransitionError) {
				const answer = AGENT_FAILURE_ANSWERS[error.code];
				if (answer.kind === "request")
					return json(
						CopilotRequestErrorSchema.parse({
							error: {
								code: "invalid_input",
								retryable: false,
								message: sanitizeCopilotErrorText(error.message),
							},
						}),
						400,
					);
				const agentId =
					"agentId" in parsed.data
						? parsed.data.agentId
						: parsed.data.kind === "start"
							? copilotAgentIdForOperation(parsed.data.operationId)
							: undefined;
				if (!agentId) throw error;
				return json(unavailable(agentId, answer.code, error.message));
			}
			throw error;
		}
		return json({ error: "unsupported Copilot request" }, 400);
	}

	private async start(
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CopilotGatewayRequestSchema.parse>, { kind: "start" }>,
	): Promise<CopilotAgentResult> {
		const result = this.deps.commands.start(owner, request);
		if (result.kind === "refused") return unavailable(result.agentId, result.code, result.reason);
		return this.settle(
			owner,
			result.transition.agent.agentId,
			request.operationId,
			"started",
			result.transition.agent,
			result.dispatched,
		);
	}

	private async message(
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CopilotGatewayRequestSchema.parse>, { kind: "message" }>,
	): Promise<CopilotAgentResult> {
		if (this.deps.commands.observe(owner, request.agentId).agent?.runId)
			throw new AgentTransitionError("state_conflict", "run agents must be controlled with workflowStop");
		const result = this.deps.commands.message(owner, request);
		if (result.kind === "refused") return unavailable(request.agentId, result.code, result.reason);
		return this.settle(
			owner,
			request.agentId,
			request.operationId,
			"followup",
			result.transition.agent,
			result.dispatched,
		);
	}

	private async stop(
		owner: SessionRecord,
		request: Extract<ReturnType<typeof CopilotGatewayRequestSchema.parse>, { kind: "stop" }>,
	): Promise<CopilotAgentResult> {
		if (this.deps.commands.observe(owner, request.agentId).agent?.runId)
			throw new AgentTransitionError("state_conflict", "run agents must be controlled with workflowStop");
		const result = this.deps.commands.stop(owner, request);
		if (result.kind === "refused") return unavailable(request.agentId, result.code, result.reason);
		const agent = this.deps.commands.observe(owner, request.agentId).agent ?? result.transition.agent;
		return describeAgent(agent, {
			observation: result.transition.operation.state === "accepted" ? "idle" : "interruptRequested",
			turnId: agent.activeTurnId,
		});
	}

	private collect(req: Request, owner: SessionRecord, agentId: string, operationId: string | undefined): unknown {
		const owned = this.deps.service.resolveOwnedAgent(req, agentId);
		if (!owned || owned.agent.runId) return unavailable(agentId, "not_found", "Copilot agent was not found");
		if (!owned.agent.activeTurnId) this.deps.relay.reconcileStale(owner);
		const collected = this.deps.service.collect(owner, agentId, operationId);
		if (!collected) return unavailable(agentId, "not_found", "Copilot agent was not found");
		this.deps.onCollected?.(this.deps.service.ownerKeyOf(owner), agentId, collected.turnIds);
		const { agent } = collected;
		const trouble = agentTrouble(agent);
		return {
			...collectAnswer(agent, collected.turnIds, turnView),
			...(trouble ? { error: trouble } : {}),
		};
	}

	private list(owner: SessionRecord, request: { agentId?: string; limit?: number }) {
		this.deps.relay.reconcileStale(owner);
		return agentListAnswer(this.deps.service.listOwnedAgents(owner), request, (agent) =>
			agentListRow(agent, "copilot", {
				model: agent.operations.find((operation) => operation.kind === "start")?.model,
				latestPrompt: agent.operations.findLast((operation) => operation.prompt !== undefined)?.prompt,
			}),
		);
	}

	private async settle(
		owner: SessionRecord,
		agentId: string,
		operationId: string,
		delivery: "started" | "followup" | "steered",
		initial: CopilotPersistedAgent,
		dispatched = true,
	): Promise<CopilotAgentResult> {
		// Unsent deliveries have no wait budget.
		const deadline = dispatched ? this.deadline() : this.now();
		await this.deps.relay.waitFor(
			this.deps.service.ownerKeyOf(owner),
			agentId,
			() => {
				const operation = this.current(owner, agentId)?.operations.find(
					(candidate) => candidate.operationId === operationId,
				);
				return operation !== undefined && operation.state !== "requested";
			},
			deadline,
		);
		const current = this.current(owner, agentId) ?? initial;
		const operation = current.operations.find((candidate) => candidate.operationId === operationId);
		if (!operation || operation.state === "requested") {
			const abandoned = this.deps.commands.abandon(owner, agentId, operationId, this.now());
			if (!abandoned) return unavailable(agentId, "not_found", "Copilot agent was not found");
			if (abandoned.agentState === "creating")
				return describeAgent(abandoned, { observation: "waitTimedOut", delivery });
			const refusal = this.deps.commands.observe(owner, agentId, operationId).refusal;
			return unavailable(
				agentId,
				refusal?.code ?? (abandoned.agentState === "unavailable" ? "daemon_unavailable" : "indeterminate"),
				refusal?.message ?? "Copilot delivery was not confirmed within the wait budget",
			);
		}
		if (!operation.turnId) {
			if (operation.state === "accepted") return describeAgent(current, { observation: "idle" });
			const refusal = this.deps.commands.observe(owner, agentId, operationId).refusal;
			return unavailable(
				agentId,
				refusal?.code ?? (current.agentState === "unavailable" ? "daemon_unavailable" : "indeterminate"),
				refusal?.message ?? "Copilot delivery could not be confirmed",
			);
		}
		// The turn is not waited on; a completion notice follows it.
		const taken = current.turns.find((candidate) => candidate.id === operation.turnId);
		return describeAgent(current, {
			turnId: operation.turnId,
			// The daemon's word, where the receipt recorded one.
			delivery: operation.delivery ?? delivery,
			observation:
				current.agentState === "working" && taken?.state === "inProgress"
					? "accepted"
					: current.agentState === "recovering"
						? "indeterminate"
						: "terminal",
		});
	}

	private current(owner: SessionRecord, agentId: string): CopilotPersistedAgent | undefined {
		return this.deps.commands.observe(owner, agentId).agent;
	}

	private deadline(): number {
		return this.now() + (this.deps.waitBudgetMs ?? COPILOT_WAIT_BUDGET_MS);
	}

	private now(): number {
		return this.deps.ambient.now();
	}
}
