// Code spans painted from Lexicon's own facts, never a second parser.
//
// A declaration's kind, a reference's role and a literal's kind each map to one of CODE_TOKENS. A
// reference paints by its role inside a template substitution too, since nothing language-agnostic
// tells a substitution's extent from any other gap between two strings. Where facts overlap, the
// narrower one wins, since a declaration's range can be its whole body when it has no name of its
// own. Keywords, builtins and literal words fill identifier-shaped runs no fact covers.

import type { Session } from "@nyaa-lexicon/client";
import { hashContent, type PaintFacts, type Position, type ProviderWords, type Range } from "@nyaa-lexicon/protocol";
import { CODE_TOKENS } from "../../shared/schemasWorkspace.js";
import { byDeadline } from "./handlerKit.js";

////////////////////////////////
//  Interfaces & Types

export type CodeToken = (typeof CODE_TOKENS)[number];

export type FactsOutcome = { facts: PaintFacts } | { reason: string };

////////////////////////////////
//  Constants

const CODE_OF_TOKEN = new Map<CodeToken, number>(CODE_TOKENS.map((token, index) => [token, index]));

/** A declaration's name span, by kind. Unlisted kinds paint nothing. */
const DECLARATION_TOKEN: ReadonlyMap<string, CodeToken> = new Map([
	["class", "type"],
	["interface", "type"],
	["struct", "type"],
	["enum", "type"],
	["typeParameter", "type"],
	["namespace", "type"],
	["module", "type"],
	["package", "type"],
	["file", "type"],
	["function", "function"],
	["method", "function"],
	["constructor", "function"],
	["operator", "function"],
	["field", "attribute"],
	["property", "property"],
	["variable", "variable"],
	["constant", "variable"],
	["event", "variable"],
	["heading", "section"],
]);

const REFERENCE_TOKEN: ReadonlyMap<string, CodeToken> = new Map([
	["call", "function"],
	["typeUse", "type"],
	["extends", "type"],
	["implements", "type"],
	["instantiate", "type"],
	["read", "variable"],
	["write", "variable"],
	["import", "variable"],
	["export", "variable"],
]);

const LITERAL_TOKEN: ReadonlyMap<string, CodeToken> = new Map([
	["string", "string"],
	["number", "number"],
	["boolean", "literal"],
]);

/** Unicode-aware, so an identifier in any script is a candidate word. */
const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/gu;

////////////////////////////////
//  Functions & Helpers

function code(token: CodeToken): number {
	return CODE_OF_TOKEN.get(token) as number;
}

/** One past each line's LF, so a Position converts without rescanning. */
export function lineStartsOf(text: string): number[] {
	const starts = [0];
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 0x0a) starts.push(index + 1);
	return starts;
}

/** A line's content stops before its `\r`, matching how the phone counts a raw file's lines. */
function lineEnd(text: string, start: number): number {
	const newline = text.indexOf("\n", start);
	const end = newline === -1 ? text.length : newline;
	return end > start && text.charCodeAt(end - 1) === 0x0d ? end - 1 : end;
}

/** Clamped to its own line's content, or a column past the line's end would bleed into the next one. */
export function offsetOf(lineStarts: readonly number[], text: string, position: Position): number {
	const start = lineStarts[position.line] ?? text.length;
	return Math.min(lineEnd(text, start), Math.max(start, start + position.character));
}

export function rangeOffsets(lineStarts: readonly number[], text: string, range: Range): [number, number] {
	return [offsetOf(lineStarts, text, range.start), offsetOf(lineStarts, text, range.end)];
}

function newBuffer(length: number): number[] {
	return new Array(length).fill(-1);
}

function paintRange(buffer: number[], start: number, end: number, token: number): void {
	const from = Math.max(0, start);
	const to = Math.min(buffer.length, end);
	for (let index = from; index < to; index++) buffer[index] = token;
}

/** A word escaped from meaning a keyword: Kotlin backticks, a C# `@name`, a Rust raw `r#name`. */
function escapedWord(text: string, start: number, end: number): boolean {
	if (text.charCodeAt(start - 1) === 0x40) return true; // "@"
	if (text.charCodeAt(start - 2) === 0x72 && text.charCodeAt(start - 1) === 0x23) return true; // "r#"
	if (text.charCodeAt(start - 1) === 0x60 && text.charCodeAt(end) === 0x60) return true; // `...`
	return false;
}

function paintWords(buffer: number[], text: string, words: ProviderWords): void {
	if (words.keywords.length === 0 && words.builtins.length === 0 && words.literals.length === 0) return;
	const keywords = new Set(words.keywords);
	const builtins = new Set(words.builtins);
	const literals = new Set(words.literals);
	for (const match of text.matchAll(IDENTIFIER)) {
		const start = match.index;
		const end = start + match[0].length;
		let covered = false;
		for (let index = start; index < end && !covered; index++) covered = buffer[index] !== -1;
		if (covered || escapedWord(text, start, end)) continue;
		const word = match[0];
		const token = keywords.has(word)
			? "keyword"
			: builtins.has(word)
				? "builtin"
				: literals.has(word)
					? "literal"
					: null;
		if (token !== null) paintRange(buffer, start, end, code(token));
	}
}

/** A category's rank, the tiebreak once width and start already agree. */
const CATEGORY_RANK: Readonly<Record<"comment" | "literal" | "declaration" | "reference", number>> = {
	comment: 0,
	literal: 1,
	declaration: 2,
	reference: 3,
};

interface PaintSpan {
	start: number;
	end: number;
	token: number;
	category: keyof typeof CATEGORY_RANK;
}

/**
 * Per character, the token painted there, or -1. Every fact becomes a span, and spans paint widest
 * first, narrowest last, so a span nested inside another overwrites exactly the cells it covers: a
 * declaration with no name of its own (its range the whole body) does not swallow the literal or
 * reference sitting inside it. Ties break on start, then a fixed category order, so painting stays
 * deterministic. Words fill in last, only where nothing else painted.
 */
export function paintBuffer(text: string, facts: PaintFacts): number[] {
	const buffer = newBuffer(text.length);
	const lineStarts = lineStartsOf(text);
	const offsetsOf = (range: Range) => rangeOffsets(lineStarts, text, range);

	const spans: PaintSpan[] = [];

	for (const literal of facts.literals) {
		const [start, end] = offsetsOf(literal.range);
		spans.push({ start, end, token: code(LITERAL_TOKEN.get(literal.kind) ?? "literal"), category: "literal" });
	}

	for (const declaration of facts.declarations) {
		const token = DECLARATION_TOKEN.get(declaration.kind);
		if (token === undefined) continue;
		const [start, end] = offsetsOf(declaration.range);
		spans.push({ start, end, token: code(token), category: "declaration" });
	}

	for (const reference of facts.references) {
		const [start, end] = offsetsOf(reference.range);
		spans.push({
			start,
			end,
			token: code(REFERENCE_TOKEN.get(reference.role) ?? "variable"),
			category: "reference",
		});
	}

	for (const comment of facts.comments) {
		const [start, end] = offsetsOf(comment.range);
		spans.push({ start, end, token: code("comment"), category: "comment" });
	}

	spans.sort(
		(a, b) =>
			b.end - b.start - (a.end - a.start) ||
			a.start - b.start ||
			CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category],
	);
	for (const span of spans) paintRange(buffer, span.start, span.end, span.token);

	paintWords(buffer, text, facts.words);

	return buffer;
}

/** Run-length encodes a painted buffer into per-line `[start, length, token]` triples. */
export function linesOf(text: string, buffer: readonly number[]): number[][] {
	const lines: number[][] = [];
	let lineStart = 0;
	for (;;) {
		const shownEnd = lineEnd(text, lineStart);
		const triples: number[] = [];
		let runToken = -1;
		let runStart = lineStart;
		for (let at = lineStart; at <= shownEnd; at++) {
			const token = at < shownEnd ? (buffer[at] ?? -1) : -1;
			if (token !== runToken) {
				if (runToken !== -1 && at > runStart) triples.push(runStart - lineStart, at - runStart, runToken);
				runToken = token;
				runStart = at;
			}
		}
		lines.push(triples);
		const newline = text.indexOf("\n", lineStart);
		if (newline === -1) break;
		lineStart = newline + 1;
	}
	return lines;
}

export function spansFromFacts(text: string, facts: PaintFacts): number[][] {
	return linesOf(text, paintBuffer(text, facts));
}

/** A sub-range of an already-painted module, relined against the span's own text. */
export function spansOfSpan(moduleText: string, facts: PaintFacts, range: Range, spanText: string): number[][] {
	const buffer = paintBuffer(moduleText, facts);
	const lineStarts = lineStartsOf(moduleText);
	const [from, to] = rangeOffsets(lineStarts, moduleText, range);
	return linesOf(spanText, buffer.slice(from, to));
}

/**
 * The store's rows when they describe exactly `text`, at full depth; otherwise a fresh parse of
 * `text` as the candidate. Never a guess: any failure to reach that answers a reason, not spans.
 */
export async function factsForModule(
	session: Session,
	module: string,
	text: string,
	deadline: number,
): Promise<FactsOutcome> {
	try {
		const stored = await byDeadline(deadline, () => session.moduleFacts({ module }));
		if (stored.known && stored.depth === "full" && stored.contentHash === hashContent(text))
			return { facts: stored };
		const parsed = await byDeadline(deadline, () => session.parseFacts({ module, text }));
		return parsed.ok ? { facts: parsed } : { reason: parsed.reason };
	} catch (error) {
		return { reason: error instanceof Error ? error.message : String(error) };
	}
}

/** A line's triples within `[from, to)`, from zero. */
export function sliceSpans(triples: readonly number[], from: number, to: number): number[] {
	const sliced: number[] = [];
	for (let index = 0; index + 2 < triples.length; index += 3) {
		const start = Math.max(triples[index] as number, from);
		const end = Math.min((triples[index] as number) + (triples[index + 1] as number), to);
		if (end > start) sliced.push(start - from, end - start, triples[index + 2] as number);
	}
	return sliced;
}
