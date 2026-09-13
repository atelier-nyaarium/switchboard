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
		/** Of the bytes on disk, which a write names. Absent when the text cannot be written back. */
		hash: z.string().min(1).max(128).optional(),
		/** Why no write is offered. */
		readOnly: z.string().max(512).optional(),
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

/** What a save broke, as Lexicon reports it. */
export const SaveIssueSchema = z
	.object({
		kind: z.string().max(64),
		detail: z.string().max(2048),
		module: z.string().max(512).optional(),
		line: z.number().int().nonnegative().optional(),
	})
	.meta({ id: "WorkspaceSaveIssue" });

export const SaveSpanAnswerSchema = z
	.object({
		kind: z.literal("saveSpan"),
		symbolId: z.string().min(1).max(1024),
		/**
		 * `stale`: the span no longer holds the text the save was written against. `rejected`: Lexicon
		 * refused the text, with `reason`. `unknown`: the save may have landed, so the phone reads the span
		 * back. An outcome a phone does not know reads as unknown.
		 */
		outcome: z.enum(["saved", "stale", "rejected", "unknown"]),
		/** The span as it stands after the attempt. Absent when it could not be read back. */
		current: SymbolSourceAnswerSchema.optional(),
		/** The span no longer resolves, as opposed to a read back that failed. */
		gone: z.boolean().optional(),
		/** Saved into a transaction another session opened, which can still undo it. */
		joined: z.boolean().optional(),
		issues: z.array(SaveIssueSchema).max(64).optional(),
		reason: z.string().max(2048).optional(),
	})
	.meta({ id: "WorkspaceSaveSpanAnswer" });

/**
 * Plain file work, never through Lexicon. Each kind carries its own preconditions.
 *
 * Strict, so a reader that does not know a precondition refuses the mutation rather than stripping it.
 */
export const FileMutationSchema = z
	.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("write"),
			path: z.string().min(1).max(512),
			/** Hash shown to the owner. */
			expectedHash: z.string().min(1).max(128),
			text: z.string().max(4_000_000),
		}),
	])
	.meta({ id: "WorkspaceFileMutation" });

export const FileMutationAnswerSchema = z
	.object({
		kind: z.literal("mutateFile"),
		path: z.string().max(512),
		/**
		 * `stale`: the file no longer holds what the mutation named, so nothing was written. `unknown`: it may
		 * have landed, so the phone reads back. An outcome a phone does not know reads as unknown.
		 */
		outcome: z.enum(["done", "stale", "unknown"]),
		/** Hash after write. */
		hash: z.string().min(1).max(128).optional(),
		/** Stale because absent. */
		gone: z.boolean().optional(),
		reason: z.string().max(2048).optional(),
	})
	.meta({ id: "WorkspaceFileMutationAnswer" });

export const WorkspaceOpAnswerSchema = z.discriminatedUnion("kind", [
	TreeAnswerSchema,
	ReadAnswerSchema,
	OutlineAnswerSchema,
	SymbolSourceAnswerSchema,
	KnowledgeAnswerSchema,
	SaveSpanAnswerSchema,
	FileMutationAnswerSchema,
]);

export type TreeEntry = z.infer<typeof TreeEntrySchema>;
export type TreeAnswer = z.infer<typeof TreeAnswerSchema>;
export type ReadAnswer = z.infer<typeof ReadAnswerSchema>;
export type OutlineSymbol = z.infer<typeof OutlineSymbolSchema>;
export type OutlineAnswer = z.infer<typeof OutlineAnswerSchema>;
export type SymbolSourceAnswer = z.infer<typeof SymbolSourceAnswerSchema>;
export type KnowledgeAnswer = z.infer<typeof KnowledgeAnswerSchema>;
export type SaveSpanAnswer = z.infer<typeof SaveSpanAnswerSchema>;
export type FileMutation = z.infer<typeof FileMutationSchema>;
export type FileMutationAnswer = z.infer<typeof FileMutationAnswerSchema>;
export type WorkspaceOpAnswer = z.infer<typeof WorkspaceOpAnswerSchema>;
