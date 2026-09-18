// The symbol drill-ins: every use, what a symbol uses, its members, its type hierarchy and its comments.
//
// A row in a file `confine` withholds is dropped before anything reads that file, and counts nowhere.
// The knowledge answer's counts come from these same reads, so a row counts what its drill-in lists.

import type { Session } from "@nyaa-lexicon/client";
import type {
	DescribeResult,
	FoundComment,
	StoredDeclaration,
	SymbolSummary,
	TypeHierarchy,
	UseFrom,
} from "@nyaa-lexicon/protocol";
import type {
	FacetAnswer,
	FacetComment,
	FacetSymbol,
	FacetTarget,
	FacetUse,
	KnowledgeCounts,
	SymbolFacet,
	WorkspaceOpResult,
} from "../../shared/workspace-op.js";
import {
	byDeadline,
	confinedModule,
	type OpContext,
	refused,
	type ServedGate,
	servedGate,
	tooLarge,
} from "./handlerKit.js";
import { symbolHistoryOf } from "./history.js";
import { loadWorkspaceFile } from "./loadFile.js";
import { factsForModule, lineStartsOf, linesOf, paintBuffer, sliceSpans, spansFromFacts } from "./paint.js";

////////////////////////////////
//  Interfaces & Types

/** A Lexicon reference row. */
interface Written {
	module: string;
	name: string;
	role: string;
	fromId: string | null;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
	topLevel?: SymbolSummary;
	language?: string;
}

/** A file read once. */
interface SourceFile {
	text: string;
	lines: string[];
}

interface TypeNodes {
	direct: SymbolSummary[];
	ancestors: SymbolSummary[];
	unbound: string[];
	subtypes: SymbolSummary[];
}

////////////////////////////////
//  Constants

/** Past any answer cap: no row serialises under 40 bytes. */
const UNCAPPED = 100_000;

/** Lexicon's comment page cap. */
const COMMENT_PAGE = 200;

/** A long line's window. */
const MAX_ROW_TEXT = 512;

/** Window lead before the name. */
const ROW_LEAD = 128;

const HERITAGE: ReadonlySet<string> = new Set(["extends", "implements"]);

////////////////////////////////
//  Functions & Helpers

export function facetSymbolOf(summary: SymbolSummary): FacetSymbol {
	return {
		symbolId: summary.symbolId,
		name: summary.name,
		symbolKind: summary.kind,
		module: summary.module,
		// Lexicon counts lines from zero.
		...(summary.lines === undefined ? {} : { startLine: summary.lines.start + 1, endLine: summary.lines.end + 1 }),
		...(summary.signature === undefined ? {} : { signature: summary.signature.slice(0, 4096) }),
	};
}

/** A summary whose module AND whose own id are served; a served row can still name a withheld one. */
function shown(gate: ServedGate, summary: SymbolSummary | undefined): SymbolSummary | undefined {
	if (summary === undefined) return undefined;
	return gate.module(summary.module) !== null && gate.id(summary.symbolId) ? summary : undefined;
}

/** The hierarchy's own self node. */
function subjectOf(declared: StoredDeclaration): FacetSymbol {
	return {
		symbolId: declared.symbolId,
		name: declared.name,
		symbolKind: declared.kind,
		module: declared.module,
		// Lexicon counts lines from zero.
		startLine: declared.range.start.line + 1,
		endLine: declared.range.end.line + 1,
		...(declared.signature === undefined ? {} : { signature: declared.signature.slice(0, 4096) }),
	};
}

function isLowSurrogate(text: string, at: number): boolean {
	const code = text.charCodeAt(at);
	return code >= 0xdc00 && code <= 0xdfff;
}

/** Never splits a surrogate pair. */
function windowOf(line: string, startColumn: number): { text: string; textStart?: number } {
	if (line.length <= MAX_ROW_TEXT) return { text: line };
	let start = Math.max(0, Math.min(startColumn - ROW_LEAD, line.length - MAX_ROW_TEXT));
	if (start > 0 && isLowSurrogate(line, start)) start--;
	let end = Math.min(line.length, start + MAX_ROW_TEXT);
	if (end < line.length && isLowSurrogate(line, end)) end--;
	return { text: line.slice(start, end), ...(start === 0 ? {} : { textStart: start }) };
}

function useRowOf(
	gate: ServedGate,
	written: Written,
	line: string | undefined,
	outline: Map<string, SymbolSummary> | undefined,
): FacetUse {
	const topLevel = shown(gate, written.topLevel);
	const holder = shown(
		gate,
		written.fromId === null
			? undefined
			: written.fromId === written.topLevel?.symbolId
				? written.topLevel
				: outline?.get(written.fromId),
	);
	const text = line?.endsWith("\r") ? line.slice(0, -1) : line;
	const clamp = (column: number) => (text === undefined ? column : Math.min(column, text.length));
	const startColumn = clamp(written.startCharacter);
	// Multi-line names mark to line end.
	const endColumn =
		written.endLine === written.startLine ? clamp(written.endCharacter) : (text?.length ?? startColumn);
	return {
		module: written.module,
		line: written.startLine + 1,
		startColumn,
		endColumn,
		name: written.name,
		role: written.role,
		...(holder === undefined ? {} : { holder: facetSymbolOf(holder) }),
		...(topLevel === undefined ? {} : { topLevel: facetSymbolOf(topLevel) }),
		...(written.language === undefined ? {} : { language: written.language }),
		...(text === undefined ? {} : windowOf(text, startColumn)),
	};
}

/** Past the deadline, or the module cannot be painted, null. */
async function spansBy(context: OpContext, session: Session, module: string, text: string): Promise<number[][] | null> {
	if (Date.now() >= context.deadline) return null;
	const outcome = await factsForModule(session, module, text, context.deadline);
	return "reason" in outcome ? null : spansFromFacts(text, outcome.facts);
}

/** Each served module read once, withheld ones never opened. */
function sourcesOf(gate: ServedGate, written: readonly Written[]): Map<string, SourceFile> {
	const sources = new Map<string, SourceFile>();
	const unread = new Set<string>();
	for (const row of written) {
		if (sources.has(row.module) || unread.has(row.module)) continue;
		const absolute = gate.module(row.module);
		const loaded = absolute === null ? null : loadWorkspaceFile(absolute, row.module);
		if (loaded?.ok) sources.set(row.module, { text: loaded.file.text, lines: loaded.file.text.split("\n") });
		else unread.add(row.module);
	}
	return sources;
}

/** The index can be behind the disk: a row whose file or line is gone counts nowhere. */
function onDisk<T extends Written>(written: readonly T[], sources: Map<string, SourceFile>): T[] {
	return written.filter((row) => sources.get(row.module)?.lines[row.startLine] !== undefined);
}

/** Nothing is opened for an answer already refused whole. */
function keptRows<T extends Written>(gate: ServedGate, found: { references: T[]; truncated: boolean }) {
	if (found.truncated) {
		return {
			rows: found.references.filter((row) => gate.module(row.module) !== null),
			sources: new Map<string, SourceFile>(),
			complete: false,
		};
	}
	const sources = sourcesOf(gate, found.references);
	return { rows: onDisk(found.references, sources), sources, complete: true };
}

/** Each file outlined and highlighted once. */
async function useRowsOf(
	context: OpContext,
	session: Session,
	gate: ServedGate,
	written: readonly Written[],
	sources: Map<string, SourceFile>,
): Promise<{ rows: FacetUse[]; plain: number }> {
	const byModule = new Map<string, number[]>();
	written.forEach((row, index) => {
		const indexes = byModule.get(row.module);
		if (indexes === undefined) byModule.set(row.module, [index]);
		else indexes.push(index);
	});
	const rows: FacetUse[] = [];
	for (const [module, indexes] of byModule) {
		const lines = sources.get(module)?.lines;
		const needsOutline = indexes.some((index) => {
			const row = written[index] as Written;
			return row.fromId !== null && row.fromId !== row.topLevel?.symbolId;
		});
		const outline = needsOutline
			? new Map(
					(await byDeadline(context.deadline, () => session.outlineModule({ module }))).map((summary) => [
						summary.symbolId,
						summary,
					]),
				)
			: undefined;
		for (const index of indexes) {
			const row = written[index] as Written;
			rows[index] = useRowOf(gate, row, lines?.[row.startLine], outline);
		}
	}

	let plain = 0;
	for (const [module, indexes] of byModule) {
		const text = sources.get(module)?.text;
		if (text === undefined) continue;
		const spans = await spansBy(context, session, module, text);
		for (const index of indexes) {
			const row = rows[index] as FacetUse;
			if (row.text === undefined) continue;
			if (spans === null) {
				plain++;
				continue;
			}
			const from = row.textStart ?? 0;
			const line = spans[(written[index] as Written).startLine] ?? [];
			rows[index] = { ...row, spans: sliceSpans(line, from, from + row.text.length) };
		}
	}
	return { rows, plain };
}

async function servedUses(context: OpContext, session: Session, gate: ServedGate, symbolId: string) {
	const found = await byDeadline(context.deadline, () => session.findReferences({ symbolId, limit: UNCAPPED }));
	return keptRows(gate, found);
}

/** Gated on the row's own module: a use written in a served file counts whatever it points at. */
async function servedUsesFrom(context: OpContext, session: Session, gate: ServedGate, symbolId: string) {
	const found = await byDeadline(context.deadline, () => session.usesFrom({ symbolId, limit: UNCAPPED }));
	return keptRows(gate, found);
}

interface TargetRow {
	name: string;
	status: string;
	target?: SymbolSummary;
	reason?: string;
}

/** A withheld target leaves the use unresolved under its written name, never dropped. */
function shownTargetOf(gate: ServedGate, row: UseFrom): TargetRow {
	const target = shown(gate, row.target);
	const reason = row.reason === undefined ? {} : { reason: row.reason };
	if (row.status === "bound" && target !== undefined) {
		return { name: target.name, status: "bound", target, ...reason };
	}
	return { name: row.name, status: row.status === "bound" ? "unbound" : row.status, ...reason };
}

/** Unresolved names key by spelling. */
function targetKeyOf(row: TargetRow): string {
	return row.status === "bound" && row.target !== undefined
		? `bound ${row.target.symbolId}`
		: `${row.status} ${row.name}`;
}

/** `targets` groups every row; `boundTargets` only the ones that bound. */
function targetCounts(rows: readonly TargetRow[]): Pick<KnowledgeCounts, "targets" | "boundTargets"> {
	const keys = new Set<string>();
	const bound = new Set<string>();
	for (const row of rows) {
		keys.add(targetKeyOf(row));
		if (row.status === "bound" && row.target !== undefined) bound.add(row.target.symbolId);
	}
	return { targets: keys.size, boundTargets: bound.size };
}

function useCounts(
	gate: ServedGate,
	rows: readonly Written[],
): Pick<KnowledgeCounts, "uses" | "useFiles" | "dependents" | "dependentFiles"> {
	const dependents = new Set<string>();
	const dependentFiles = new Set<string>();
	for (const row of rows) {
		const topLevel = shown(gate, row.topLevel);
		if (topLevel === undefined) dependentFiles.add(row.module);
		else dependents.add(topLevel.symbolId);
	}
	return {
		uses: rows.length,
		useFiles: new Set(rows.map((row) => row.module)).size,
		dependents: dependents.size,
		dependentFiles: dependentFiles.size,
	};
}

/** Ancestors exclude direct supertypes. */
function typeNodesOf(hierarchy: TypeHierarchy, gate: ServedGate): TypeNodes {
	const isServed = (summary: SymbolSummary) => shown(gate, summary) !== undefined;
	const directIds = new Set(hierarchy.supertypes.map((summary) => summary.symbolId));
	return {
		direct: hierarchy.supertypes.filter(isServed),
		ancestors: hierarchy.ancestors.filter((summary) => !directIds.has(summary.symbolId) && isServed(summary)),
		unbound: [...new Set(hierarchy.unboundSupertypes)],
		subtypes: hierarchy.subtypes.filter(isServed),
	};
}

const supertypeCountOf = (nodes: TypeNodes) => nodes.direct.length + nodes.ancestors.length + nodes.unbound.length;

/** Its own leading comment is documentation. */
async function commentsIn(context: OpContext, session: Session, symbolId: string, module: string) {
	const found = await byDeadline(context.deadline, () =>
		session.findComments({ within: symbolId, module, limit: COMMENT_PAGE }),
	);
	// Sliced here too: the page is this plugin's bound, not the daemon's promise.
	const page = found.comments.slice(0, COMMENT_PAGE);
	const own = (comment: FoundComment) => comment.anchor?.symbolId === symbolId && comment.form === "leading";
	const listed = page.filter((comment) => !own(comment));
	const counted = Number.isFinite(found.total) ? found.total - (page.length - listed.length) : listed.length;
	return {
		listed,
		count: Math.max(counted, listed.length),
		truncated: found.truncated || found.comments.length > COMMENT_PAGE,
	};
}

async function usesAnswerOf(context: OpContext, session: Session, symbolId: string): Promise<FacetOutcome> {
	const gate = servedGate(context.root);
	const kept = await servedUses(context, session, gate, symbolId);
	if (!kept.complete) return { tooLarge: kept.rows.length };
	const { rows, plain } = await useRowsOf(context, session, gate, kept.rows, kept.sources);
	return { facet: { kind: "uses", rows, uses: rows.length, plain } };
}

async function usesFromAnswerOf(context: OpContext, session: Session, symbolId: string): Promise<FacetOutcome> {
	const gate = servedGate(context.root);
	const kept = await servedUsesFrom(context, session, gate, symbolId);
	if (!kept.complete) return { tooLarge: kept.rows.length };
	const { rows, plain } = await useRowsOf(context, session, gate, kept.rows, kept.sources);
	const groups = new Map<string, FacetTarget>();
	kept.rows.forEach((written, index) => {
		const pointed = shownTargetOf(gate, written);
		const key = targetKeyOf(pointed);
		let group = groups.get(key);
		if (group === undefined) {
			group = {
				name: pointed.name,
				status: pointed.status,
				...(pointed.target === undefined ? {} : { target: facetSymbolOf(pointed.target) }),
				...(pointed.reason === undefined ? {} : { reason: pointed.reason }),
				uses: [],
			};
			groups.set(key, group);
		}
		group.uses.push(rows[index] as FacetUse);
	});
	return {
		facet: {
			kind: "usesFrom",
			targets: [...groups.values()],
			targetCount: groups.size,
			references: rows.length,
			plain,
		},
	};
}

/** Where `signature` sits in `text`, bound to the summary's own lines so an identical rendered
 * signature elsewhere in the module is never mistaken for this one. Null when it is not a literal
 * slice there at all: a provider that reformats its rendering is not guessed at. */
function signatureOffsetIn(
	text: string,
	lineStarts: readonly number[],
	summary: SymbolSummary,
	signature: string,
): number | null {
	if (summary.lines === undefined) return null;
	const from = lineStarts[summary.lines.start] ?? text.length;
	const to = lineStarts[summary.lines.end + 1] ?? text.length;
	const at = text.indexOf(signature, from);
	return at !== -1 && at + signature.length <= to ? at : null;
}

/** Each module's members painted from ONE `factsForModule` call, never one per member. */
async function membersAnswerOf(context: OpContext, session: Session, symbolId: string): Promise<FacetOutcome> {
	const gate = servedGate(context.root);
	const described = await byDeadline(context.deadline, () => session.describe({ symbolId }));
	if (described === null) return { refused: "no symbol with that id is indexed" };
	const served = described.members.filter((summary) => shown(gate, summary) !== undefined);

	const byModule = new Map<string, SymbolSummary[]>();
	for (const summary of served) {
		const list = byModule.get(summary.module);
		if (list === undefined) byModule.set(summary.module, [summary]);
		else list.push(summary);
	}

	const spansOf = new Map<string, number[][]>();
	for (const [module, summaries] of byModule) {
		if (Date.now() >= context.deadline) break;
		const absolute = gate.module(module);
		const loaded = absolute === null ? null : loadWorkspaceFile(absolute, module);
		if (!loaded?.ok) continue;
		const outcome = await factsForModule(session, module, loaded.file.text, context.deadline);
		if ("reason" in outcome) continue;
		const buffer = paintBuffer(loaded.file.text, outcome.facts);
		const lineStarts = lineStartsOf(loaded.file.text);
		for (const summary of summaries) {
			const signature = facetSymbolOf(summary).signature;
			if (signature === undefined) continue;
			const at = signatureOffsetIn(loaded.file.text, lineStarts, summary, signature);
			if (at === null) continue;
			spansOf.set(summary.symbolId, linesOf(signature, buffer.slice(at, at + signature.length)));
		}
	}

	let plain = 0;
	const members = served.map((summary): FacetSymbol => {
		const member = facetSymbolOf(summary);
		if (member.signature === undefined) return member;
		const signatureSpans = spansOf.get(summary.symbolId);
		if (signatureSpans === undefined) {
			plain++;
			return member;
		}
		return { ...member, signatureSpans };
	});
	return { facet: { kind: "members", members, plain } };
}

async function hierarchyAnswerOf(
	context: OpContext,
	session: Session,
	symbolId: string,
	declared: StoredDeclaration,
): Promise<FacetOutcome> {
	const gate = servedGate(context.root);
	const hierarchy = await byDeadline(context.deadline, () => session.typeHierarchy({ symbolId }));
	const nodes = typeNodesOf(hierarchy, gate);

	const up =
		nodes.direct.length + nodes.unbound.length === 0
			? []
			: (await byDeadline(context.deadline, () => session.usesFrom({ symbolId, limit: UNCAPPED }))).references;
	const down =
		nodes.subtypes.length === 0
			? []
			: (await byDeadline(context.deadline, () => session.findReferences({ symbolId, limit: UNCAPPED })))
					.references;
	const boundRole = new Map<string, string>();
	const unboundRole = new Map<string, string>();
	for (const row of up) {
		if (row.fromId !== symbolId || !HERITAGE.has(row.role)) continue;
		if (row.targetId === null) unboundRole.set(row.name, row.role);
		else boundRole.set(row.targetId, row.role);
	}
	const subRole = new Map<string, string>();
	for (const row of down) if (row.fromId !== null && HERITAGE.has(row.role)) subRole.set(row.fromId, row.role);

	const typed = (roles: Map<string, string>) => (summary: SymbolSummary) => {
		const role = roles.get(summary.symbolId);
		return { symbol: facetSymbolOf(summary), ...(role === undefined ? {} : { role }) };
	};
	return {
		facet: {
			kind: "hierarchy",
			subject: subjectOf(declared),
			supertypes: nodes.direct.map(typed(boundRole)),
			ancestors: nodes.ancestors.map(facetSymbolOf),
			unbound: nodes.unbound.map((name) => {
				const role = unboundRole.get(name);
				return { name, ...(role === undefined ? {} : { role }) };
			}),
			subtypes: nodes.subtypes.map(typed(subRole)),
			supertypeCount: supertypeCountOf(nodes),
			subtypeCount: nodes.subtypes.length,
		},
	};
}

/** A local's comment goes to its holder. */
async function commentsAnswerOf(
	context: OpContext,
	session: Session,
	symbolId: string,
	module: string,
): Promise<FacetOutcome> {
	const gate = servedGate(context.root);
	const { listed, count, truncated } = await commentsIn(context, session, symbolId, module);
	if (listed.length === 0) {
		return { facet: { kind: "comments", comments: [], total: count, ...(truncated ? { truncated } : {}) } };
	}

	const resolved = await byDeadline(context.deadline, () =>
		session.resolveFacts({ factIds: listed.map((comment) => comment.factId) }),
	);
	const prose = new Map<string, string>();
	for (const fact of resolved.resolved) if (fact.fact === "comment") prose.set(fact.factId, fact.normalized);

	const scope = await byDeadline(context.deadline, () =>
		session.knowledgeScope({ symbolId, members: true, includeLocals: false }),
	);
	const declared = new Map(
		(scope?.symbols ?? [])
			.filter((entry) => shown(gate, entry.symbol) !== undefined)
			.map((entry) => [entry.symbol.symbolId, entry.symbol]),
	);
	const outline = await byDeadline(context.deadline, () => session.outlineModule({ module }));
	const containerOf = new Map(outline.map((summary) => [summary.symbolId, summary.containerId]));

	const holderOf = (anchorId: string): SymbolSummary | undefined => {
		let at: string | undefined = anchorId;
		for (let step = 0; at !== undefined && step <= outline.length; step++) {
			const found = declared.get(at);
			if (found !== undefined) return found;
			at = containerOf.get(at);
		}
		return undefined;
	};

	const comments = listed.map((comment): FacetComment => {
		const holder = comment.anchor === null ? undefined : holderOf(comment.anchor.symbolId);
		return {
			text: prose.get(comment.factId) ?? comment.raw,
			form: comment.form,
			line: comment.range.start.line + 1,
			...(holder === undefined ? {} : { holder: facetSymbolOf(holder) }),
		};
	});
	return { facet: { kind: "comments", comments, total: count, ...(truncated ? { truncated } : {}) } };
}

type FacetOutcome = { facet: FacetAnswer } | { refused: string } | { tooLarge: number };

export async function symbolFacetOf(
	context: OpContext,
	symbolId: string,
	facet: SymbolFacet,
): Promise<WorkspaceOpResult> {
	const module = confinedModule(context.root, symbolId);
	if (module === null) return refused("that symbol's module is not served");
	if (facet.kind === "history") return symbolHistoryOf(context, symbolId, module);

	const session = await byDeadline(context.deadline, context.deps.session);
	const declared = await byDeadline(context.deadline, () => session.declarationOf({ symbolId }));
	if (declared === null) return refused("no symbol with that id is indexed");

	let outcome: FacetOutcome;
	switch (facet.kind) {
		case "uses":
			outcome = await usesAnswerOf(context, session, symbolId);
			break;
		case "usesFrom":
			outcome = await usesFromAnswerOf(context, session, symbolId);
			break;
		case "members":
			outcome = await membersAnswerOf(context, session, symbolId);
			break;
		case "hierarchy":
			outcome = await hierarchyAnswerOf(context, session, symbolId, declared);
			break;
		case "comments":
			outcome = await commentsAnswerOf(context, session, symbolId, module);
			break;
	}
	if ("refused" in outcome) return refused(outcome.refused);
	if ("tooLarge" in outcome) return tooLarge(undefined, outcome.tooLarge);
	return { ok: true, answer: { kind: "symbolFacet", symbolId, facet: outcome.facet } };
}

/** Undefined on any failure, an older Lexicon or a slow read alike, never the whole answer. */
export async function knowledgeCountsOf(
	context: OpContext,
	session: Session,
	described: DescribeResult,
): Promise<KnowledgeCounts | undefined> {
	const { symbolId, module } = described.symbol;
	const gate = servedGate(context.root);
	try {
		const uses = await servedUses(context, session, gate, symbolId);
		const from = await servedUsesFrom(context, session, gate, symbolId);
		// A truncated read opens no file, so its rows count nothing.
		if (!uses.complete || !from.complete) return undefined;
		const comments = await commentsIn(context, session, symbolId, module);
		const nodes = typeNodesOf(described.hierarchy, gate);
		return {
			...useCounts(gate, uses.rows),
			...targetCounts(from.rows.map((row) => shownTargetOf(gate, row))),
			references: from.rows.length,
			members: described.members.filter((summary) => shown(gate, summary) !== undefined).length,
			supertypes: supertypeCountOf(nodes),
			subtypes: nodes.subtypes.length,
			comments: comments.count,
		};
	} catch {
		return undefined;
	}
}
