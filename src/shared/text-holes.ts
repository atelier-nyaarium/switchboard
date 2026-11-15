/** UTF-16 offsets, end-exclusive. */
export type HolePart =
	| { kind: "text"; text: string; start: number; end: number }
	/** An open hole runs to the end. */
	| { kind: "hole"; source: string; start: number; end: number; closed: boolean };

const ESCAPED = new Set(["{", "}", "\\"]);

/** Braces nest; quotes hide braces. */
function holeEnd(text: string, open: number): number {
	let depth = 0;
	let at = open;
	while (at < text.length) {
		const c = text[at] as string;
		if (c === '"' || c === "'") {
			at++;
			while (at < text.length && text[at] !== c) at += text[at] === "\\" ? 2 : 1;
			at++;
			continue;
		}
		if (c === "{") depth++;
		if (c === "}" && --depth === 0) return at + 1;
		at++;
	}
	return -1;
}

/** Escapes `\{` `\}` `\\`; a lone `}` is text. */
export function scanHoles(text: string): HolePart[] {
	const parts: HolePart[] = [];
	let run = "";
	let runStart = 0;
	let at = 0;
	const flush = (end: number) => {
		if (end > runStart) parts.push({ kind: "text", text: run, start: runStart, end });
		run = "";
	};
	while (at < text.length) {
		const c = text[at] as string;
		const next = text[at + 1];
		if (c === "\\" && next !== undefined && ESCAPED.has(next)) {
			run += next;
			at += 2;
			continue;
		}
		if (c !== "{") {
			run += c;
			at++;
			continue;
		}
		flush(at);
		const end = holeEnd(text, at);
		const closed = end !== -1;
		const stop = closed ? end : text.length;
		parts.push({
			kind: "hole",
			source: text.slice(at + 1, closed ? stop - 1 : stop),
			start: at,
			end: stop,
			closed,
		});
		at = stop;
		runStart = at;
	}
	flush(text.length);
	return parts;
}

export const hasHoles = (text: string): boolean => scanHoles(text).some((part) => part.kind === "hole");

/** What a hole that could not be read prints. */
export const HOLE_FAILED = "{?}";

/** The text with every hole marked unread. */
export const unreadText = (text: string): string =>
	scanHoles(text)
		.map((part) => (part.kind === "text" ? part.text : HOLE_FAILED))
		.join("");

export const unescapedText = (text: string): string =>
	scanHoles(text)
		.map((part) => (part.kind === "text" ? part.text : text.slice(part.start, part.end)))
		.join("");
