// The assistant's inbox as its session reads it: a flush, then a confirm of what was read.

import { z } from "zod";
import { RULE_ACTIONS } from "./schemasAssistantRules.js";
import { oneLine } from "./system-reminder.js";

export const InboxFlushRequestShape = {
	/** Absent reads every watcher. */
	watchers: z.array(z.string().min(1).max(64)).max(32).optional(),
};

const InboxEventWireSchema = z.object({
	watcherId: z.string(),
	label: z.string(),
	title: z.string(),
	url: z.string().optional(),
	fields: z.record(z.string(), z.string()),
	receivedAt: z.number(),
	action: z.enum(RULE_ACTIONS),
	ping: z.boolean(),
});

export type InboxEventWire = z.infer<typeof InboxEventWireSchema>;

/** Per watcher, the highest seq the flush read. */
export const InboxBoundariesSchema = z.record(z.string(), z.number().int().nonnegative());

export const InboxFlushAnswerSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("events"),
		events: z.array(InboxEventWireSchema),
		boundaries: InboxBoundariesSchema,
		/** Unread rows lost to the cap or to age, per watcher. */
		evicted: z.record(z.string(), z.number().int().nonnegative()),
	}),
	z.object({ kind: z.literal("not_assistant") }),
	z.object({ kind: z.literal("unauthenticated") }),
]);

export type InboxFlushAnswer = z.infer<typeof InboxFlushAnswerSchema>;

export const ASSISTANT_INBOX_CONFIRM_PATH = "/assistant/inbox/confirm";

export const InboxConfirmRequestSchema = z.object({ boundaries: InboxBoundariesSchema });

export const InboxConfirmAnswerSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("confirmed") }),
	/** The write did not land; the same events come back on the next flush. */
	z.object({ kind: z.literal("unsaved") }),
	z.object({ kind: z.literal("not_assistant") }),
	z.object({ kind: z.literal("unauthenticated") }),
]);

export type InboxConfirmAnswer = z.infer<typeof InboxConfirmAnswerSchema>;

/** One event as data lines, the same in a wake and in the inbox. */
export function eventLines(event: Pick<InboxEventWire, "label" | "title" | "url" | "fields" | "ping">): string[] {
	return [
		`watcher: ${oneLine(event.label)}`,
		`ping: ${event.ping ? "yes" : "no"}`,
		`title: ${oneLine(event.title)}`,
		...(event.url === undefined ? [] : [`url: ${oneLine(event.url)}`]),
		...Object.entries(event.fields)
			.filter(([field]) => field !== "title")
			.map(([field, value]) => `${oneLine(field)}: ${oneLine(value)}`),
	];
}
