import { z } from "zod";

////////////////////////////////
//  CLI Reply Schema
//
//  CLI-mode replies are one-shot: the request arrives, the agent does work, it
//  replies exactly once with a terminal status. status is required.

export const CliReplySchema = z
	.object({
		session_id: z.string().describe(`The session_id for this request. Required to route the reply correctly.`),
		status: z.enum(["completed", "clarification", "deferred", "needs_human"]).describe(`The outcome of your work.`),
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

export type CliReplyArgs = z.infer<typeof CliReplySchema>;

////////////////////////////////
//  Channel Reply Schema
//
//  Channel-mode conversations are streams: the conversation stays open for the
//  life of the process, and the agent can reply any number of times. There is
//  no status because there is no "end" — every reply is just another message in
//  the stream.

export const ChannelReplySchema = z
	.object({
		session_id: z.string().describe(`The session_id for this request. Required to route the reply correctly.`),
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
	})
	.refine((data) => !(data.replyAsString && data.replyAsJson), {
		message: "Provide replyAsString or replyAsJson, not both.",
	});

export type ChannelReplyArgs = z.infer<typeof ChannelReplySchema>;
