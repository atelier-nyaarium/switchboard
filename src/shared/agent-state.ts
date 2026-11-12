import { z } from "zod";
import { AgentActivitiesSchema } from "./agent-activities.js";
import { type AgentBackendDescriptor, agentBackendOf } from "./agent-backend.js";
import {
	AgentErrorTextSchema,
	AgentIdSchema,
	AgentOpaqueIdSchema,
	AgentOperationIdSchema,
	AgentPromptSchema,
} from "./agent-identity.js";
import { AgentOutputSchemaSchema } from "./agent-record.js";

////////////////////////////////
//  Vocabulary

export const AgentStateSchema = z.enum(["creating", "idle", "working", "recovering", "unavailable"]);
export const AgentTurnStateSchema = z.enum(["inProgress", "completed", "failed", "interrupted"]);
export const AgentObservationSchema = z.enum([
	"accepted",
	"idle",
	"terminal",
	"waitTimedOut",
	"interruptRequested",
	"indeterminate",
	"unavailable",
]);
/** Prompt starts or steers. */
export const AgentDeliverySchema = z.enum(["started", "steered"]);
/** An agent's first turn, a message that opened a turn, a message into the running turn. */
export const AgentResultDeliverySchema = z.enum(["started", "followup", "steered"]);

/** The answer's word for a stored delivery. */
export function agentResultDelivery(
	kind: "start" | "message" | "stop",
	delivery: z.infer<typeof AgentDeliverySchema> | undefined,
): z.infer<typeof AgentResultDeliverySchema> | undefined {
	return kind === "message" && delivery === "started" ? "followup" : delivery;
}
/** Standard means no override. */
export const AgentServiceTierSchema = z.enum(["priority", "standard"]);
/** Check offers on open. */
export const AgentReasoningEffortSchema = z.string().min(1).max(32);
export const AgentModelSchema = z.string().min(1).max(128);

export const AgentErrorCodeSchema = z.enum([
	"invalid_input",
	"not_found",
	"feature_disabled",
	"daemon_unavailable",
	"app_server_unavailable",
	"authentication_required",
	"agent_dead",
	"agent_unreachable",
	"interrupt_in_progress",
	"protocol_incompatible",
	"protocol_error",
	"indeterminate",
	"turn_failed",
	"agent_busy",
]);
export const AgentDaemonFailureCodeSchema = z.enum([
	"daemon_unavailable",
	"app_server_unavailable",
	"authentication_required",
	"protocol_incompatible",
	"protocol_error",
]);

export const AgentErrorSchema = z
	.object({
		code: AgentErrorCodeSchema,
		message: AgentErrorTextSchema,
		retryable: z.boolean(),
	})
	.strict();
export const AgentRequestErrorSchema = z
	.object({
		error: AgentErrorSchema.extend({ code: z.literal("invalid_input"), retryable: z.literal(false) }).strict(),
	})
	.strict();

////////////////////////////////
//  Agent result

const INFRASTRUCTURE_ERRORS: ReadonlySet<string> = new Set([
	"daemon_unavailable",
	"app_server_unavailable",
	"authentication_required",
	"agent_dead",
	"agent_unreachable",
	"protocol_incompatible",
	"protocol_error",
]);

export const AgentResultSchema = z
	.object({
		agentId: AgentIdSchema,
		agentState: AgentStateSchema,
		observation: AgentObservationSchema,
		turn: z
			.object({
				id: AgentOpaqueIdSchema,
				state: AgentTurnStateSchema,
				reason: AgentErrorTextSchema.optional(),
			})
			.strict()
			.optional(),
		delivery: AgentResultDeliverySchema.optional(),
		activities: AgentActivitiesSchema,
		finalResponse: z.string().optional(),
		error: AgentErrorSchema.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		const issue = (message: string, path?: string[]) =>
			ctx.addIssue({ code: "custom", message, ...(path ? { path } : {}) });
		const { observation, agentState, turn, delivery, error } = value;
		if (delivery && !turn) issue("delivery requires an accepted turn", ["delivery"]);
		if (turn?.reason !== undefined && turn.state !== "interrupted")
			issue("only an interrupted turn carries a reason", ["turn", "reason"]);
		if (value.activities.length > 0 && !turn) issue("activities require a turn", ["activities"]);
		const creationTimedOut = observation === "waitTimedOut" && agentState === "creating" && !turn && !delivery;
		const requiresInProgressTurn =
			observation === "accepted" ||
			(observation === "waitTimedOut" && !creationTimedOut) ||
			observation === "interruptRequested";
		if (requiresInProgressTurn && turn?.state !== "inProgress")
			issue(`${observation} requires an in-progress turn`, ["turn"]);
		if (observation === "accepted" && !delivery) issue("accepted observation requires delivery", ["delivery"]);
		if (requiresInProgressTurn && agentState !== "working")
			issue(`${observation} requires a working agent`, ["agentState"]);
		if (observation === "idle" && (agentState !== "idle" || turn || delivery))
			issue("idle observation cannot carry active delivery", ["observation"]);
		if (observation === "terminal" && (!turn || turn.state === "inProgress" || agentState !== "idle"))
			issue("terminal observation requires an idle agent and terminal turn", ["turn"]);
		if (value.finalResponse !== undefined && (observation !== "terminal" || turn?.state !== "completed"))
			issue("final response requires a completed terminal observation", ["finalResponse"]);
		if (observation === "terminal" && turn?.state === "completed" && value.finalResponse === undefined)
			issue("completed terminal turn requires its final response");
		if (observation === "terminal" && turn?.state === "failed" && error?.code !== "turn_failed")
			issue("failed turn requires a turn_failed error", ["error"]);
		if (error?.code === "turn_failed" && turn?.state !== "failed")
			issue("turn_failed error requires a failed turn", ["error"]);
		if (observation === "terminal" && turn?.state !== "failed" && error)
			issue("only a failed terminal turn carries an error", ["error"]);
		if (observation === "unavailable") {
			const contextless = error?.code === "not_found";
			const featureDisabled = error?.code === "feature_disabled";
			const interruptBlocked = error?.code === "interrupt_in_progress";
			const infrastructureError = error !== undefined && INFRASTRUCTURE_ERRORS.has(error.code);
			if (
				contextless &&
				(agentState !== "unavailable" ||
					turn ||
					delivery ||
					value.activities.length ||
					value.finalResponse !== undefined)
			)
				issue("contextless errors cannot claim agent activity", ["error"]);
			if (infrastructureError && agentState !== "unavailable" && agentState !== "recovering")
				issue("infrastructure errors require unavailable agent state", ["agentState"]);
			if (error?.code === "agent_dead" && (agentState !== "unavailable" || error.retryable))
				issue("agent_dead requires an unavailable agent and is never retryable", ["error"]);
			if (error?.code === "agent_unreachable" && (agentState !== "recovering" || !error.retryable))
				issue("agent_unreachable requires a recovering agent and is retryable", ["error"]);
			if (featureDisabled && delivery) issue("disabled work cannot claim native delivery", ["delivery"]);
			if (interruptBlocked && (agentState !== "working" || turn?.state !== "inProgress" || delivery))
				issue("interrupt_in_progress requires the blocked active turn", ["error"]);
			if (!error) issue("unavailable observation requires an error", ["error"]);
			if (!contextless && !featureDisabled && !interruptBlocked && !infrastructureError)
				issue("error code does not describe unavailability", ["error"]);
		}
		if (observation === "indeterminate" && error?.code !== "indeterminate")
			issue("indeterminate observation requires an indeterminate error", ["error"]);
		if (
			observation === "indeterminate" &&
			(turn ||
				delivery ||
				value.activities.length ||
				(agentState !== "recovering" && agentState !== "unavailable"))
		)
			issue("indeterminate delivery cannot claim a native turn", ["observation"]);
		if (observation === "interruptRequested" && error && error.code !== "interrupt_in_progress")
			issue("interrupt request only allows an interrupt_in_progress error", ["error"]);
		if (observation === "interruptRequested" && delivery)
			issue("an interrupt request cannot report start or steer delivery", ["delivery"]);
		const errorAllowed =
			observation === "unavailable" ||
			observation === "indeterminate" ||
			observation === "interruptRequested" ||
			(observation === "terminal" && turn?.state === "failed");
		if (error && !errorAllowed) issue("observation does not allow an error", ["error"]);
	});

////////////////////////////////
//  Tool inputs and gateway request

export const AgentStartInputSchema = z
	.object({
		prompt: AgentPromptSchema,
		/** Fixed per thread. */
		model: AgentModelSchema.optional(),
		/** Host-only and thread-fixed. */
		cwd: z.string().min(1).max(512).optional(),
		/** Persists until changed. */
		serviceTier: AgentServiceTierSchema.optional(),
		reasoningEffort: AgentReasoningEffortSchema.optional(),
		outputSchema: AgentOutputSchemaSchema.optional(),
	})
	.strict();
export const AgentMessageInputSchema = z
	.object({
		agentId: AgentIdSchema,
		prompt: AgentPromptSchema,
		/** A steer keeps its turn's tier, so a change lands on the next turn. */
		serviceTier: AgentServiceTierSchema.optional(),
		/** Steers preserve the active schema. */
		outputSchema: AgentOutputSchemaSchema.optional(),
	})
	.strict();
export const AgentCollectInputSchema = z.object({ agentId: AgentIdSchema }).strict();
export const AgentStopInputSchema = z.object({ agentId: AgentIdSchema }).strict();
export const AgentListInputSchema = z
	.object({
		agentId: AgentIdSchema.optional(),
		limit: z.number().int().positive().max(50).optional(),
	})
	.strict();
export const AgentGatewayRequestSchema = z.discriminatedUnion("kind", [
	AgentStartInputSchema.extend({ kind: z.literal("start"), operationId: AgentOperationIdSchema }).strict(),
	AgentMessageInputSchema.extend({ kind: z.literal("message"), operationId: AgentOperationIdSchema }).strict(),
	AgentCollectInputSchema.extend({
		kind: z.literal("await"),
		operationId: AgentOperationIdSchema.optional(),
	}).strict(),
	AgentStopInputSchema.extend({ kind: z.literal("stop"), operationId: AgentOperationIdSchema }).strict(),
	AgentListInputSchema.extend({ kind: z.literal("list") }).strict(),
]);

/** Routes narrow shared requests. */
export function agentRequestIssue(backend: AgentBackendDescriptor, request: AgentGatewayRequest): string | undefined {
	if ("agentId" in request && request.agentId !== undefined && agentBackendOf(request.agentId) !== backend.id)
		return `not a ${backend.displayName} agent id`;
	if ("serviceTier" in request && request.serviceTier !== undefined && !backend.options.serviceTier)
		return `serviceTier is not a ${backend.displayName} option`;
	if ("reasoningEffort" in request && request.reasoningEffort !== undefined && !backend.options.reasoningEffort)
		return `reasoningEffort is not a ${backend.displayName} option`;
	return undefined;
}

export type AgentState = z.infer<typeof AgentStateSchema>;
export type AgentTurnState = z.infer<typeof AgentTurnStateSchema>;
export type AgentDelivery = z.infer<typeof AgentDeliverySchema>;
export type AgentServiceTier = z.infer<typeof AgentServiceTierSchema>;
export type AgentResult = z.infer<typeof AgentResultSchema>;
export type AgentDaemonFailureCode = z.infer<typeof AgentDaemonFailureCodeSchema>;
export type AgentErrorCode = z.infer<typeof AgentErrorCodeSchema>;
export type AgentGatewayRequest = z.infer<typeof AgentGatewayRequestSchema>;
