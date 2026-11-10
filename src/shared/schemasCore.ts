import { z } from "zod";
import {
	NoticeFull,
	NoticeFullSpoken,
	NoticeSummary,
	type NoticeTierWire,
	NoticeTitle,
	SPOKEN_TIER_FIELDS,
} from "./notice.js";

////////////////////////////////
//  Shared enum schemas
//
//  Closed enums validate what our side composes; console-decoded fields stay open strings.

export const ConnectionModeSchema = z.enum(["channel"]).meta({ id: "ConnectionMode" });
export const TeamKindSchema = z.enum(["devcontainer", "loose", "console"]).meta({ id: "TeamKind" });
export const ResponseStatusSchema = z
	.enum(["completed", "clarification", "deferred", "needs_human", "error", "timeout", "running", "starting"])
	.meta({ id: "ResponseStatus" });
// `pending` reaches the app via the blob's `pendingTenant`, never a register reply.
export const DomainStatusSchema = z.enum(["unrooted", "pending", "rooted"]).meta({ id: "DomainStatus" });

////////////////////////////////
//  Channel Reply Schemas
//  A conversation stays open, so there is no status.

/** The escaped-newline guard's always-visible half; the `\\n` spelling shows two characters. */
export const REAL_NEWLINES_GUIDANCE = ` Use REAL newlines for line breaks, not \\n. Wrap intentional escapes in backticks or code spans.`;

/** The four notice tiers as the reply tools expose them: canonical texts verbatim plus the newline guidance. */
export const GuidedNoticeTiers = {
	title: NoticeTitle.describe(`${NoticeTitle.description}${REAL_NEWLINES_GUIDANCE}`),
	summary: NoticeSummary.describe(`${NoticeSummary.description}${REAL_NEWLINES_GUIDANCE}`),
	full: NoticeFull.describe(`${NoticeFull.description}${REAL_NEWLINES_GUIDANCE}`),
	fullSpoken: NoticeFullSpoken.describe(`${NoticeFullSpoken.description}${REAL_NEWLINES_GUIDANCE}`),
};

const FULL_ONLY = ` Omit when the tag's \`instructions\` say another session reads the reply.`;

/** A session reads `full` alone, so the spoken trio is optional here. */
const ReplyTiers = {
	...GuidedNoticeTiers,
	...(Object.fromEntries(
		SPOKEN_TIER_FIELDS.map((field) => [
			field,
			GuidedNoticeTiers[field].optional().describe(`${GuidedNoticeTiers[field].description}${FULL_ONLY}`),
		]),
	) as Record<keyof NoticeTierWire, z.ZodOptional<z.ZodString>>),
};

export const ChannelReplySchema = z
	.object({
		session_id: z.string().describe(`The session_id for this request. Required to route the reply correctly.`),
		...ReplyTiers,
		attachments: z
			.array(z.string())
			.optional()
			.describe(
				`Optional absolute file paths to attach to this reply (e.g. screenshots, logs). Images render inline on the console; other files appear as download chips. A self-contained .html file whose FIRST line is a "<!-- @dsCard group=... -->" comment is a design canvas: the console's Designer dock (a toggleable plugin) collects such cards per conversation for full-screen review. Card identity is the filename (re-attach the same filename to update a canvas in place), so name cards distinctly, e.g. "editor-form.html".`,
			),
	})
	.strict();

export type ChannelReplyArgs = z.infer<typeof ChannelReplySchema>;

// FIXME: validate against a real schema.
export const ChannelReplyStructuredSchema = z
	.object({
		session_id: z.string().describe(`The session_id for this request. Required to route the reply correctly.`),
		responseData: z
			.record(z.string(), z.unknown())
			.describe(
				`Reply to a request that carried a reply_schema (e.g. the bridge handshake). A native object matching that schema.`,
			),
	})
	.strict();

export type ChannelReplyStructuredArgs = z.infer<typeof ChannelReplyStructuredSchema>;
