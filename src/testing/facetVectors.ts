// One road from a facet vector's input to the plugin's answer, shared by the generator that writes
// the corpus and the suite that replays it.
//
// The answer keeps structure only. A row's columns, its line text and its paint come from the file
// rather than from a rule, and `tests/fixtures/code-spans/vectors.json` already pins the paint.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session } from "@nyaa-lexicon/client";
import { answerWorkspaceOp } from "../mcp/workspace/handlers.js";
import type { FacetAnswer, KnowledgeCounts, SymbolFacet, WorkspaceOpResult } from "../shared/workspace-op.js";

////////////////////////////////
//  Interfaces & Types

export interface FacetModule {
	path: string;
	language: string;
	lines: string[];
}

export interface FacetDeclared {
	id: string;
	name: string;
	kind: string;
	module: string;
	startLine: number;
	endLine: number;
	container?: string;
	signature?: string;
}

export interface FacetUseInput {
	module: string;
	line: number;
	column: number;
	name: string;
	role: string;
	holder?: string;
	topLevel?: string;
	language?: string;
}

export interface FacetTargetInput extends FacetUseInput {
	status: string;
	target?: string;
	reason?: string;
}

export interface FacetCommentInput {
	module: string;
	line: number;
	text: string;
	form: string;
	anchor?: string;
}

/** A role only where a heritage row in `uses` or `targets` gives the plugin the same one. */
export interface FacetTypeNode {
	name: string;
	symbol?: string;
	role?: string;
}

export interface FacetCase {
	name: string;
	modules: FacetModule[];
	symbols: FacetDeclared[];
	subject: string;
	uses?: FacetUseInput[];
	targets?: FacetTargetInput[];
	members?: string[];
	hierarchy?: { supertypes?: FacetTypeNode[]; ancestors?: string[]; subtypes?: FacetTypeNode[] };
	comments?: FacetCommentInput[];
	/** What the index says there are, which the page may be short of. */
	commentTotal?: number;
	commentTruncated?: boolean;
}

interface Row {
	module: string;
	line: number;
	name: string;
	role: string;
	holder: string | null;
	topLevel: string | null;
}

export interface FacetVectorAnswer {
	uses: { rows: Row[]; uses: number; plain: number };
	usesFrom: {
		targets: { name: string; status: string; target: string | null; reason: string | null; uses: Row[] }[];
		targetCount: number;
		references: number;
		plain: number;
	};
	members: { members: string[] };
	hierarchy: {
		subject: string;
		supertypes: { symbol: string; role: string | null }[];
		ancestors: string[];
		unbound: { name: string; role: string | null }[];
		subtypes: { symbol: string; role: string | null }[];
		supertypeCount: number;
		subtypeCount: number;
	};
	comments: {
		comments: { text: string; form: string; line: number; holder: string | null }[];
		total: number;
		truncated: boolean;
	};
	counts: KnowledgeCounts;
}

////////////////////////////////
//  The index a case stands for

const roots: string[] = [];

/** Every temp workspace this process wrote. */
export function removeFacetWorkspaces(): void {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

function workspace(modules: FacetModule[]): string {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "facet-vectors-")));
	roots.push(root);
	for (const module of modules) {
		const file = path.join(root, module.path);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${module.lines.join("\n")}\n`);
	}
	return root;
}

/** Lexicon counts lines from zero. */
function summaryOf(symbol: FacetDeclared) {
	return {
		symbolId: symbol.id,
		name: symbol.name,
		kind: symbol.kind,
		module: symbol.module,
		visibility: "public",
		lines: { start: symbol.startLine - 1, end: symbol.endLine - 1 },
		...(symbol.container === undefined ? {} : { containerId: symbol.container }),
		...(symbol.signature === undefined ? {} : { signature: symbol.signature }),
	};
}

function declarationOf(symbol: FacetDeclared) {
	return {
		symbolId: symbol.id,
		kind: symbol.kind,
		name: symbol.name,
		module: symbol.module,
		range: { start: { line: symbol.startLine - 1, character: 0 }, end: { line: symbol.endLine - 1, character: 1 } },
		visibility: "public",
		...(symbol.signature === undefined ? {} : { signature: symbol.signature }),
	};
}

function referenceOf(use: FacetUseInput, symbols: Map<string, FacetDeclared>) {
	const topLevel = use.topLevel === undefined ? undefined : symbols.get(use.topLevel);
	return {
		factId: `${use.module}:${use.line}:${use.column}`,
		module: use.module,
		name: use.name,
		role: use.role,
		targetId: null,
		fromId: use.holder ?? null,
		provenance: "bound",
		startLine: use.line - 1,
		startCharacter: use.column,
		endLine: use.line - 1,
		endCharacter: use.column + use.name.length,
		...(topLevel === undefined ? {} : { topLevel: summaryOf(topLevel) }),
		language: use.language ?? "typescript",
	};
}

function useFromOf(target: FacetTargetInput, symbols: Map<string, FacetDeclared>) {
	const bound = target.target === undefined ? undefined : symbols.get(target.target);
	return {
		...referenceOf(target, symbols),
		targetId: target.target ?? null,
		status: target.status,
		...(bound === undefined ? {} : { target: summaryOf(bound) }),
		...(target.reason === undefined ? {} : { reason: target.reason }),
	};
}

function commentOf(comment: FacetCommentInput) {
	return {
		factId: `${comment.line}:${comment.text}`,
		module: comment.module,
		range: { start: { line: comment.line - 1, character: 0 }, end: { line: comment.line - 1, character: 4 } },
		form: comment.form,
		placement: comment.form === "leading" ? "above" : "body",
		raw: `// ${comment.text}`,
		anchor:
			comment.anchor === undefined
				? null
				: { symbolId: comment.anchor, name: "n", kind: "method", line: comment.line - 1 },
	};
}

function declaredOf(symbols: Map<string, FacetDeclared>, id: string, at: string): FacetDeclared {
	const found = symbols.get(id);
	if (found === undefined) throw new Error(`${at}: ${id} is not declared`);
	return found;
}

function hierarchyOf(vector: FacetCase, symbols: Map<string, FacetDeclared>) {
	const listed = (ids: (string | undefined)[]) =>
		ids.flatMap((id) => (id === undefined ? [] : [summaryOf(declaredOf(symbols, id, vector.name))]));
	const supertypes = vector.hierarchy?.supertypes ?? [];
	return {
		symbolId: vector.subject,
		supertypes: listed(supertypes.map((type) => type.symbol)),
		ancestors: listed(vector.hierarchy?.ancestors ?? []),
		unboundSupertypes: supertypes.filter((type) => type.symbol === undefined).map((type) => type.name),
		subtypes: listed((vector.hierarchy?.subtypes ?? []).map((type) => type.symbol)),
	};
}

/** Every read the facet handlers make, answered from the case's own rows. */
function sessionOf(vector: FacetCase): () => Promise<Session> {
	const symbols = new Map(vector.symbols.map((symbol) => [symbol.id, symbol]));
	const subject = declaredOf(symbols, vector.subject, `${vector.name} subject`);
	const comments = vector.comments ?? [];
	const uses = (vector.uses ?? []).map((use) => referenceOf(use, symbols));
	const targets = (vector.targets ?? []).map((target) => useFromOf(target, symbols));
	const session = {
		declarationOf: async () => declarationOf(subject),
		describe: async () => ({
			symbol: summaryOf(subject),
			members: (vector.members ?? []).map((id) => summaryOf(declaredOf(symbols, id, `${vector.name} member`))),
			referenceCount: uses.length,
			graph: { symbolId: vector.subject, fanIn: 0, fanOut: 0 },
			hierarchy: hierarchyOf(vector, symbols),
		}),
		recallAnswer: async () => [],
		findReferences: async () => ({
			symbolId: vector.subject,
			references: uses,
			total: uses.length,
			truncated: false,
		}),
		usesFrom: async () => ({
			symbolId: vector.subject,
			references: targets,
			total: targets.length,
			truncated: false,
		}),
		typeHierarchy: async () => hierarchyOf(vector, symbols),
		// The index slices to the asked limit and says there were more, as the daemon does.
		findComments: async ({ limit }: { limit: number }) => ({
			comments: comments.slice(0, limit).map(commentOf),
			total: vector.commentTotal ?? comments.length,
			truncated: vector.commentTruncated ?? comments.length > limit,
		}),
		resolveFacts: async () => ({
			resolved: comments.map((comment) => ({
				fact: "comment",
				factId: `${comment.line}:${comment.text}`,
				normalized: comment.text,
			})),
			missing: [],
		}),
		knowledgeScope: async () => ({
			symbols: vector.symbols.map((symbol) => ({ symbol: summaryOf(symbol), depth: 1, questions: [] })),
			localsExcluded: 0,
		}),
		outlineModule: async ({ module }: { module: string }) =>
			vector.symbols.filter((symbol) => symbol.module === module).map(summaryOf),
	};
	return async () => session as unknown as Session;
}

////////////////////////////////
//  The answer

const rowOf = (use: {
	module: string;
	line: number;
	name: string;
	role: string;
	holder?: { symbolId: string };
	topLevel?: { symbolId: string };
}): Row => ({
	module: use.module,
	line: use.line,
	name: use.name,
	role: use.role,
	holder: use.holder?.symbolId ?? null,
	topLevel: use.topLevel?.symbolId ?? null,
});

function facetOf(result: WorkspaceOpResult, at: string): FacetAnswer {
	if (!result.ok || result.answer.kind !== "symbolFacet") throw new Error(`${at}: ${JSON.stringify(result)}`);
	return result.answer.facet;
}

export async function facetAnswerOf(vector: FacetCase): Promise<FacetVectorAnswer> {
	const deps = { root: () => workspace(vector.modules), session: sessionOf(vector) };
	const read = async (facet: SymbolFacet) =>
		facetOf(
			await answerWorkspaceOp(deps, { kind: "symbolFacet", symbolId: vector.subject, facet }),
			`${vector.name} ${facet.kind}`,
		);

	const uses = await read({ kind: "uses" });
	const usesFrom = await read({ kind: "usesFrom" });
	const members = await read({ kind: "members" });
	const hierarchy = await read({ kind: "hierarchy" });
	const comments = await read({ kind: "comments" });
	const knowledge = await answerWorkspaceOp(deps, { kind: "symbolKnowledge", symbolId: vector.subject });
	if (!knowledge.ok || knowledge.answer.kind !== "symbolKnowledge") throw new Error(`${vector.name}: no knowledge`);
	const counts = knowledge.answer.facts?.counts;
	if (counts === undefined) throw new Error(`${vector.name}: the knowledge answer carried no counts`);
	if (
		uses.kind !== "uses" ||
		usesFrom.kind !== "usesFrom" ||
		members.kind !== "members" ||
		hierarchy.kind !== "hierarchy" ||
		comments.kind !== "comments"
	) {
		throw new Error(`${vector.name}: a facet answered the wrong kind`);
	}
	return {
		uses: { rows: uses.rows.map(rowOf), uses: uses.uses, plain: uses.plain },
		usesFrom: {
			targets: usesFrom.targets.map((target) => ({
				name: target.name,
				status: target.status,
				target: target.target?.symbolId ?? null,
				reason: target.reason ?? null,
				uses: target.uses.map(rowOf),
			})),
			targetCount: usesFrom.targetCount,
			references: usesFrom.references,
			plain: usesFrom.plain,
		},
		members: { members: members.members.map((member) => member.symbolId) },
		hierarchy: {
			subject: hierarchy.subject.symbolId,
			supertypes: hierarchy.supertypes.map((type) => ({ symbol: type.symbol.symbolId, role: type.role ?? null })),
			ancestors: hierarchy.ancestors.map((symbol) => symbol.symbolId),
			unbound: hierarchy.unbound.map((type) => ({ name: type.name, role: type.role ?? null })),
			subtypes: hierarchy.subtypes.map((type) => ({ symbol: type.symbol.symbolId, role: type.role ?? null })),
			supertypeCount: hierarchy.supertypeCount,
			subtypeCount: hierarchy.subtypeCount,
		},
		comments: {
			comments: comments.comments.map((comment) => ({
				text: comment.text,
				form: comment.form,
				line: comment.line,
				holder: comment.holder?.symbolId ?? null,
			})),
			total: comments.total,
			truncated: comments.truncated ?? false,
		},
		counts,
	};
}
