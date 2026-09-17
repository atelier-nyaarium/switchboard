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
		/** Absent for a folder, a large file, or bytes that are not text. */
		lines: z.number().int().positive().optional(),
	})
	.meta({ id: "WorkspaceTreeEntry" });

export const TreeAnswerSchema = z
	.object({
		kind: z.literal("tree"),
		/** Empty is the workspace root. */
		path: z.string().max(512),
		// Required from 2026-09-27, once plugins before 8.11 are gone.
		/** The workspace root, home as `~`. */
		root: z.string().max(4096).optional(),
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
		/** Absent for a large file. */
		lines: z.number().int().positive().optional(),
		// Required from 2026-09-27, once plugins before 8.11 are gone.
		/** The workspace root, home as `~`. */
		root: z.string().max(4096).optional(),
	})
	.meta({ id: "WorkspaceOutlineAnswer" });

/** Append only: index order is a wire contract with the phone and fixtures. */
export const CODE_TOKENS = [
	"keyword",
	"type",
	"function",
	"builtin",
	"string",
	"escape",
	"interpolation",
	"regexp",
	"number",
	"literal",
	"comment",
	"doctag",
	"meta",
	"attribute",
	"property",
	"variable",
	"params",
	"operator",
	"punctuation",
	"tag",
	"name",
	"selector",
	"section",
	"bullet",
	"emphasis",
	"strong",
	"addition",
	"deletion",
	"link",
	"quote",
	"code",
] as const;

/** Per line: flat `[start, length, token]` triples, UTF-16 units. */
export const LineSpansSchema = z
	.array(z.number().int().nonnegative())
	.refine((triples) => triples.length % 3 === 0, "spans come in triples");

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
		/** The enclosing declaration's name; absent at the top level. */
		container: z.string().max(512).optional(),
		/** Per line of `text`; unhighlighted absent. */
		spans: z.array(LineSpansSchema).optional(),
	})
	.meta({ id: "WorkspaceSymbolSourceAnswer" });

export const KnowledgeEntrySchema = z
	.object({
		question: z.enum(["describe", "why", "relate", "contract", "effects", "usage"]),
		/** Absent: not recorded. */
		prose: z.string().optional(),
		/** Cites nothing beyond the declaration. */
		thin: z.boolean().optional(),
		/** A cited fact moved. */
		stale: z.boolean().optional(),
		doubted: z.boolean().optional(),
		/** Its subject no longer resolves. */
		stranded: z.boolean().optional(),
	})
	.meta({ id: "WorkspaceKnowledgeEntry" });

/** Drill-in counts, withheld rows excluded. */
export const KnowledgeCountsSchema = z
	.object({
		uses: z.number().int().nonnegative(),
		/** Files holding a use. */
		useFiles: z.number().int().nonnegative(),
		/** Top-level declarations holding a use. */
		dependents: z.number().int().nonnegative(),
		/** Files with a module-level use. */
		dependentFiles: z.number().int().nonnegative(),
		/** Target names; unresolved grouped by spelling. */
		targets: z.number().int().nonnegative(),
		/** Bound subset of `targets`. */
		boundTargets: z.number().int().nonnegative(),
		/** References written inside it. */
		references: z.number().int().nonnegative(),
		/** Declared members. */
		members: z.number().int().nonnegative(),
		supertypes: z.number().int().nonnegative(),
		subtypes: z.number().int().nonnegative(),
		/** Its members' and locals' included. */
		comments: z.number().int().nonnegative(),
	})
	.meta({ id: "WorkspaceKnowledgeCounts" });

export const KnowledgeFactsSchema = z
	.object({
		members: z.number().int().nonnegative(),
		references: z.number().int().nonnegative(),
		fanIn: z.number().int().nonnegative(),
		fanOut: z.number().int().nonnegative(),
		supertypes: z.number().int().nonnegative(),
		subtypes: z.number().int().nonnegative(),
		comments: z.number().int().nonnegative(),
		/** Absent from an older Lexicon. */
		counts: KnowledgeCountsSchema.optional(),
	})
	.meta({ id: "WorkspaceKnowledgeFacts" });

export const KnowledgeAnswerSchema = z
	.object({
		kind: z.literal("symbolKnowledge"),
		symbolId: z.string().min(1).max(1024),
		// These five required from 2026-09-27, once plugins before 8.11 are gone.
		name: z.string().max(512).optional(),
		symbolKind: z.string().max(64).optional(),
		module: z.string().max(512).optional(),
		answers: z.array(KnowledgeEntrySchema).max(16).optional(),
		facts: KnowledgeFactsSchema.optional(),
		startLine: z.number().int().positive().optional(),
		endLine: z.number().int().positive().optional(),
		signature: z.string().optional(),
		documentation: z.string().optional(),
		// Remove 2026-09-27: phones before this build require it and draw nothing else.
		text: z.string().optional(),
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

const HashSchema = z.string().min(1).max(128);

/** The inode behind a name, which identical bytes in a recreated file do not share. */
const IdentitySchema = z.string().min(1).max(128);

const MutationPathSchema = z.string().min(1).max(512);

export const FileStateAnswerSchema = z
	.object({
		kind: z.literal("fileState"),
		path: z.string().max(512),
		state: z.enum(["absent", "file", "directory"]),
		bytes: z.number().int().nonnegative().optional(),
		/** Absent for a directory, or a file too large to hash. */
		hash: HashSchema.optional(),
		identity: IdentitySchema.optional(),
	})
	.meta({ id: "WorkspaceFileStateAnswer" });

/** What a move or copy expects at its destination. `replace` is the explicit overwrite. */
export const FileDestinationSchema = z
	.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("absent") }),
		z.strictObject({ kind: z.literal("replace"), expectedHash: HashSchema, expectedIdentity: IdentitySchema }),
	])
	.meta({ id: "WorkspaceFileDestination" });

/**
 * Plain file work, never through Lexicon. Each kind carries its own preconditions, since a content hash alone
 * binds no file: a delete or move could act on a recreated file with identical bytes.
 *
 * Strict, so a reader that does not know a precondition refuses the mutation rather than stripping it.
 */
export const FileMutationSchema = z
	.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("write"),
			path: MutationPathSchema,
			/** Hash shown to the owner. */
			expectedHash: HashSchema,
			text: z.string().max(4_000_000),
		}),
		/** Only where nothing is. */
		z.strictObject({ kind: z.literal("create"), path: MutationPathSchema, text: z.string().max(4_000_000) }),
		z.strictObject({
			kind: z.literal("delete"),
			path: MutationPathSchema,
			expectedHash: HashSchema,
			expectedIdentity: IdentitySchema,
		}),
		z.strictObject({
			kind: z.literal("move"),
			path: MutationPathSchema,
			expectedHash: HashSchema,
			expectedIdentity: IdentitySchema,
			to: MutationPathSchema,
			destination: FileDestinationSchema,
		}),
		z.strictObject({
			kind: z.literal("copy"),
			path: MutationPathSchema,
			expectedHash: HashSchema,
			to: MutationPathSchema,
			destination: FileDestinationSchema,
		}),
	])
	.meta({ id: "WorkspaceFileMutation" });

export const FileMutationAnswerSchema = z
	.object({
		kind: z.literal("mutateFile"),
		path: z.string().max(512),
		/**
		 * `stale`: the source no longer holds what the mutation named. `destinationChanged`: the destination is
		 * not in the state it named. Neither wrote anything. `unknown`: it may have landed, so the phone reads
		 * back. An outcome a phone does not know reads as unknown.
		 */
		outcome: z.enum(["done", "stale", "destinationChanged", "unknown"]),
		/** The file the mutation leaves: at `path` for a write or create, at the destination for a move or copy. */
		hash: HashSchema.optional(),
		/** Stale because the source is not there. */
		gone: z.boolean().optional(),
		reason: z.string().max(2048).optional(),
	})
	.meta({ id: "WorkspaceFileMutationAnswer" });

const SymbolIdSchema = z.string().min(1).max(1024);

const LineSchema = z.number().int().positive();

/** Strict, so an unknown facet refuses. */
export const SymbolFacetSchema = z
	.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("uses") }),
		z.strictObject({ kind: z.literal("usesFrom") }),
		z.strictObject({ kind: z.literal("members") }),
		z.strictObject({ kind: z.literal("hierarchy") }),
		z.strictObject({ kind: z.literal("comments") }),
		z.strictObject({ kind: z.literal("history") }),
	])
	// Not `WorkspaceSymbolFacet`: `ConsoleOp`'s member would shadow it.
	.meta({ id: "WorkspaceFacet" });

/** What an Ask covers. A file takes everything in it. */
export const KnowledgeScopeTargetSchema = z
	.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("symbol"), symbolId: SymbolIdSchema }),
		z.strictObject({ kind: z.literal("members"), symbolId: SymbolIdSchema }),
		z.strictObject({ kind: z.literal("file"), path: MutationPathSchema }),
	])
	.meta({ id: "WorkspaceKnowledgeScopeTarget" });

/** A declaration a row names. */
export const FacetSymbolSchema = z
	.object({
		symbolId: SymbolIdSchema,
		name: z.string().max(512),
		symbolKind: z.string().max(64),
		module: z.string().max(512),
		startLine: LineSchema.optional(),
		endLine: LineSchema.optional(),
		signature: z.string().max(4096).optional(),
		/** Per signature line, members only. */
		signatureSpans: z.array(LineSpansSchema).optional(),
	})
	.meta({ id: "WorkspaceFacetSymbol" });

/** One reference, as listed. */
export const FacetUseSchema = z
	.object({
		module: z.string().max(512),
		line: LineSchema,
		/** UTF-16 columns of the name. */
		startColumn: z.number().int().nonnegative(),
		endColumn: z.number().int().nonnegative(),
		/** As written. */
		name: z.string().max(512),
		role: z.string().max(32),
		/** Innermost declaration; absent at module level. */
		holder: FacetSymbolSchema.optional(),
		/** Outermost declaration; absent at module level. */
		topLevel: FacetSymbolSchema.optional(),
		/** Of the use's file. */
		language: z.string().max(64).optional(),
		/** Line, or a window; absent if unreadable. */
		text: z.string().max(4096).optional(),
		/** Column a window starts at. */
		textStart: z.number().int().positive().optional(),
		/** Over `text`; absent when not highlighted. */
		spans: LineSpansSchema.optional(),
	})
	.meta({ id: "WorkspaceFacetUse" });

/** A symbol's references to one target. */
export const FacetTargetSchema = z
	.object({
		/** Keys an unresolved name. */
		name: z.string().max(512),
		/** `bound`, `ambiguous` or `unbound`. */
		status: z.string().max(32),
		/** Absent unless bound. */
		target: FacetSymbolSchema.optional(),
		/** Why not bound. */
		reason: z.string().max(64).optional(),
		uses: z.array(FacetUseSchema),
	})
	.meta({ id: "WorkspaceFacetTarget" });

export const FacetTypeSchema = z
	.object({
		symbol: FacetSymbolSchema,
		/** `extends` or `implements`. */
		role: z.string().max(32).optional(),
	})
	.meta({ id: "WorkspaceFacetType" });

export const FacetUnboundTypeSchema = z
	.object({ name: z.string().max(512), role: z.string().max(32).optional() })
	.meta({ id: "WorkspaceFacetUnboundType" });

export const FacetCommentSchema = z
	.object({
		/** Markers stripped, wrapping joined. */
		text: z.string(),
		form: z.string().max(32),
		line: LineSchema,
		/** Nearest non-local declaration. */
		holder: FacetSymbolSchema.optional(),
	})
	.meta({ id: "WorkspaceFacetComment" });

export const HistoryCommitSchema = z
	.object({
		hash: z.string().min(1).max(64),
		/** Author time, unix seconds. */
		at: z.number().int(),
		author: z.string().max(512).optional(),
		subject: z.string().max(4096),
		added: z.number().int().nonnegative(),
		removed: z.number().int().nonnegative(),
	})
	.meta({ id: "WorkspaceHistoryCommit" });

/** Rows left without spans. */
const PlainSchema = z.number().int().nonnegative();

/** `none`: tracked, no touching commit. */
const HistoryOutcomeSchema = z.enum(["commits", "untracked", "notRepository", "none"]);

export const FacetAnswerSchema = z
	.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("uses"),
			rows: z.array(FacetUseSchema),
			uses: z.number().int().nonnegative(),
			plain: PlainSchema,
		}),
		z.object({
			kind: z.literal("usesFrom"),
			targets: z.array(FacetTargetSchema),
			/** Groups, unresolved names by spelling. */
			targetCount: z.number().int().nonnegative(),
			references: z.number().int().nonnegative(),
			plain: PlainSchema,
		}),
		z.object({
			kind: z.literal("members"),
			members: z.array(FacetSymbolSchema),
			plain: PlainSchema,
		}),
		z.object({
			kind: z.literal("hierarchy"),
			/** Symbol itself, for the self node. */
			subject: FacetSymbolSchema,
			/** Direct. */
			supertypes: z.array(FacetTypeSchema),
			/** Above the direct ones, nearest first. */
			ancestors: z.array(FacetSymbolSchema),
			unbound: z.array(FacetUnboundTypeSchema),
			/** Direct. */
			subtypes: z.array(FacetTypeSchema),
			/** Direct, further and unbound. */
			supertypeCount: z.number().int().nonnegative(),
			subtypeCount: z.number().int().nonnegative(),
		}),
		z.object({
			kind: z.literal("comments"),
			comments: z.array(FacetCommentSchema),
			/** Own documentation excluded; floor is `comments.length`. */
			total: z.number().int().nonnegative(),
			/** Lexicon's page was capped. */
			truncated: z.boolean().optional(),
		}),
		z.object({
			kind: z.literal("history"),
			outcome: HistoryOutcomeSchema,
			module: z.string().max(512),
			startLine: LineSchema,
			endLine: LineSchema,
			commits: z.array(HistoryCommitSchema),
			/** Stopped at the commit bound. */
			truncated: z.boolean(),
		}),
	])
	.meta({ id: "WorkspaceFacetAnswer" });

export const SymbolFacetAnswerSchema = z
	.object({
		kind: z.literal("symbolFacet"),
		symbolId: SymbolIdSchema,
		facet: FacetAnswerSchema,
	})
	.meta({ id: "WorkspaceSymbolFacetAnswer" });

export const FileHistoryAnswerSchema = z
	.object({
		kind: z.literal("fileHistory"),
		path: z.string().max(512),
		outcome: HistoryOutcomeSchema,
		/** Newest first, a page. */
		commits: z.array(HistoryCommitSchema),
		/** Within Lexicon's history window. */
		count: z.number().int().nonnegative(),
		added: z.number().int().nonnegative(),
		removed: z.number().int().nonnegative(),
		/** Author time, unix seconds. */
		firstSeen: z.number().int().optional(),
		lastTouched: z.number().int().optional(),
		/** `firstSeen` is a floor. */
		truncated: z.boolean(),
	})
	.meta({ id: "WorkspaceFileHistoryAnswer" });

export const ScopeQuestionSchema = z
	.object({
		question: KnowledgeEntrySchema.shape.question,
		/** Absent: not recorded. */
		createdAt: z.number().optional(),
		thin: z.boolean().optional(),
		/** Its own citations moved. */
		stale: z.boolean().optional(),
		/** Cites a stale or doubted answer. */
		shaky: z.boolean().optional(),
		doubted: z.boolean().optional(),
		askCount: z.number().int().nonnegative(),
	})
	.meta({ id: "WorkspaceScopeQuestion" });

export const ScopeSymbolSchema = z
	.object({
		symbolId: SymbolIdSchema,
		name: z.string().max(512),
		symbolKind: z.string().max(64),
		/** 0 for the named symbol or file top. */
		depth: z.number().int().nonnegative(),
		startLine: LineSchema.optional(),
		containerId: SymbolIdSchema.optional(),
		questions: z.array(ScopeQuestionSchema).max(16),
	})
	.meta({ id: "WorkspaceScopeSymbol" });

export const KnowledgeScopeAnswerSchema = z
	.object({
		kind: z.literal("knowledgeScope"),
		/** Root, `~` for home; flags a rebound workspace. */
		root: z.string().max(4096),
		module: z.string().max(512),
		/** Members before the declaration holding them. */
		symbols: z.array(ScopeSymbolSchema),
		/** Parameters and locals left out. */
		localsExcluded: z.number().int().nonnegative(),
	})
	.meta({ id: "WorkspaceKnowledgeScopeAnswer" });

/** Listing over cap, refused whole. */
export const TooLargeAnswerSchema = z
	.object({
		kind: z.literal("tooLarge"),
		/** Counted in the listing's unit. */
		rows: z.number().int().nonnegative(),
		/** Absent unless every row was read. */
		bytes: z.number().int().nonnegative().optional(),
	})
	.meta({ id: "WorkspaceTooLargeAnswer" });

export const WorkspaceOpAnswerSchema = z.discriminatedUnion("kind", [
	TreeAnswerSchema,
	ReadAnswerSchema,
	OutlineAnswerSchema,
	SymbolSourceAnswerSchema,
	KnowledgeAnswerSchema,
	SaveSpanAnswerSchema,
	FileMutationAnswerSchema,
	FileStateAnswerSchema,
	SymbolFacetAnswerSchema,
	FileHistoryAnswerSchema,
	KnowledgeScopeAnswerSchema,
	TooLargeAnswerSchema,
]);

export type TreeEntry = z.infer<typeof TreeEntrySchema>;
export type TreeAnswer = z.infer<typeof TreeAnswerSchema>;
export type ReadAnswer = z.infer<typeof ReadAnswerSchema>;
export type OutlineSymbol = z.infer<typeof OutlineSymbolSchema>;
export type OutlineAnswer = z.infer<typeof OutlineAnswerSchema>;
export type SymbolSourceAnswer = z.infer<typeof SymbolSourceAnswerSchema>;
export type KnowledgeAnswer = z.infer<typeof KnowledgeAnswerSchema>;
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;
export type SaveSpanAnswer = z.infer<typeof SaveSpanAnswerSchema>;
export type FileMutation = z.infer<typeof FileMutationSchema>;
export type FileMutationAnswer = z.infer<typeof FileMutationAnswerSchema>;
export type FileStateAnswer = z.infer<typeof FileStateAnswerSchema>;
export type FileDestination = z.infer<typeof FileDestinationSchema>;
export type KnowledgeCounts = z.infer<typeof KnowledgeCountsSchema>;
export type SymbolFacet = z.infer<typeof SymbolFacetSchema>;
export type KnowledgeScopeTarget = z.infer<typeof KnowledgeScopeTargetSchema>;
export type FacetSymbol = z.infer<typeof FacetSymbolSchema>;
export type FacetUse = z.infer<typeof FacetUseSchema>;
export type FacetTarget = z.infer<typeof FacetTargetSchema>;
export type FacetType = z.infer<typeof FacetTypeSchema>;
export type FacetComment = z.infer<typeof FacetCommentSchema>;
export type HistoryCommit = z.infer<typeof HistoryCommitSchema>;
export type FacetAnswer = z.infer<typeof FacetAnswerSchema>;
export type SymbolFacetAnswer = z.infer<typeof SymbolFacetAnswerSchema>;
export type FileHistoryAnswer = z.infer<typeof FileHistoryAnswerSchema>;
export type ScopeSymbol = z.infer<typeof ScopeSymbolSchema>;
export type KnowledgeScopeAnswer = z.infer<typeof KnowledgeScopeAnswerSchema>;
export type TooLargeAnswer = z.infer<typeof TooLargeAnswerSchema>;
export type WorkspaceOpAnswer = z.infer<typeof WorkspaceOpAnswerSchema>;
