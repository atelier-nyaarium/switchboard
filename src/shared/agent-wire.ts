// The Gateway to daemon wire for a delegated agent. Commands go down. Receipts and events come back
// fenced by (daemonInstanceId, targetId, generation, eventId), the ack retires the daemon's outbox,
// and the hello names its live generations on reconnect.

import { z } from "zod";
import { type AgentBackendId, agentFrameType } from "./agent-backend.js";
import { AgentCounterKindSchema } from "./agent-counter.js";
import {
	AgentExecutionTargetSchema,
	AgentOwnerKeySchema,
	AgentResolvedTargetSchema,
} from "./agent-execution-target.js";
import {
	AgentErrorTextSchema,
	AgentIdSchema,
	AgentOpaqueIdSchema,
	AgentOperationIdSchema,
	AgentPromptSchema,
} from "./agent-identity.js";
import { AGENT_ACTIVITY_MAX_BYTES, AgentOutputSchemaSchema, boundedUtf8 } from "./agent-record.js";
import {
	AgentDaemonFailureCodeSchema,
	AgentDeliverySchema,
	AgentModelSchema,
	AgentReasoningEffortSchema,
	AgentServiceTierSchema,
	AgentTurnStateSchema,
} from "./agent-state.js";

////////////////////////////////
//  Schemas

const Count = z.number().int().nonnegative();

function build(backend: AgentBackendId) {
	const commandBase = {
		type: z.literal(agentFrameType(backend, "command")),
		requestId: AgentOperationIdSchema,
		ownerKey: AgentOwnerKeySchema,
		agentId: AgentIdSchema,
	};
	const command = z.discriminatedUnion("kind", [
		z
			.object({
				...commandBase,
				kind: z.literal("start"),
				operationId: AgentOperationIdSchema,
				target: AgentExecutionTargetSchema,
				prompt: AgentPromptSchema,
				model: AgentModelSchema.optional(),
				serviceTier: AgentServiceTierSchema.optional(),
				reasoningEffort: AgentReasoningEffortSchema.optional(),
				outputSchema: AgentOutputSchemaSchema.optional(),
			})
			.strict(),
		z
			.object({
				...commandBase,
				kind: z.literal("message"),
				operationId: AgentOperationIdSchema,
				target: AgentResolvedTargetSchema,
				sessionId: AgentOpaqueIdSchema,
				/** Settled turns start anew. */
				expectedTurnId: AgentOpaqueIdSchema.optional(),
				prompt: AgentPromptSchema,
				/** Missed-start model fallback. */
				model: AgentModelSchema.optional(),
				serviceTier: AgentServiceTierSchema.optional(),
				outputSchema: AgentOutputSchemaSchema.optional(),
			})
			.strict(),
		z
			.object({
				...commandBase,
				kind: z.literal("interrupt"),
				operationId: AgentOperationIdSchema,
				target: AgentResolvedTargetSchema,
				sessionId: AgentOpaqueIdSchema,
				turnId: AgentOpaqueIdSchema,
			})
			.strict(),
		z
			.object({
				...commandBase,
				kind: z.literal("reconcile"),
				target: AgentResolvedTargetSchema,
				sessionId: AgentOpaqueIdSchema,
				turnId: AgentOpaqueIdSchema.optional(),
			})
			.strict(),
	]);

	const eventBase = {
		type: z.literal(agentFrameType(backend, "event")),
		ownerKey: AgentOwnerKeySchema,
		daemonInstanceId: AgentOpaqueIdSchema,
		targetId: AgentOpaqueIdSchema,
		generation: Count,
		eventId: Count,
		agentId: AgentIdSchema,
		sessionId: AgentOpaqueIdSchema,
		turnId: AgentOpaqueIdSchema,
	};
	const event = z.union([
		z
			.object({
				...eventBase,
				kind: z.literal("counter"),
				itemId: AgentOpaqueIdSchema.optional(),
				counterKind: AgentCounterKindSchema,
				filesChanged: Count.optional(),
			})
			.strict(),
		z
			.object({
				...eventBase,
				kind: z.literal("activity"),
				itemId: AgentOpaqueIdSchema,
				text: boundedUtf8(AGENT_ACTIVITY_MAX_BYTES, "activity"),
			})
			.strict(),
		z
			.object({
				...eventBase,
				kind: z.literal("terminal"),
				state: z.literal("completed"),
				finalItemId: AgentOpaqueIdSchema.optional(),
				finalResponse: z.string(),
			})
			.strict(),
		z
			.object({
				...eventBase,
				kind: z.literal("terminal"),
				state: z.literal("failed"),
				error: AgentErrorTextSchema,
			})
			.strict(),
		z
			.object({
				...eventBase,
				kind: z.literal("terminal"),
				state: z.literal("interrupted"),
				reason: AgentErrorTextSchema.optional(),
			})
			.strict(),
	]);

	const receiptBase = {
		type: z.literal(agentFrameType(backend, "receipt")),
		requestId: AgentOperationIdSchema,
		ownerKey: AgentOwnerKeySchema,
		daemonInstanceId: AgentOpaqueIdSchema,
		eventId: Count,
		agentId: AgentIdSchema,
	};
	const fencedReceiptBase = { ...receiptBase, targetId: AgentOpaqueIdSchema, generation: Count };
	const interruptBase = {
		...fencedReceiptBase,
		kind: z.literal("interruptResult"),
		operationId: AgentOperationIdSchema,
		sessionId: AgentOpaqueIdSchema,
		turnId: AgentOpaqueIdSchema,
	};
	const receipt = z
		.union([
			z
				.object({
					...fencedReceiptBase,
					kind: z.literal("accepted"),
					operationId: AgentOperationIdSchema,
					resolvedTarget: AgentResolvedTargetSchema,
					sessionId: AgentOpaqueIdSchema,
					turnId: AgentOpaqueIdSchema,
					delivery: AgentDeliverySchema,
				})
				.strict(),
			// Refusals cross retired generations.
			z
				.object({
					...receiptBase,
					kind: z.literal("rejected"),
					operationId: AgentOperationIdSchema.optional(),
					failureCode: AgentDaemonFailureCodeSchema.optional(),
					error: AgentErrorTextSchema,
				})
				.strict(),
			z.object({ ...interruptBase, ok: z.literal(true) }).strict(),
			z.object({ ...interruptBase, ok: z.literal(false), error: AgentErrorTextSchema }).strict(),
			z
				.object({
					...fencedReceiptBase,
					kind: z.literal("reconciled"),
					resolvedTarget: AgentResolvedTargetSchema,
					sessionId: AgentOpaqueIdSchema,
					turnId: AgentOpaqueIdSchema.optional(),
					/** Omit when unknown. */
					turnState: AgentTurnStateSchema.optional(),
				})
				.strict(),
		])
		.superRefine((value, ctx) => {
			if ("resolvedTarget" in value && value.targetId !== value.resolvedTarget.targetId)
				ctx.addIssue({ code: "custom", message: "receipt target fence does not match resolved target" });
			if (value.kind === "reconciled" && value.turnState !== undefined && value.turnId === undefined)
				ctx.addIssue({ code: "custom", message: "reconciled turn state requires a turn ID" });
		});

	/** Advertise generations on reconnect. */
	const hello = z
		.object({
			type: z.literal(agentFrameType(backend, "hello")),
			daemonInstanceId: AgentOpaqueIdSchema,
			targets: z.array(z.object({ targetId: AgentOpaqueIdSchema, generation: Count }).strict()),
		})
		.strict();
	/** Cumulative per generation. */
	const ack = z
		.object({
			type: z.literal(agentFrameType(backend, "ack")),
			daemonInstanceId: AgentOpaqueIdSchema,
			targetId: AgentOpaqueIdSchema,
			generation: Count,
			throughEventId: Count,
		})
		.strict();

	return { command, event, receipt, hello, ack };
}

////////////////////////////////
//  Functions & Helpers

const built = new Map<AgentBackendId, ReturnType<typeof build>>();

/** Same shapes; backend labels. */
export function agentWire(backend: AgentBackendId): ReturnType<typeof build> {
	const held = built.get(backend);
	if (held) return held;
	const made = build(backend);
	built.set(backend, made);
	return made;
}

type Wire = ReturnType<typeof build>;
export type AgentDaemonCommand = z.infer<Wire["command"]>;
export type AgentDaemonEvent = z.infer<Wire["event"]>;
export type AgentDaemonReceipt = z.infer<Wire["receipt"]>;
export type AgentDaemonHello = z.infer<Wire["hello"]>;
export type AgentDaemonAck = z.infer<Wire["ack"]>;

// Set reliability per kind.
export const AGENT_RELIABLE_EVENT_KIND: Record<AgentDaemonEvent["kind"], boolean> = {
	activity: false,
	counter: true,
	terminal: true,
};
export const AGENT_RELIABLE_RECEIPT_KIND: Record<AgentDaemonReceipt["kind"], boolean> = {
	accepted: true,
	rejected: false,
	interruptResult: true,
	reconciled: true,
};

/** Reliability tracks outcome impact. */
export function isReliableAgentMessage(message: AgentDaemonEvent | AgentDaemonReceipt): boolean {
	return "requestId" in message ? AGENT_RELIABLE_RECEIPT_KIND[message.kind] : AGENT_RELIABLE_EVENT_KIND[message.kind];
}
