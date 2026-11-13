// A session cut's wire.

import { z } from "zod";

////////////////////////////////
//  Constants

export const CUT_MODES = ["trim", "clear", "compact"] as const;

/** A summary a session hands back. */
export const CUT_SUMMARY_MAX = 96 * 1024;

/** Marks where kept rows end. */
export const CUT_ID_RE = /^cut-[0-9a-f]{16,64}$/;

/** A confirmation's quote of the kept message. */
export const CUT_KEEP_TEXT_MAX = 200;

/** A picked row's whole text. */
export const CUT_ROW_TEXT_MAX = 256 * 1024;

////////////////////////////////
//  Interfaces & Types

/** A turn start by id, or the chat row to find one by. */
export const CutPickSchema = z.union([
	z.object({ uuid: z.string().uuid() }).strict(),
	z.object({ at: z.number().int().nonnegative(), text: z.string().max(CUT_ROW_TEXT_MAX).optional() }).strict(),
]);
export type CutPick = z.infer<typeof CutPickSchema>;

/** Without `build` the op plans and writes nothing. */
export const HostSessionCutOpSchema = z
	.object({
		kind: z.literal("sessionCut"),
		/** Host spawn point whose home holds the session. Absent is the daemon's own. */
		hostSpawn: z.string().min(1).max(64).optional(),
		conversationId: z.string().uuid(),
		mode: z.enum(CUT_MODES),
		pick: CutPickSchema.optional(),
		/** The cut's id: the kept rows end before the request that carried it. */
		endBefore: z.string().regex(CUT_ID_RE).optional(),
		build: z
			.object({
				/** A file finished after it is discarded. */
				deadline: z.number().int().nonnegative(),
				summary: z.string().min(1).max(CUT_SUMMARY_MAX).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();
export type HostSessionCutOp = z.infer<typeof HostSessionCutOpSchema>;

const CutFactsShape = {
	/** The turn start the cut keeps from. Null for a trim. */
	target: z.string().uuid().nullable(),
	keepAt: z.number().int().nonnegative().nullable(),
	keepText: z.string().max(CUT_KEEP_TEXT_MAX),
	/** The picked row started no turn; the cut moved up to one that did. */
	snapped: z.boolean(),
	keptRows: z.number().int().nonnegative(),
	foldedRows: z.number().int().nonnegative(),
	keptBytes: z.number().int().nonnegative(),
	sourceBytes: z.number().int().nonnegative(),
};

export const HostSessionCutResultSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("refused"), reason: z.string().min(1).max(64), detail: z.string().max(512) }).strict(),
	z.object({ kind: z.literal("planned"), ...CutFactsShape }).strict(),
	z.object({ kind: z.literal("built"), conversationId: z.string().uuid(), ...CutFactsShape }).strict(),
]);
export type HostSessionCutResult = z.infer<typeof HostSessionCutResultSchema>;
export type CutFacts = Omit<Extract<HostSessionCutResult, { kind: "planned" }>, "kind">;

/** Unplanned carries `reason` and `detail` and no facts. */
export const ConsoleSessionCutPlanResultSchema = z
	.object({
		planned: z.boolean(),
		reason: z.string().optional(),
		detail: z.string().optional(),
		keepAt: z.number().int().nonnegative().optional(),
		keepText: z.string().optional(),
		snapped: z.boolean().optional(),
		keptRows: z.number().int().nonnegative().optional(),
		foldedRows: z.number().int().nonnegative().optional(),
		keptBytes: z.number().int().nonnegative().optional(),
		sourceBytes: z.number().int().nonnegative().optional(),
	})
	.meta({ id: "ConsoleSessionCutPlanResult" });
export type ConsoleSessionCutPlanResult = z.infer<typeof ConsoleSessionCutPlanResultSchema>;

/** `started`: the cut runs on; its end arrives as a notice in the thread. */
export const ConsoleSessionCutStartResultSchema = z
	.object({
		started: z.boolean(),
		reason: z.string().optional(),
		detail: z.string().optional(),
	})
	.meta({ id: "ConsoleSessionCutStartResult" });
export type ConsoleSessionCutStartResult = z.infer<typeof ConsoleSessionCutStartResultSchema>;

export const SessionCutSummaryRequestShape = {
	cutId: z.string().regex(CUT_ID_RE).describe(`The \`cutId\` from the request.`),
	summary: z
		.string()
		.min(1)
		.max(CUT_SUMMARY_MAX)
		.describe(`What replaces everything before the kept message. Markdown.`),
};

export const SessionCutSummaryAnswerSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("taken") }),
	/** No cut under that id waits on this session. */
	z.object({ kind: z.literal("unknown_cut") }),
	z.object({ kind: z.literal("unauthenticated") }),
]);
export type SessionCutSummaryAnswer = z.infer<typeof SessionCutSummaryAnswerSchema>;
