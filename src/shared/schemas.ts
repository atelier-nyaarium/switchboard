import { z } from "zod";

export const BridgeReplySchema = z
	.object({
		session_id: z.string().describe(`The session_id for this request. Required to route the reply correctly.`),
		status: z
			.enum(["running", "completed", "clarification", "deferred", "needs_human"])
			.describe(
				`The outcome or current state of your work. Use "running" for interim progress updates (phase reports, ACKs) and "completed" for the final answer.`,
			),
		replyAsString: z
			.string()
			.optional()
			.describe(`Your text response. Use this for normal replies. Mutually exclusive with replyAsJson.`),
		replyAsJson: z
			.string()
			.optional()
			.describe(
				`A JSON object response. Use when the request specifies a Reply Schema. Pass a valid JSON string matching the schema. Mutually exclusive with replyAsString.`,
			),
		question: z
			.string()
			.optional()
			.describe(`The specific question you need answered. Required when status is clarification.`),
		reason: z.string().optional().describe(`Why you are deferred or need a human. Required for those statuses.`),
		estimated_minutes: z.number().optional().describe(`Estimated minutes until you can handle this. For deferred.`),
		what_to_decide: z
			.string()
			.optional()
			.describe(`The specific decision or approval a human must make. Required for needs_human.`),
	})
	.refine((data) => !(data.replyAsString && data.replyAsJson), {
		message: "Provide replyAsString or replyAsJson, not both.",
	});

export type BridgeReplyArgs = z.infer<typeof BridgeReplySchema>;
