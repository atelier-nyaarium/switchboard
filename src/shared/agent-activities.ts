import { z } from "zod";
import { AgentOpaqueIdSchema } from "./agent-identity.js";
import {
	AGENT_ACTIVITY_MAX_BYTES,
	AGENT_ACTIVITY_MAX_ITEMS,
	agentActivityIssues,
	boundedUtf8,
} from "./agent-record.js";

export const AgentActivitySchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("commentary"),
			text: boundedUtf8(AGENT_ACTIVITY_MAX_BYTES, "activity"),
		})
		.strict(),
	z.object({ kind: z.literal("truncated"), omitted: z.number().int().positive() }).strict(),
]);

/** As stored, each row keeping the item it came from. */
export const AgentStoredActivitySchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("commentary"),
			itemId: AgentOpaqueIdSchema,
			text: boundedUtf8(AGENT_ACTIVITY_MAX_BYTES, "activity"),
		})
		.strict(),
	z.object({ kind: z.literal("truncated"), omitted: z.number().int().positive() }).strict(),
]);

export const AgentActivitiesSchema = z
	.array(AgentActivitySchema)
	.max(AGENT_ACTIVITY_MAX_ITEMS + 1)
	.superRefine((activities, ctx) => {
		for (const message of agentActivityIssues(activities, AGENT_ACTIVITY_MAX_ITEMS)) {
			ctx.addIssue({ code: "custom", message });
		}
	});

export const AgentStoredActivitiesSchema = z
	.array(AgentStoredActivitySchema)
	.max(AGENT_ACTIVITY_MAX_ITEMS + 1)
	.superRefine((activities, ctx) => {
		for (const message of agentActivityIssues(activities, AGENT_ACTIVITY_MAX_ITEMS)) {
			ctx.addIssue({ code: "custom", message });
		}
	});
