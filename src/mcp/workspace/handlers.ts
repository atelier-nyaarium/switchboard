// Answers one workspace op against this process's own workspace. READS ONLY.
//
// Every path goes through `confine` and every byte through `loadWorkspaceFile`, so neither rule has a
// second spelling here. The Lexicon session is injected rather than imported, since the refs feature
// owns the one socket per process and this must not reach into it.

import fs from "node:fs";
import path from "node:path";
import type { Session } from "@nyaa-lexicon/client";
import { hashContent, parseSymbolId } from "@nyaa-lexicon/protocol";
import {
	MAX_TREE_ENTRIES,
	MAX_WORKSPACE_OP_BYTES,
	type OutlineSymbol,
	type TreeEntry,
	WORKSPACE_OP_TIMEOUT_MS,
	type WorkspaceOp,
	type WorkspaceOpAnswer,
	type WorkspaceOpResult,
} from "../../shared/workspace-op.js";
import { confine, listable } from "./confine.js";
import { loadWorkspaceFile } from "./loadFile.js";

////////////////////////////////
//  Interfaces & Types

export interface HandlerDeps {
	/** This process's workspace, the same root Lexicon indexes. */
	root: () => string;
	/** Lazy: an op that needs no index never opens a socket. */
	session: () => Promise<Session>;
	/** Defaults to `INDEX_BUDGET_MS`; a test drives it short. */
	budgetMs?: number;
}

////////////////////////////////
//  Functions & Helpers

const refused = (detail: string): WorkspaceOpResult => ({ ok: false, failure: "refused", detail });
const failed = (detail: string): WorkspaceOpResult => ({ ok: false, failure: "failed", detail });

/**
 * Under the plane's own timeout, so a cold index answers with a CAUSE rather than letting the Gateway
 * time out blind. The refs path waits 45 seconds for a daemon; the phone is not left that long.
 */
const INDEX_BUDGET_MS = Math.floor(WORKSPACE_OP_TIMEOUT_MS * 0.75);

/**
 * ONE deadline for the whole op, never a budget per call: two calls each given the full budget can
 * together outlast the plane's timeout, which is the blind timeout this exists to prevent.
 */
async function byDeadline<T>(deadline: number, work: () => Promise<T>): Promise<T> {
	const left = deadline - Date.now();
	if (left <= 0) throw new Error("the index did not answer in time");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const spent = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("the index did not answer in time")), left);
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
		case "symbolKnowledge":
			return Buffer.byteLength(answer.text, "utf8");
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

function childCount(dir: string): number | undefined {
	try {
		return fs.readdirSync(dir).length;
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

	const kept = names.filter((entry) => listable(entry.name, !entry.isDirectory()));
	// Ordered BEFORE the cap, or an over-cap directory answers an arbitrary thousand of itself.
	kept.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
	const truncated = kept.length > MAX_TREE_ENTRIES;
	const entries: TreeEntry[] = [];
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
		entries.push({ name: entry.name, directory: false, ...(bytes === undefined ? {} : { bytes }) });
	}

	return { ok: true, answer: { kind: "tree", path: place.relative, entries, truncated } };
}

function readOf(root: string, written: string): WorkspaceOpResult {
	const place = confine(root, written);
	if (!place.ok) return refused(place.refusal.detail);

	const loaded = loadWorkspaceFile(place.absolute, place.relative);
	if (!loaded.ok) return refused(loaded.detail);

	const text = loaded.file.text;
	return { ok: true, answer: { kind: "read", path: place.relative, text, lines: text.split("\n").length } };
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
	return { ok: true, answer: { kind: "outline", path: place.relative, symbols } };
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
	return {
		ok: true,
		answer: {
			kind: "symbolSource",
			symbolId,
			module: answer.module,
			name: answer.name,
			text: answer.text,
			startLine: answer.range.start.line + 1,
			endLine: answer.range.end.line + 1,
			// Of the SPAN. The whole-file hash is what makes an edit elsewhere look like a change.
			spanHash: hashContent(answer.text),
		},
	};
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
	return { ok: true, answer: { kind: "symbolKnowledge", symbolId, text: JSON.stringify(described) } };
}

/** A thrown op is answered as `failed`, never swallowed, so the phone sees a cause rather than a hang. */
export async function answerWorkspaceOp(deps: HandlerDeps, op: WorkspaceOp): Promise<WorkspaceOpResult> {
	const root = deps.root();
	const deadline = Date.now() + (deps.budgetMs ?? INDEX_BUDGET_MS);
	try {
		switch (op.kind) {
			case "tree":
				return withinCap(treeOf(root, op.path));
			case "read":
				return withinCap(readOf(root, op.path));
			case "outline":
				return withinCap(await outlineOf(deps, root, op.path, deadline));
			case "symbolSource":
				return withinCap(await symbolSourceOf(deps, root, op.symbolId, deadline));
			case "symbolKnowledge":
				return withinCap(await knowledgeOf(deps, root, op.symbolId, deadline));
		}
	} catch (error) {
		return failed(error instanceof Error ? error.message : String(error));
	}
}
