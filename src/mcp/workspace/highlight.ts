// Code spans: highlight.js's HTML read into per-line `[start, length, token]` triples.
//
// The HTML never leaves this module. The parser accepts only what highlight.js renders, and refuses
// anything else rather than guessing.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { CODE_TOKENS } from "../../shared/schemasWorkspace.js";

////////////////////////////////
//  Interfaces & Types

export type CodeToken = (typeof CODE_TOKENS)[number];

////////////////////////////////
//  Constants

export const GRAMMARS = {
	bash,
	c,
	cpp,
	csharp,
	css,
	javascript,
	json,
	kotlin,
	markdown,
	python,
	rust,
	typescript,
	xml,
	yaml,
};

/** Lexicon language to grammar. */
const GRAMMAR_OF: Readonly<Record<string, keyof typeof GRAMMARS>> = {
	bash: "bash",
	c: "c",
	cpp: "cpp",
	csharp: "csharp",
	css: "css",
	// No GDScript grammar; closest kin.
	gdscript: "python",
	html: "xml",
	javascript: "javascript",
	json: "json",
	kotlin: "kotlin",
	markdown: "markdown",
	python: "python",
	rust: "rust",
	typescript: "typescript",
	xml: "xml",
	yaml: "yaml",
};

/**
 * Every scope the registered grammars emit. `null` is a container that colours nothing itself, so its
 * text keeps the enclosing token. A scope missing here refuses the file; a test walks every grammar.
 */
export const TOKEN_OF_SCOPE: Readonly<Record<string, CodeToken | null>> = {
	keyword: "keyword",
	"template-tag": "keyword",
	"template-variable": "keyword",
	"variable.language": "keyword",
	type: "type",
	"title.class": "type",
	"title.class.inherited": "type",
	title: "function",
	"title.function": "function",
	"title.function.invoke": "function",
	"function.dispatch": "function",
	built_in: "builtin",
	symbol: "builtin",
	string: "string",
	"char.escape": "escape",
	subst: "interpolation",
	regexp: "regexp",
	number: "number",
	literal: "literal",
	"variable.constant": "literal",
	comment: "comment",
	doctag: "doctag",
	meta: "meta",
	"meta.prompt": "meta",
	attr: "attribute",
	attribute: "attribute",
	property: "property",
	variable: "variable",
	params: "params",
	operator: "operator",
	punctuation: "punctuation",
	tag: "tag",
	name: "name",
	"selector-tag": "name",
	"selector-id": "selector",
	"selector-class": "selector",
	"selector-attr": "selector",
	"selector-pseudo": "selector",
	keyframePosition: "selector",
	section: "section",
	bullet: "bullet",
	emphasis: "emphasis",
	strong: "strong",
	addition: "addition",
	deletion: "deletion",
	link: "link",
	quote: "quote",
	code: "code",
	formula: "code",
	function: null,
	class: null,
};

const CODE_OF_TOKEN = new Map<string, number>(CODE_TOKENS.map((token, code) => [token, code]));

/** What `escapeHTML` writes. */
const ENTITIES: ReadonlyArray<readonly [string, number]> = [
	["&amp;", 0x26],
	["&lt;", 0x3c],
	["&gt;", 0x3e],
	["&quot;", 0x22],
	["&#x27;", 0x27],
];

const SPAN_OPEN = '<span class="';
const SPAN_CLOSE = "</span>";
const CLASS_TEXT = /^[A-Za-z0-9_\- ]+$/;
const TIER = /^([A-Za-z0-9-]+)(_+)$/;

////////////////////////////////
//  Functions & Helpers

const highlighter = hljs.newInstance();
for (const [name, grammar] of Object.entries(GRAMMARS)) highlighter.registerLanguage(name, grammar);

export function highlightable(language: string | undefined): language is string {
	return language !== undefined && Object.hasOwn(GRAMMAR_OF, language);
}

/** Undefined for an unregistered class. */
function tokenOfClass(className: string): number | null | undefined {
	const classes = className.split(" ");
	const head = classes[0] ?? "";
	if (classes.length === 1 && /^language-[A-Za-z0-9-]+$/.test(head)) return null;
	if (!head.startsWith("hljs-")) return undefined;
	const tiers = [head.slice("hljs-".length)];
	for (let index = 1; index < classes.length; index++) {
		const tier = TIER.exec(classes[index] ?? "");
		if (tier === null || (tier[2] as string).length !== index) return undefined;
		tiers.push(tier[1] as string);
	}
	const scope = tiers.join(".");
	if (!Object.hasOwn(TOKEN_OF_SCOPE, scope)) return undefined;
	const token = TOKEN_OF_SCOPE[scope];
	return token === null || token === undefined ? null : CODE_OF_TOKEN.get(token);
}

function lineEnd(text: string, start: number): number {
	const newline = text.indexOf("\n", start);
	const end = newline === -1 ? text.length : newline;
	return end > start && text.charCodeAt(end - 1) === 0x0d ? end - 1 : end;
}

/**
 * Per line of `text`, the innermost token wins, and a line's triples stop before its `\r`. Null when
 * `html` is not exactly highlight.js's rendering of `text`.
 */
export function spansFromHtml(text: string, html: string): number[][] | null {
	const lines: number[][] = [[]];
	const effective: (number | null)[] = [];
	let lineStart = 0;
	let shownEnd = lineEnd(text, 0);
	let runToken: number | null = null;
	let runStart = 0;
	let at = 0;
	let offset = 0;

	const closeRun = () => {
		if (runToken === null) return;
		const end = Math.min(offset, shownEnd);
		if (end > runStart) (lines.at(-1) as number[]).push(runStart - lineStart, end - runStart, runToken);
		runToken = null;
	};
	const emit = (code: number) => {
		if (offset >= text.length || text.charCodeAt(offset) !== code) return false;
		const token = effective.at(-1) ?? null;
		if (code === 0x0a) {
			closeRun();
			offset++;
			lineStart = offset;
			shownEnd = lineEnd(text, offset);
			lines.push([]);
			return true;
		}
		if (token !== runToken) {
			closeRun();
			runToken = token;
			runStart = offset;
		}
		offset++;
		return true;
	};

	while (at < html.length) {
		const code = html.charCodeAt(at);
		if (code === 0x3c) {
			if (html.startsWith(SPAN_OPEN, at)) {
				const close = html.indexOf('">', at + SPAN_OPEN.length);
				if (close === -1) return null;
				const className = html.slice(at + SPAN_OPEN.length, close);
				if (!CLASS_TEXT.test(className)) return null;
				const token = tokenOfClass(className);
				if (token === undefined) return null;
				effective.push(token ?? effective.at(-1) ?? null);
				at = close + 2;
			} else if (html.startsWith(SPAN_CLOSE, at)) {
				if (effective.pop() === undefined) return null;
				at += SPAN_CLOSE.length;
			} else {
				return null;
			}
			continue;
		}
		if (code === 0x26) {
			const entity = ENTITIES.find(([spelled]) => html.startsWith(spelled, at));
			if (entity === undefined || !emit(entity[1])) return null;
			at += entity[0].length;
			continue;
		}
		if (code === 0x3e || code === 0x22 || code === 0x27 || !emit(code)) return null;
		at++;
	}
	if (effective.length > 0 || offset !== text.length) return null;
	closeRun();
	return lines;
}

/** Null when highlight.js rendered something the parser refuses. */
export function lineSpansOf(language: string, text: string): number[][] | null {
	const grammar = GRAMMAR_OF[language];
	if (grammar === undefined) return null;
	const html = highlighter.highlight(text, { language: grammar, ignoreIllegals: true }).value;
	return spansFromHtml(text, html);
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
