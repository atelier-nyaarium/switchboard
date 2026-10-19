// The assistant's inbox: each watcher's source, listed live.

import { z } from "zod";
import { RULE_ACTIONS } from "./schemasAssistantRules.js";
import { oneLine } from "./system-reminder.js";

export const INBOX_SCOPES = ["new", "all"] as const;

export type InboxScope = (typeof INBOX_SCOPES)[number];

export const InboxListRequestShape = {
	scope: z.enum(INBOX_SCOPES),
	/** From the previous answer. */
	page: z.string().min(1).max(8_192).optional(),
};

const InboxItemSchema = z.strictObject({
	/** The source's id, as its actions take it. */
	id: z.string(),
	title: z.string(),
	url: z.string().optional(),
	fields: z.record(z.string(), z.string()),
	/** Source update time. */
	at: z.number(),
	decision: z.enum(RULE_ACTIONS),
});

export type InboxItem = z.infer<typeof InboxItemSchema>;

const InboxListSchema = z.strictObject({
	label: z.string(),
	items: z.array(InboxItemSchema),
	/** The next page's token. */
	next: z.string().optional(),
	/** Items past the byte cap. */
	cut: z.number().int().positive().optional(),
	error: z.string().optional(),
});

export type InboxList = z.infer<typeof InboxListSchema>;

export const InboxListAnswerSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("listed"), lists: z.array(InboxListSchema) }),
	z.object({ kind: z.literal("not_assistant") }),
	z.object({ kind: z.literal("unauthenticated") }),
]);

export type InboxListAnswer = z.infer<typeof InboxListAnswerSchema>;

/** One event as data lines, the same in a wake and in the inbox. */
export function eventLines(event: {
	label: string;
	id: string;
	title: string;
	url?: string;
	fields: Readonly<Record<string, string>>;
}): string[] {
	return [
		`watcher: ${oneLine(event.label)}`,
		`id: ${oneLine(event.id)}`,
		`title: ${oneLine(event.title)}`,
		...(event.url === undefined ? [] : [`url: ${oneLine(event.url)}`]),
		...Object.entries(event.fields)
			.filter(([field]) => field !== "title")
			.map(([field, value]) => `${oneLine(field)}: ${oneLine(value)}`),
	];
}
