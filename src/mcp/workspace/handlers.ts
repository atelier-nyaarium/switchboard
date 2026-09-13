// Answers one workspace op against this process's own workspace.
//
// Every path goes through `confine` and every byte through `loadWorkspaceFile`, so neither rule has a
// second spelling here. The Lexicon session is injected rather than imported, since the refs feature
// owns the one socket per process and this must not reach into it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonError, type Session } from "@nyaa-lexicon/client";
import {
	type DescribeResult,
	hashContent,
	parseSymbolId,
	QUESTION_CLASSES,
	type RecallAnswerResult,
	type SymbolSource,
} from "@nyaa-lexicon/protocol";
import {
	boundsOf,
	type KnowledgeAnswer,
	type KnowledgeEntry,
	MAX_TREE_ENTRIES,
	MAX_WORKSPACE_OP_BYTES,
	type OutlineSymbol,
	type SaveSpanAnswer,
	type SymbolSourceAnswer,
	type TreeEntry,
	type WorkspaceOp,
	type WorkspaceOpAnswer,
	type WorkspaceOpResult,
} from "../../shared/workspace-op.js";
import { confine, listable } from "./confine.js";
import { loadWorkspaceFile } from "./loadFile.js";
import { fileStateOf, mutateFile, readOnlyReason } from "./mutateFile.js";

////////////////////////////////
//  Interfaces & Types

export interface HandlerDeps {
	/** This process's workspace, the same root Lexicon indexes. */
	root: () => string;
	/** Lazy: an op that needs no index never opens a socket. */
	session: () => Promise<Session>;
	/** Defaults to the op's `handlerBudgetMs`; a test drives it short. */
	budgetMs?: number;
}

////////////////////////////////
//  Functions & Helpers

const refused = (detail: string): WorkspaceOpResult => ({ ok: false, failure: "refused", detail });

/** Half the answer cap, since a saved span's answer carries the span back. */
const MAX_SAVED_SPAN_BYTES = MAX_WORKSPACE_OP_BYTES / 2;
const failed = (detail: string): WorkspaceOpResult => ({ ok: false, failure: "failed", detail });

/**
 * ONE deadline for the whole op, never a budget per call: two calls each given the full budget can
 * together outlast the plane's timeout, which is the blind timeout this exists to prevent.
 */
async function byDeadline<T>(
	deadline: number,
	work: () => Promise<T>,
	late = "the index did not answer in time",
): Promise<T> {
	const left = deadline - Date.now();
	if (left <= 0) throw new Error(late);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const spent = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(late)), left);
	});
	try {
		return await Promise.race([work(), spent]);
	} finally {
		clearTimeout(timer);
	}
}

/** The text IS the weight of every answer that has one, so measuring it skips a second full copy. */
function answerBytes(answer: WorkspaceOpAnswer): number {
	switch (answer.kind) {
		case "read":
		case "symbolSource":
			return Buffer.byteLength(answer.text, "utf8");
		case "saveSpan":
			return (
				Buffer.byteLength(answer.current?.text ?? "", "utf8") + Buffer.byteLength(answer.reason ?? "", "utf8")
			);
		default:
			return Buffer.byteLength(JSON.stringify(answer), "utf8");
	}
}

/** Refused whole, since a truncated answer would be saved back truncated. */
function withinCap(result: WorkspaceOpResult): WorkspaceOpResult {
	if (!result.ok) return result;
	const bytes = answerBytes(result.answer);
	if (bytes <= MAX_WORKSPACE_OP_BYTES) return result;
	return {
		ok: false,
		failure: "too_large",
		detail: `the answer is ${bytes} bytes, over the ${MAX_WORKSPACE_OP_BYTES}-byte limit`,
	};
}

/** Per file; above it a row shows its size. */
const MAX_COUNTED_BYTES = 256_000;

/** Per listing, so a folder of large files cannot hold the read. */
const MAX_LISTING_COUNTED_BYTES = 4_000_000;

/** Lines as the raw editor counts them, or undefined for bytes that are not text or over the cap. */
function lineCountOf(file: string, buffer: Buffer, { follow = false } = {}): number | undefined {
	let fd: number | undefined;
	try {
		// An unconfined link could name an outside file, and a FIFO would hold the open.
		const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
		fd = fs.openSync(file, flags | (follow ? 0 : (fs.constants.O_NOFOLLOW ?? 0)));
		if (!fs.fstatSync(fd).isFile()) return undefined;
		const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
		if (read > MAX_COUNTED_BYTES) return undefined;
		const bytes = buffer.subarray(0, read);
		if (bytes.includes(0)) return undefined;
		let lines = 1;
		for (const byte of bytes) if (byte === 0x0a) lines++;
		return lines;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

const countingBuffer = () => Buffer.alloc(MAX_COUNTED_BYTES + 1);

/** The root as the owner would type it. */
function rootLabel(root: string): string {
	const home = os.homedir();
	const shown = root === home || root.startsWith(home + path.sep) ? `~${root.slice(home.length)}` : root;
	return shown.split(path.sep).join("/");
}

/** Counts what a tap would list, or the number says a withheld name is in there. */
function childCount(dir: string): number | undefined {
	try {
		return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => listable(e.name, !e.isDirectory())).length;
	} catch {
		return undefined;
	}
}

/**
 * A symbol id embeds its module, and nothing else confines one. Lexicon checks lexical containment
 * and knows nothing of what this plane withholds, so an indexed `.env` would answer without this.
 */
function confinedModule(root: string, symbolId: string): string | null {
	const parsed = parseSymbolId(symbolId);
	if (parsed === null) return null;
	return confine(root, parsed.module).ok ? parsed.module : null;
}

function treeOf(root: string, written: string): WorkspaceOpResult {
	const place = confine(root, written);
	if (!place.ok) return refused(place.refusal.detail);

	let names: fs.Dirent[];
	try {
		names = fs.readdirSync(place.absolute, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOTDIR") return refused(`${written || "."} is not a directory`);
		if (code === "ENOENT") return refused(`${written || "."} does not exist`);
		return failed(`${written || "."}: ${(error as Error).message}`);
	}

	// A link is listed only if the road behind it would serve it, or the tree offers a row that refuses.
	const kept = names.filter(
		(entry) =>
			listable(entry.name, !entry.isDirectory()) &&
			(!entry.isSymbolicLink() || confine(root, path.posix.join(place.relative, entry.name)).ok),
	);
	// Ordered BEFORE the cap, or an over-cap directory answers an arbitrary thousand of itself.
	kept.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
	const truncated = kept.length > MAX_TREE_ENTRIES;
	const entries: TreeEntry[] = [];
	const buffer = countingBuffer();
	let countable = MAX_LISTING_COUNTED_BYTES;
	for (const entry of kept.slice(0, MAX_TREE_ENTRIES)) {
		const full = path.join(place.absolute, entry.name);
		if (entry.isDirectory()) {
			const children = childCount(full);
			entries.push({ name: entry.name, directory: true, ...(children === undefined ? {} : { children }) });
			continue;
		}
		let bytes: number | undefined;
		try {
			// lstat, never stat: following a link here would report an outside file's size.
			bytes = fs.lstatSync(full).size;
		} catch {
			bytes = undefined;
		}
		let lines: number | undefined;
		if (entry.isFile() && bytes !== undefined && bytes <= MAX_COUNTED_BYTES && bytes <= countable) {
			countable -= bytes;
			lines = lineCountOf(full, buffer);
		}
		entries.push({
			name: entry.name,
			directory: false,
			...(bytes === undefined ? {} : { bytes }),
			...(lines === undefined ? {} : { lines }),
		});
	}

	return {
		ok: true,
		answer: { kind: "tree", path: place.relative, root: rootLabel(root), entries, truncated },
	};
}

function readOf(root: string, written: string): WorkspaceOpResult {
	const place = confine(root, written);
	if (!place.ok) return refused(place.refusal.detail);

	const loaded = loadWorkspaceFile(place.absolute, place.relative);
	if (!loaded.ok) return refused(loaded.detail);

	const { text, hash } = loaded.file;
	const readOnly = readOnlyReason(loaded.file);
	return {
		ok: true,
		answer: {
			kind: "read",
			path: place.relative,
			text,
			lines: text.split("\n").length,
			...(readOnly === null ? { hash } : { readOnly }),
		},
	};
}

async function outlineOf(
	deps: HandlerDeps,
	root: string,
	written: string,
	deadline: number,
): Promise<WorkspaceOpResult> {
	const place = confine(root, written);
	if (!place.ok) return refused(place.refusal.detail);
	if (place.relative === "") return refused("a module path is required");

	const session = await byDeadline(deadline, deps.session);
	const summaries = await byDeadline(deadline, () => session.outlineModule({ module: place.relative }));
	const symbols: OutlineSymbol[] = summaries.map((summary) => ({
		symbolId: summary.symbolId,
		name: summary.name,
		symbolKind: summary.kind,
		...(summary.containerId === undefined ? {} : { containerId: summary.containerId }),
		...(summary.signature === undefined ? {} : { signature: summary.signature }),
		// Lexicon counts lines from zero; the phone shows what an editor shows.
		...(summary.lines === undefined ? {} : { startLine: summary.lines.start + 1 }),
	}));
	// Confined already, so a link's target is counted.
	const lines = lineCountOf(place.absolute, countingBuffer(), { follow: true });
	return {
		ok: true,
		answer: {
			kind: "outline",
			path: place.relative,
			root: rootLabel(root),
			symbols,
			...(lines === undefined ? {} : { lines }),
		},
	};
}

function sourceAnswerOf(symbolId: string, found: Extract<SymbolSource, { found: true }>): SymbolSourceAnswer {
	return {
		kind: "symbolSource",
		symbolId,
		module: found.module,
		name: found.name,
		text: found.text,
		startLine: found.range.start.line + 1,
		endLine: found.range.end.line + 1,
		// Lexicon's own, which a save is checked against.
		spanHash: found.spanHash ?? hashContent(found.text),
	};
}

async function symbolSourceOf(
	deps: HandlerDeps,
	root: string,
	symbolId: string,
	deadline: number,
): Promise<WorkspaceOpResult> {
	if (confinedModule(root, symbolId) === null) return refused("that symbol's module is not served");
	const session = await byDeadline(deadline, deps.session);
	const answer = await byDeadline(deadline, () => session.symbolSource({ symbolId }));
	if (!answer.found) {
		return answer.stale === true ? { ok: false, failure: "stale", detail: answer.reason } : refused(answer.reason);
	}
	return { ok: true, answer: sourceAnswerOf(symbolId, answer) };
}

/**
 * After the attempt, and never a reason to fail it: the save already answered. `gone` only when the
 * index says so, since a read that failed says nothing about whether the span still exists.
 */
async function spanNow(
	session: Session,
	symbolId: string,
	deadline: number,
): Promise<{ current?: SymbolSourceAnswer; gone?: true }> {
	try {
		const answer = await byDeadline(deadline, () => session.symbolSource({ symbolId }));
		if (answer.found) return { current: sourceAnswerOf(symbolId, answer) };
		return answer.stale === true ? {} : { gone: true };
	} catch {
		return {};
	}
}

/**
 * The owner's text over one span, only while it still holds what they were shown. Standalone, so it
 * commits a transaction it opened and joins, without closing, one an agent holds.
 */
async function saveSpanOf(
	deps: HandlerDeps,
	root: string,
	op: Extract<WorkspaceOp, { kind: "saveSpan" }>,
	deadline: number,
): Promise<WorkspaceOpResult> {
	const module = confinedModule(root, op.symbolId);
	if (module === null) return refused("that symbol's module is not served");
	// Before the write: the answer carries the span back, and an answer over the cap is refused after it.
	const bytes = Buffer.byteLength(op.text, "utf8");
	if (bytes > MAX_SAVED_SPAN_BYTES) {
		return refused(`the span is ${bytes} bytes, over the ${MAX_SAVED_SPAN_BYTES}-byte limit for a save`);
	}
	const session = await byDeadline(deadline, deps.session);
	// A watcher still behind an edit elsewhere would refuse the save as a stale index.
	await byDeadline(deadline, () => session.indexFile({ module }));

	let outcome: Awaited<ReturnType<Session["refactorReplaceSpan"]>>;
	try {
		outcome = await byDeadline(
			deadline,
			() =>
				session.refactorReplaceSpan({
					symbolId: op.symbolId,
					expectedSpanHash: op.expectedSpanHash,
					newText: op.text,
					standalone: true,
				}),
			"the save did not answer in time, so whether it landed is unknown",
		);
	} catch (error) {
		if (error instanceof DaemonError && error.cause === "unknownMethod") {
			return refused("this machine's Lexicon cannot save a span yet; update the lexicon plugin");
		}
		// Asked and not answered: the write may land after this, so the phone reads the span back.
		return {
			ok: true,
			answer: {
				kind: "saveSpan",
				symbolId: op.symbolId,
				outcome: "unknown",
				reason: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
			},
		};
	}

	const answer: SaveSpanAnswer = {
		kind: "saveSpan",
		symbolId: op.symbolId,
		outcome: outcome.replaced ? "saved" : outcome.stale === true ? "stale" : "rejected",
		...(await spanNow(session, op.symbolId, deadline)),
	};
	if (outcome.replaced) {
		answer.joined = outcome.transaction === "joined";
		if (outcome.issues.length > 0) {
			answer.issues = outcome.issues.slice(0, 64).map((issue) => ({
				kind: issue.kind.slice(0, 64),
				detail: issue.detail.slice(0, 2048),
				...(issue.module === undefined ? {} : { module: issue.module.slice(0, 512) }),
				...(issue.line === undefined ? {} : { line: issue.line }),
			}));
		}
	} else if (outcome.stale !== true) {
		answer.reason = (outcome.reason ?? "the save was refused").slice(0, 2048);
	}
	return { ok: true, answer };
}

async function knowledgeOf(
	deps: HandlerDeps,
	root: string,
	symbolId: string,
	deadline: number,
): Promise<WorkspaceOpResult> {
	if (confinedModule(root, symbolId) === null) return refused("that symbol's module is not served");
	const session = await byDeadline(deadline, deps.session);
	const described = await byDeadline(deadline, () => session.describe({ symbolId }));
	if (described === null) return refused(`no symbol with that id is indexed`);
	const recalled = await byDeadline(deadline, () => session.recallAnswer({ symbolId }));
	return { ok: true, answer: knowledgeAnswerOf(symbolId, described, recalled) };
}

/** Unrecorded questions included. */
export function knowledgeAnswerOf(
	symbolId: string,
	described: DescribeResult,
	recalled: RecallAnswerResult,
): KnowledgeAnswer {
	const { symbol } = described;
	const held = new Map(
		(Array.isArray(recalled) ? recalled : recalled ? [recalled] : []).map((r) => [r.answer.question, r]),
	);
	const answers = QUESTION_CLASSES.map((question): KnowledgeEntry => {
		const found = held.get(question);
		if (found === undefined) return { question };
		return {
			question,
			prose: found.answer.prose,
			thin: found.answer.thin,
			stale: found.stale.length > 0 || found.inheritedStale.length > 0,
			doubted: found.answer.doubt !== undefined || found.doubtedUpstream.length > 0,
			stranded: found.stranded !== undefined,
		};
	});
	return {
		kind: "symbolKnowledge",
		symbolId,
		name: symbol.name,
		symbolKind: symbol.kind,
		module: symbol.module,
		answers,
		facts: {
			members: described.members.length,
			references: described.referenceCount,
			fanIn: described.graph.fanIn,
			fanOut: described.graph.fanOut,
			supertypes: described.hierarchy.supertypes.length,
			subtypes: described.hierarchy.subtypes.length,
			comments: (described.comments?.length ?? 0) + (described.moreComments ?? 0),
		},
		// Lexicon counts lines from zero.
		...(symbol.lines === undefined ? {} : { startLine: symbol.lines.start + 1, endLine: symbol.lines.end + 1 }),
		...(symbol.signature === undefined ? {} : { signature: symbol.signature }),
		...(symbol.docComment === undefined ? {} : { documentation: symbol.docComment }),
		text: legacyKnowledgeText(symbol.docComment, answers),
	};
}

// Remove 2026-09-27 with the wire field.
function legacyKnowledgeText(documentation: string | undefined, answers: KnowledgeEntry[]): string {
	const recorded = answers.flatMap((entry) =>
		entry.prose === undefined ? [] : [`${entry.question}: ${entry.prose}`],
	);
	return [documentation, ...recorded].filter((part) => part !== undefined).join("\n\n");
}

/** A thrown op is answered as `failed`, never swallowed, so the phone sees a cause rather than a hang. */
export async function answerWorkspaceOp(deps: HandlerDeps, op: WorkspaceOp): Promise<WorkspaceOpResult> {
	const root = deps.root();
	const deadline = Date.now() + (deps.budgetMs ?? boundsOf(op).handlerBudgetMs);
	try {
		switch (op.kind) {
			case "tree":
				return withinCap(treeOf(root, op.path));
			case "read":
				return withinCap(readOf(root, op.path));
			case "fileState":
				return withinCap(fileStateOf(root, op.path));
			case "outline":
				return withinCap(await outlineOf(deps, root, op.path, deadline));
			case "symbolSource":
				return withinCap(await symbolSourceOf(deps, root, op.symbolId, deadline));
			case "symbolKnowledge":
				return withinCap(await knowledgeOf(deps, root, op.symbolId, deadline));
			case "saveSpan":
				return withinCap(await saveSpanOf(deps, root, op, deadline));
			case "mutateFile":
				return withinCap(mutateFile(root, op.mutation));
		}
	} catch (error) {
		// Every Lexicon read: an older daemon is an update, not a failure.
		if (error instanceof DaemonError && error.cause === "unknownMethod") {
			return refused(`this machine's Lexicon is too old (${error.message}); update the lexicon plugin`);
		}
		return failed(error instanceof Error ? error.message : String(error));
	}
}
