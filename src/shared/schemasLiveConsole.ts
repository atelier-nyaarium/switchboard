import { z } from "zod";
import { CONSOLE_SOURCE_MAX } from "./live-console-grammar.js";

export const CONSOLE_LIMIT_MAX = 500;

/** Covers two beacon intervals. */
export const CONSOLE_LISTEN_DEFAULT_S = 120;
/** Below 255-second idle cut. */
export const CONSOLE_LISTEN_MAX_S = 180;
/** Relay timeout margin. */
export const CONSOLE_LISTEN_MARGIN_MS = 15_000;

export const LiveConsoleRequestShape = {
	expr: z
		.string()
		.max(CONSOLE_SOURCE_MAX)
		.optional()
		.describe("An expression to read. Omit it to list every entity and member."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(CONSOLE_LIMIT_MAX)
		.optional()
		.describe("How many items of a list to show. Default 50."),
};

const IssueSchema = z.object({
	code: z.string(),
	start: z.number().int(),
	end: z.number().int(),
	message: z.string(),
});

export const LiveConsoleAnswerSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("ok"),
		text: z.string(),
		registryHash: z.string(),
		cut: z.object({ shown: z.number().int(), total: z.number().int() }).optional(),
	}),
	z.object({ kind: z.literal("error"), text: z.string(), issue: IssueSchema }),
	z.object({ kind: z.literal("unauthenticated") }),
	z.object({ kind: z.literal("not_served") }),
]);

export type LiveConsoleAnswer = z.infer<typeof LiveConsoleAnswerSchema>;
