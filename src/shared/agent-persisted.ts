import { z } from "zod";
import { AgentStoredActivitiesSchema } from "./agent-activities.js";
import { AgentExecutionTargetSchema, AgentResolvedTargetSchema } from "./agent-execution-target.js";
import {
	AgentErrorTextSchema,
	AgentIdSchema,
	AgentOpaqueIdSchema,
	AgentOperationIdSchema,
	AgentPromptSchema,
	agentOperationIdentity,
} from "./agent-identity.js";
import { AgentOutputSchemaSchema, agentFingerprintVerdict, agentTurnHistoryIssues } from "./agent-record.js";
import {
	AgentDeliverySchema,
	AgentModelSchema,
	AgentReasoningEffortSchema,
	AgentServiceTierSchema,
	AgentStateSchema,
} from "./agent-state.js";
import { AgentTurnMarksSchema } from "./agent-turn-marks.js";

const Timestamp = z.number().int().nonnegative();

export const AgentStoredTurnSchema = z.discriminatedUnion("state", [
	z
		.object({
			id: AgentOpaqueIdSchema,
			state: z.literal("inProgress"),
			activities: AgentStoredActivitiesSchema,
			updatedAt: Timestamp,
		})
		.strict(),
	z
		.object({
			id: AgentOpaqueIdSchema,
			state: z.literal("completed"),
			activities: AgentStoredActivitiesSchema,
			finalItemId: AgentOpaqueIdSchema.optional(),
			finalResponse: z.string(),
			updatedAt: Timestamp,
		})
		.strict(),
	z
		.object({
			id: AgentOpaqueIdSchema,
			state: z.literal("failed"),
			activities: AgentStoredActivitiesSchema,
			error: AgentErrorTextSchema,
			updatedAt: Timestamp,
		})
		.strict(),
	z
		.object({
			id: AgentOpaqueIdSchema,
			state: z.literal("interrupted"),
			activities: AgentStoredActivitiesSchema,
			reason: AgentErrorTextSchema.optional(),
			updatedAt: Timestamp,
		})
		.strict(),
]);

export const AgentStoredOperationSchema = z
	.object({
		operationId: AgentOperationIdSchema,
		daemonInstanceId: AgentOpaqueIdSchema.optional(),
		kind: z.enum(["start", "message", "stop"]),
		prompt: AgentPromptSchema.optional(),
		model: AgentModelSchema.optional(),
		reasoningEffort: AgentReasoningEffortSchema.optional(),
		outputSchema: AgentOutputSchemaSchema.optional(),
		expectedTurnId: AgentOpaqueIdSchema.optional(),
		fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
		state: z.enum(["requested", "accepted", "indeterminate"]),
		turnId: AgentOpaqueIdSchema.optional(),
		sessionId: AgentOpaqueIdSchema.optional(),
		delivery: AgentDeliverySchema.optional(),
		createdAt: Timestamp,
		updatedAt: Timestamp,
	})
	.strict()
	.superRefine((value, ctx) => {
		const issue = (message: string) => ctx.addIssue({ code: "custom", message });
		if (value.updatedAt < value.createdAt) issue("operation update predates creation");
		if (value.kind !== "start" && (value.model !== undefined || value.reasoningEffort !== undefined))
			issue("only a start operation carries model settings");
		if (value.kind !== "message" && value.expectedTurnId !== undefined)
			issue("only a message operation carries an expected turn");
		if (value.kind === "stop" && (value.outputSchema !== undefined || value.delivery !== undefined))
			issue("stop operation carries no turn options");
		if (value.kind !== "stop" && value.state === "accepted" && (!value.turnId || !value.sessionId))
			issue("accepted prompt requires session and turn");
		if (value.kind === "start" && value.delivery === "steered") issue("a start cannot steer");
	});

export const AgentFenceSchema = z
	.object({
		daemonInstanceId: AgentOpaqueIdSchema,
		targetId: AgentOpaqueIdSchema,
		generation: z.number().int().nonnegative(),
		lastEventId: z.number().int().nonnegative(),
	})
	.strict();

export const PersistedAgentSchema = z
	.object({
		version: z.literal(2),
		agentId: AgentIdSchema,
		runId: AgentOpaqueIdSchema.optional(),
		agentState: AgentStateSchema,
		requestedTarget: AgentExecutionTargetSchema,
		resolvedTarget: AgentResolvedTargetSchema.optional(),
		/** Backend-owned thread or session. */
		sessionId: AgentOpaqueIdSchema.optional(),
		activeTurnId: AgentOpaqueIdSchema.optional(),
		/** Tier stays outside fingerprints. */
		serviceTier: AgentServiceTierSchema.optional(),
		operations: z.array(AgentStoredOperationSchema),
		turns: z.array(AgentStoredTurnSchema),
		fence: AgentFenceSchema.optional(),
		turnMarks: AgentTurnMarksSchema.optional(),
		createdAt: Timestamp,
		updatedAt: Timestamp,
	})
	.strict()
	.superRefine((value, ctx) => {
		const issue = (message: string) => ctx.addIssue({ code: "custom", message });
		for (const message of agentTurnHistoryIssues(value)) issue(message);
		if (!!value.sessionId !== !!value.resolvedTarget) issue("session and target must appear together");
		if (value.activeTurnId && !value.sessionId) issue("active turn requires a session");
		if (value.agentState === "creating" && (value.sessionId || value.turns.length > 0 || value.activeTurnId))
			issue("creating agent cannot contain native state");
		if (value.agentState === "idle" && !value.sessionId) issue("idle agent requires its session");
		if (value.resolvedTarget && value.resolvedTarget.kind !== value.requestedTarget.kind)
			issue("resolved target kind must match requested target");
		if (value.fence && (!value.resolvedTarget || value.fence.targetId !== value.resolvedTarget.targetId))
			issue("fence must match the resolved target");
		if (value.operations[0]?.kind !== "start" || value.operations.filter((op) => op.kind === "start").length !== 1)
			issue("history requires one leading start operation");
		if (new Set(value.operations.map((operation) => operation.operationId)).size !== value.operations.length)
			issue("stored operation IDs must be unique");
		for (const operation of value.operations) {
			if (operation.createdAt < value.createdAt || operation.updatedAt > value.updatedAt)
				issue("stored operation timestamp is outside its agent lifetime");
			// Tolerate unverifiable; reject mismatches.
			if (
				agentFingerprintVerdict(
					operation.fingerprint,
					agentOperationIdentity({
						kind: operation.kind,
						agentId: value.agentId,
						prompt: operation.prompt,
						model: operation.model,
					}),
				) === "mismatch"
			)
				issue("stored operation fingerprint does not match");
		}
	});

export function interruptingOperation(
	agent: Pick<PersistedAgent, "activeTurnId" | "operations">,
): AgentStoredOperation | undefined {
	if (!agent.activeTurnId) return undefined;
	return agent.operations.find(
		(operation) =>
			operation.kind === "stop" && operation.turnId === agent.activeTurnId && operation.state !== "indeterminate",
	);
}

export type PersistedAgent = z.infer<typeof PersistedAgentSchema>;
export type AgentStoredOperation = z.infer<typeof AgentStoredOperationSchema>;
export type AgentStoredTurn = z.infer<typeof AgentStoredTurnSchema>;
