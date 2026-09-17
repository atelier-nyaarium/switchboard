// What every workspace handler module shares: the result constructors, the one deadline, the id
// confinement and the size rule.

import os from "node:os";
import path from "node:path";
import type { Session } from "@nyaa-lexicon/client";
import { parseSymbolId } from "@nyaa-lexicon/protocol";
import { MAX_WORKSPACE_OP_BYTES, type WorkspaceOpAnswer, type WorkspaceOpResult } from "../../shared/workspace-op.js";
import { confine } from "./confine.js";

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

/** What one op's handler holds. */
export interface OpContext {
	deps: HandlerDeps;
	root: string;
	deadline: number;
}

////////////////////////////////
//  Functions & Helpers

export const refused = (detail: string): WorkspaceOpResult => ({ ok: false, failure: "refused", detail });

export const failed = (detail: string): WorkspaceOpResult => ({ ok: false, failure: "failed", detail });

export const LATE = "the index did not answer in time";

/**
 * ONE deadline for the whole op, never a budget per call: two calls each given the full budget can
 * together outlast the plane's timeout, which is the blind timeout this exists to prevent.
 */
export async function byDeadline<T>(deadline: number, work: () => Promise<T>, late = LATE): Promise<T> {
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

/**
 * A symbol id embeds its module, and nothing else confines one. Lexicon checks lexical containment
 * and knows nothing of what this plane withholds, so an indexed `.env` would answer without this.
 */
export function confinedModule(root: string, symbolId: string): string | null {
	const parsed = parseSymbolId(symbolId);
	if (parsed === null) return null;
	return confine(root, parsed.module).ok ? parsed.module : null;
}

/**
 * What an answer may name. EVERY id it carries is gated, not only the op's subject: a summary names
 * its own module, which need not be the module of the row that led to it.
 */
export interface ServedGate {
	/** Absolute path, or null when withheld. */
	module: (module: string) => string | null;
	id: (symbolId: string) => boolean;
}

export function servedGate(root: string): ServedGate {
	const modules = new Map<string, string | null>();
	const ids = new Map<string, boolean>();
	const module = (name: string) => {
		let absolute = modules.get(name);
		if (absolute === undefined) {
			const place = confine(root, name);
			absolute = place.ok && place.relative !== "" ? place.absolute : null;
			modules.set(name, absolute);
		}
		return absolute;
	};
	return {
		module,
		id: (symbolId) => {
			let served = ids.get(symbolId);
			if (served === undefined) {
				served = confinedModule(root, symbolId) !== null;
				ids.set(symbolId, served);
			}
			return served;
		},
	};
}

/** The root as the owner would type it. */
export function rootLabel(root: string): string {
	const home = os.homedir();
	const shown = root === home || root.startsWith(home + path.sep) ? `~${root.slice(home.length)}` : root;
	return shown.split(path.sep).join("/");
}

/** Rows a refusal names. */
function rowsOf(answer: WorkspaceOpAnswer): number | undefined {
	switch (answer.kind) {
		case "tree":
			return answer.entries.length;
		case "outline":
			return answer.symbols.length;
		case "knowledgeScope":
			return answer.symbols.length;
		case "fileHistory":
			return answer.commits.length;
		case "symbolFacet":
			return facetRows(answer.facet);
		default:
			return undefined;
	}
}

export function facetRows(facet: Extract<WorkspaceOpAnswer, { kind: "symbolFacet" }>["facet"]): number {
	switch (facet.kind) {
		case "uses":
			return facet.rows.length;
		case "usesFrom":
			return facet.references;
		case "members":
			return facet.members.length;
		case "hierarchy":
			return facet.supertypeCount + facet.subtypeCount;
		case "comments":
			return facet.comments.length;
		case "history":
			return facet.commits.length;
	}
}

/** Refused whole, never truncated. */
export function withinCap(result: WorkspaceOpResult): WorkspaceOpResult {
	if (!result.ok) return result;
	const bytes = Buffer.byteLength(JSON.stringify(result.answer), "utf8");
	if (bytes <= MAX_WORKSPACE_OP_BYTES) return result;
	return tooLarge(bytes, rowsOf(result.answer));
}

export function tooLarge(bytes: number | undefined, rows: number | undefined): WorkspaceOpResult {
	const size = bytes === undefined ? "more rows than fit" : `${bytes} bytes`;
	return {
		ok: false,
		failure: "too_large",
		detail: `the answer is ${size}, over the ${MAX_WORKSPACE_OP_BYTES}-byte limit`,
		...(rows === undefined ? {} : { rows }),
		...(bytes === undefined ? {} : { bytes }),
	};
}
