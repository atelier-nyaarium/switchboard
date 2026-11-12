// Codex app-server JSONL schemas.
// Accept extra protocol fields.

import { z } from "zod";
import { AgentOpaqueIdSchema as OpaqueIdSchema } from "./agent-identity.js";
import { AgentTurnStateSchema as CodexTurnStateSchema } from "./agent-state.js";

export const CodexAppServerResponseSchema = z
	.looseObject({
		id: z.union([z.string(), z.number()]),
		result: z.unknown().optional(),
		error: z
			.looseObject({
				code: z.number(),
				message: z.string(),
				data: z.unknown().optional(),
			})
			.optional(),
	})
	.superRefine((value, ctx) => {
		if ((value.result === undefined) === (value.error === undefined)) {
			ctx.addIssue({ code: "custom", message: "response requires exactly one of result or error" });
		}
	});

const CodexAppServerThreadIdentitySchema = z.looseObject({ id: OpaqueIdSchema });
const CodexAppServerAgentMessageItemSchema = z.looseObject({
	type: z.literal("agentMessage"),
	id: OpaqueIdSchema,
	text: z.string(),
	phase: z.string().nullish(),
});
const CodexAppServerOtherItemSchema = z
	.looseObject({
		id: OpaqueIdSchema,
		type: z.string().min(1),
	})
	.refine((item) => item.type !== "agentMessage", "agent messages require text");
const CodexAppServerThreadItemProjectionSchema = z.union([
	CodexAppServerAgentMessageItemSchema,
	CodexAppServerOtherItemSchema,
]);
const CodexAppServerTurnProjectionSchema = z.looseObject({
	id: OpaqueIdSchema,
	status: CodexTurnStateSchema,
	items: z.array(CodexAppServerThreadItemProjectionSchema),
});

export const CodexAppServerThreadStartResultSchema = z.looseObject({
	thread: CodexAppServerThreadIdentitySchema,
});
export const CodexAppServerThreadReadResultSchema = z.looseObject({
	thread: z.looseObject({
		id: OpaqueIdSchema,
		turns: z.array(CodexAppServerTurnProjectionSchema),
	}),
});
export const CodexAppServerTurnStartResultSchema = z.looseObject({
	turn: CodexAppServerTurnProjectionSchema.extend({ status: z.literal("inProgress") }),
});

export const CodexAppServerAgentMessageCompletedSchema = z.looseObject({
	method: z.literal("item/completed"),
	params: z.looseObject({
		threadId: OpaqueIdSchema,
		turnId: OpaqueIdSchema,
		item: CodexAppServerAgentMessageItemSchema,
	}),
});

export const CodexAppServerOtherItemCompletedSchema = z.looseObject({
	method: z.literal("item/completed"),
	params: z.looseObject({
		threadId: OpaqueIdSchema,
		turnId: OpaqueIdSchema,
		item: z.looseObject({ id: OpaqueIdSchema, type: z.string().min(1) }),
	}),
});

export const CodexAppServerTurnCompletedSchema = z.looseObject({
	method: z.literal("turn/completed"),
	params: z.looseObject({
		threadId: OpaqueIdSchema,
		turn: z.looseObject({
			id: OpaqueIdSchema,
			status: z.enum(["completed", "failed", "interrupted"]),
			error: z
				.looseObject({
					message: z.string(),
				})
				.nullish(),
		}),
	}),
});

/** Streaming and replay share phase classification; unknown phases stay candidates. */
export function classifyCodexItemPhase(phase: unknown): "answer" | "commentary" | "candidate" {
	if (phase === "final_answer") return "answer";
	if (phase === "commentary") return "commentary";
	return "candidate";
}
