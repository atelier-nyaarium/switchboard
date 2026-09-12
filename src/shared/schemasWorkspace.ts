// What a workspace read answers, as wire truth.
//
// Zod rather than plain interfaces because the phone is one of the readers, so `.meta({id})` names the
// generated Kotlin classes. The plane's Gateway-to-plugin half reads these same types.

import { z } from "zod";

export const TreeEntrySchema = z
	.object({
		name: z.string().min(1).max(255),
		directory: z.boolean(),
		/** A directory carries a child count instead. */
		bytes: z.number().int().nonnegative().optional(),
		children: z.number().int().nonnegative().optional(),
	})
	.meta({ id: "WorkspaceTreeEntry" });

export const TreeAnswerSchema = z
	.object({
		kind: z.literal("tree"),
		/** Empty is the workspace root. */
		path: z.string().max(512),
		entries: z.array(TreeEntrySchema).max(1_000),
		/** The phone says so rather than implying the end. */
		truncated: z.boolean(),
	})
	.meta({ id: "WorkspaceTreeAnswer" });

export const ReadAnswerSchema = z
	.object({
		kind: z.literal("read"),
		path: z.string().max(512),
		text: z.string(),
		lines: z.number().int().nonnegative(),
	})
	.meta({ id: "WorkspaceReadAnswer" });

export const OutlineSymbolSchema = z
	.object({
		symbolId: z.string().min(1).max(1024),
		name: z.string().max(512),
		symbolKind: z.string().max(64),
		/** Absent at the top level; the phone nests by it. */
		containerId: z.string().max(1024).optional(),
		signature: z.string().max(1024).optional(),
		startLine: z.number().int().positive().optional(),
	})
	.meta({ id: "WorkspaceOutlineSymbol" });

export const OutlineAnswerSchema = z
	.object({
		kind: z.literal("outline"),
		path: z.string().max(512),
		symbols: z.array(OutlineSymbolSchema).max(5_000),
	})
	.meta({ id: "WorkspaceOutlineAnswer" });

export const SymbolSourceAnswerSchema = z
	.object({
		kind: z.literal("symbolSource"),
		symbolId: z.string().min(1).max(1024),
		module: z.string().max(512),
		name: z.string().max(512),
		text: z.string(),
		startLine: z.number().int().positive(),
		endLine: z.number().int().positive(),
		/** Of the SPAN, so an edit elsewhere does not invalidate a window. */
		spanHash: z.string().min(1).max(128),
	})
	.meta({ id: "WorkspaceSymbolSourceAnswer" });

export const KnowledgeAnswerSchema = z
	.object({
		kind: z.literal("symbolKnowledge"),
		symbolId: z.string().min(1).max(1024),
		/** Opaque to the phone. */
		text: z.string(),
	})
	.meta({ id: "WorkspaceKnowledgeAnswer" });

export const WorkspaceOpAnswerSchema = z.discriminatedUnion("kind", [
	TreeAnswerSchema,
	ReadAnswerSchema,
	OutlineAnswerSchema,
	SymbolSourceAnswerSchema,
	KnowledgeAnswerSchema,
]);

export type TreeEntry = z.infer<typeof TreeEntrySchema>;
export type TreeAnswer = z.infer<typeof TreeAnswerSchema>;
export type ReadAnswer = z.infer<typeof ReadAnswerSchema>;
export type OutlineSymbol = z.infer<typeof OutlineSymbolSchema>;
export type OutlineAnswer = z.infer<typeof OutlineAnswerSchema>;
export type SymbolSourceAnswer = z.infer<typeof SymbolSourceAnswerSchema>;
export type KnowledgeAnswer = z.infer<typeof KnowledgeAnswerSchema>;
export type WorkspaceOpAnswer = z.infer<typeof WorkspaceOpAnswerSchema>;
