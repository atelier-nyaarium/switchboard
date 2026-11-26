/** Reserved words. */
export const SCRIPT_RESERVED = [
	"if",
	"else",
	"try",
	"catch",
	"exit",
	"throw",
	"wait",
	"parallel",
	"start",
	"await",
	"all",
	"any",
] as const;
export type ScriptWord = (typeof SCRIPT_RESERVED)[number];

export const SCRIPT_BLOCK_WORDS: readonly ScriptWord[] = ["if", "else", "try", "catch", "parallel"];

export const SCRIPT_SOURCE_MAX = 24_000;

export type ScriptPieceKind = "comment" | "word" | "open" | "close" | "code";

/** UTF-16 offsets, end-exclusive. */
export interface ScriptPiece {
	kind: ScriptPieceKind;
	start: number;
	end: number;
	/** Code a comment cut from its statement. */
	joins?: true;
}

const RESERVED = new Set<string>(SCRIPT_RESERVED);

export const opensStatement = (name: string): boolean => RESERVED.has(name);
const BLOCK = new Set<string>(SCRIPT_BLOCK_WORDS);

const isIdentStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentPart = (c: string) => isIdentStart(c) || (c >= "0" && c <= "9");

export function scanScript(source: string): ScriptPiece[] {
	const pieces: ScriptPiece[] = [];
	const length = source.length;
	let at = 0;
	/** Open `(`, `[` and record `{`. */
	let depth = 0;
	let code = -1;
	let last = -1;
	let lead: string | null = null;
	/** Statement may start. */
	let fresh = true;
	let continued = false;

	const mark = (start: number, end: number) => {
		if (code < 0) code = start;
		last = end;
	};
	const flush = () => {
		if (code < 0) return;
		pieces.push({ kind: "code", start: code, end: last, ...(continued ? { joins: true as const } : {}) });
		code = -1;
		continued = false;
	};
	const endStatement = () => {
		depth = 0;
		lead = null;
		fresh = true;
		continued = false;
	};

	while (at < length) {
		const c = source[at] as string;
		if (c === "\n") {
			if (depth === 0) {
				flush();
				endStatement();
			}
			at++;
			continue;
		}
		if (c === " " || c === "\t" || c === "\r") {
			at++;
			continue;
		}
		if (c === "/" && source[at + 1] === "/") {
			flush();
			const line = source.indexOf("\n", at);
			const stop = line < 0 ? length : line;
			// A line's `\r` is no part of it.
			const end = stop > at + 2 && source[stop - 1] === "\r" ? stop - 1 : stop;
			pieces.push({ kind: "comment", start: at, end });
			at = stop;
			continued = depth > 0;
			continue;
		}
		if (fresh && isIdentStart(c)) {
			let end = at + 1;
			while (end < length && isIdentPart(source[end] as string)) end++;
			const word = source.slice(at, end);
			if (RESERVED.has(word)) {
				pieces.push({ kind: "word", start: at, end });
				lead = word;
				// Only `else` takes a second word.
				fresh = word === "else";
				at = end;
				continue;
			}
		}
		fresh = false;
		if (c === '"' || c === "'") {
			let end = at + 1;
			while (end < length) {
				const ch = source[end] as string;
				// An open string ends with its line.
				if (ch === "\n") break;
				if (ch === "\\" && end + 1 < length && source[end + 1] !== "\n") {
					end += 2;
					continue;
				}
				end++;
				if (ch === c) break;
			}
			mark(at, end);
			at = end;
			continue;
		}
		if (c === "{" && depth === 0 && lead !== null && BLOCK.has(lead)) {
			flush();
			pieces.push({ kind: "open", start: at, end: at + 1 });
			endStatement();
			at++;
			continue;
		}
		if (c === "}" && depth === 0) {
			flush();
			pieces.push({ kind: "close", start: at, end: at + 1 });
			endStatement();
			at++;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
		mark(at, at + 1);
		at++;
	}
	flush();
	return pieces;
}
