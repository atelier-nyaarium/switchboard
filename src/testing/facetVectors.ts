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
	/** Stands in for the 100,000 rows the plugin asks for, which no fixture fills. */
	usePage?: number;
	targetPage?: number;
}

interface Row {
	module: string;
	line: number;
	name: string;
	role: string;
	holder: string | null;
	topLevel: string | null;
}

/** Refused whole once the index truncated: the served rows the page held, and no row. */
export interface FacetTooLarge {
	tooLarge: number;
}

export interface FacetVectorAnswer {
	uses: { rows: Row[]; uses: number; plain: number } | FacetTooLarge;
	usesFrom:
		| {
				targets: { name: string; status: string; target: string | null; reason: string | null; uses: Row[] }[];
				targetCount: number;
				references: number;
				plain: number;
		  }
		| FacetTooLarge;
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
	/** Null once a reference read truncated, since its rows count nothing. */
	counts: KnowledgeCounts | null;
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

/** The daemon's order: module, then line, then character. */
function bySource(left: FacetUseInput, right: FacetUseInput): number {
	if (left.module !== right.module) return left.module < right.module ? -1 : 1;
	return left.line - right.line || left.column - right.column;
}

/** Uses from are read in one module, so the index orders them by line, then character. */
function byLine(left: FacetUseInput, right: FacetUseInput): number {
	return left.line - right.line || left.column - right.column;
}

function pageOf<T>(rows: readonly T[], page: number | undefined, limit: number) {
	const cap = Math.min(page ?? rows.length, limit);
	return { references: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
}

function heldBy(symbols: Map<string, FacetDeclared>, subject: string, id: string): boolean {
	for (let at: string | undefined = id; at !== undefined; at = symbols.get(at)?.container)
		if (at === subject) return true;
	return false;
}

/** A use from a subject is written inside it, in its module, or the index never answers it. */
function targetsOf(vector: FacetCase, subject: FacetDeclared, symbols: Map<string, FacetDeclared>) {
	for (const target of vector.targets ?? []) {
		const at = `${vector.name}: a use from ${subject.name} at ${target.module}:${target.line}`;
		if (target.module !== subject.module) throw new Error(`${at} is outside ${subject.module}`);
		const holder = target.holder === undefined ? undefined : declaredOf(symbols, target.holder, at);
		if (holder === undefined || !heldBy(symbols, subject.id, holder.id)) {
			throw new Error(`${at} is held outside ${subject.name}`);
		}
		if (target.line < holder.startLine || target.line > holder.endLine)
			throw new Error(`${at} is outside ${holder.name}`);
	}
	return [...(vector.targets ?? [])].sort(byLine).map((target) => useFromOf(target, symbols));
}

/** Every read the facet handlers make, answered from the case's own rows. */
function sessionOf(vector: FacetCase): () => Promise<Session> {
	const symbols = new Map(vector.symbols.map((symbol) => [symbol.id, symbol]));
	const subject = declaredOf(symbols, vector.subject, `${vector.name} subject`);
	const comments = vector.comments ?? [];
	const uses = [...(vector.uses ?? [])].sort(bySource).map((use) => referenceOf(use, symbols));
	const targets = targetsOf(vector, subject, symbols);
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
		findReferences: async ({ limit }: { limit: number }) => ({
			symbolId: vector.subject,
			...pageOf(uses, vector.usePage, limit),
		}),
		usesFrom: async ({ limit }: { limit: number }) => ({
			symbolId: vector.subject,
			...pageOf(targets, vector.targetPage, limit),
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

/** Null where the answer stands, a row count where the index truncated. */
function tooLargeOf(result: WorkspaceOpResult, at: string): FacetTooLarge | null {
	if (result.ok) return null;
	if (result.failure !== "too_large" || result.rows === undefined)
		throw new Error(`${at}: ${JSON.stringify(result)}`);
	return { tooLarge: result.rows };
}

function usesOf(result: WorkspaceOpResult, at: string): FacetVectorAnswer["uses"] {
	const refused = tooLargeOf(result, at);
	if (refused !== null) return refused;
	const facet = facetOf(result, at);
	if (facet.kind !== "uses") throw new Error(`${at}: a facet answered the wrong kind`);
	return { rows: facet.rows.map(rowOf), uses: facet.uses, plain: facet.plain };
}

function usesFromOf(result: WorkspaceOpResult, at: string): FacetVectorAnswer["usesFrom"] {
	const refused = tooLargeOf(result, at);
	if (refused !== null) return refused;
	const facet = facetOf(result, at);
	if (facet.kind !== "usesFrom") throw new Error(`${at}: a facet answered the wrong kind`);
	return {
		targets: facet.targets.map((target) => ({
			name: target.name,
			status: target.status,
			target: target.target?.symbolId ?? null,
			reason: target.reason ?? null,
			uses: target.uses.map(rowOf),
		})),
		targetCount: facet.targetCount,
		references: facet.references,
		plain: facet.plain,
	};
}

export async function facetAnswerOf(vector: FacetCase): Promise<FacetVectorAnswer> {
	const deps = { root: () => workspace(vector.modules), session: sessionOf(vector) };
	const ask = (facet: SymbolFacet) =>
		answerWorkspaceOp(deps, { kind: "symbolFacet", symbolId: vector.subject, facet });
	const read = async (facet: SymbolFacet) => facetOf(await ask(facet), `${vector.name} ${facet.kind}`);

	const uses = usesOf(await ask({ kind: "uses" }), `${vector.name} uses`);
	const usesFrom = usesFromOf(await ask({ kind: "usesFrom" }), `${vector.name} usesFrom`);
	const members = await read({ kind: "members" });
	const hierarchy = await read({ kind: "hierarchy" });
	const comments = await read({ kind: "comments" });
	const knowledge = await answerWorkspaceOp(deps, { kind: "symbolKnowledge", symbolId: vector.subject });
	if (!knowledge.ok || knowledge.answer.kind !== "symbolKnowledge") throw new Error(`${vector.name}: no knowledge`);
	if (members.kind !== "members" || hierarchy.kind !== "hierarchy" || comments.kind !== "comments") {
		throw new Error(`${vector.name}: a facet answered the wrong kind`);
	}
	return {
		uses,
		usesFrom,
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
		counts: knowledge.answer.facts?.counts ?? null,
	};
}
