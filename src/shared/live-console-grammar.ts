export const CONSOLE_SOURCE_MAX = 2_000;
export const CONSOLE_NODES_MAX = 256;
export const CONSOLE_STATEMENTS_MAX = 16;
export const CONSOLE_DEPTH_MAX = 64;
export const CONSOLE_STRING_NEST_MAX = 8;

const KEYWORDS = new Set(["true", "false", "null"]);
/** Operators spelled as words. */
export const CONSOLE_WORD_OPS = ["and", "or"] as const;
const WORD_OPS = new Set<string>(CONSOLE_WORD_OPS);
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

/** Record parsing drops `__proto__`. */
export const isConsoleVariableName = (name: string): boolean =>
	VARIABLE_NAME.test(name) && name !== "__proto__" && !KEYWORDS.has(name) && !WORD_OPS.has(name);

/** UTF-16 offsets, end-exclusive. */
export interface ConsoleIssue {
	code: string;
	start: number;
	end: number;
	message: string;
}

/** Only a script lexes `comment` and `newline`. */
export type ConsoleTokenKind =
	| "ident"
	| "number"
	| "string"
	| "keyword"
	| "punct"
	| "op"
	| "error"
	| "comment"
	| "newline";

interface Span {
	start: number;
	end: number;
}

export type ConsoleStringPart = Span &
	(
		| { kind: "text"; value: string }
		| { kind: "escape"; value: string }
		/** An open hole runs to the end. */
		| { kind: "hole"; tokens: ConsoleToken[]; closed: boolean }
	);

export interface ConsoleToken {
	kind: ConsoleTokenKind;
	text: string;
	start: number;
	end: number;
	closed?: boolean;
	value?: string;
	parts?: ConsoleStringPart[];
}

const PUNCT = new Set([".", "(", ")", "[", "]", "{", "}", ",", ":", ";"]);
const TWO_CHAR_OPS = new Set(["==", "!=", "<=", ">="]);
const ONE_CHAR_OPS = new Set(["!", "+", "-", "*", "/", "=", "<", ">"]);

export const CONSOLE_BINARY_OPS = ["or", "and", "==", "!=", "<", ">", "<=", ">=", "+", "-", "*", "/"] as const;
export type ConsoleBinaryOp = (typeof CONSOLE_BINARY_OPS)[number];
const BODY_ESCAPES: Readonly<Record<string, string>> = { "{": "{", "}": "}", "\\": "\\" };
const QUOTED_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", '"': '"', "'": "'" };

const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdentStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

class Lexer {
	private at = 0;

	constructor(
		private readonly source: string,
		private readonly script: boolean,
	) {}

	/** `bound`: inside a quoted string, ends at the line. */
	code(nest: number, bound: boolean): { tokens: ConsoleToken[]; closed: boolean } {
		const { source } = this;
		const lines = this.script && nest === 0;
		const tokens: ConsoleToken[] = [];
		let depth = 0;
		while (this.at < source.length) {
			const c = source[this.at] as string;
			if (bound && (c === "\n" || c === "\r")) return { tokens, closed: false };
			if (c === "\n" && lines) {
				tokens.push({ kind: "newline", text: c, start: this.at, end: this.at + 1 });
				this.at++;
				continue;
			}
			if (isSpace(c)) {
				this.at++;
				continue;
			}
			const start = this.at;
			if (lines && c === "/" && source[start + 1] === "/") {
				const line = source.indexOf("\n", start);
				let end = line < 0 ? source.length : line;
				if (source[end - 1] === "\r") end--;
				tokens.push({ kind: "comment", text: source.slice(start, end), start, end });
				this.at = end;
				continue;
			}
			if (isIdentStart(c)) {
				while (this.at < source.length && isIdentPart(source[this.at] as string)) this.at++;
				const text = source.slice(start, this.at);
				const kind = KEYWORDS.has(text) ? "keyword" : WORD_OPS.has(text) ? "op" : "ident";
				tokens.push({ kind, text, start, end: this.at });
				continue;
			}
			if (isDigit(c)) {
				while (this.at < source.length && isDigit(source[this.at] as string)) this.at++;
				if (source[this.at] === "." && isDigit(source[this.at + 1] ?? "")) {
					this.at++;
					while (this.at < source.length && isDigit(source[this.at] as string)) this.at++;
				}
				tokens.push({ kind: "number", text: source.slice(start, this.at), start, end: this.at });
				continue;
			}
			if (c === '"' || c === "'") {
				this.at++;
				const { parts, closed } = this.body(c, nest);
				const constant = parts.every((part) => part.kind !== "hole");
				tokens.push({
					kind: "string",
					text: source.slice(start, this.at),
					start,
					end: this.at,
					closed,
					...(constant ? { value: parts.map((part) => part.value).join("") } : {}),
					parts,
				});
				continue;
			}
			if (nest > 0 && c === "}" && depth === 0) {
				this.at++;
				return { tokens, closed: true };
			}
			const two = source.slice(start, start + 2);
			if (TWO_CHAR_OPS.has(two)) {
				this.at += 2;
				tokens.push({ kind: "op", text: two, start, end: this.at });
				continue;
			}
			this.at++;
			if (c === "{") depth++;
			if (c === "}") depth--;
			const kind: ConsoleTokenKind = PUNCT.has(c) ? "punct" : ONE_CHAR_OPS.has(c) ? "op" : "error";
			tokens.push({ kind, text: c, start, end: this.at });
		}
		return { tokens, closed: nest === 0 };
	}

	body(quote: string | null, nest: number): { parts: ConsoleStringPart[]; closed: boolean } {
		const { source } = this;
		const parts: ConsoleStringPart[] = [];
		let run = -1;
		const flush = () => {
			if (run >= 0) parts.push({ kind: "text", value: source.slice(run, this.at), start: run, end: this.at });
			run = -1;
		};
		while (this.at < source.length) {
			const c = source[this.at] as string;
			if (c === quote) {
				flush();
				this.at++;
				return { parts, closed: true };
			}
			// A quoted string ends at its line.
			if (quote !== null && (c === "\n" || c === "\r")) break;
			const next = source[this.at + 1];
			// Other backslashes are text.
			const escaped =
				c === "\\" && next !== undefined
					? (BODY_ESCAPES[next] ?? (quote === null ? undefined : QUOTED_ESCAPES[next]))
					: undefined;
			if (escaped !== undefined) {
				flush();
				parts.push({ kind: "escape", value: escaped, start: this.at, end: this.at + 2 });
				this.at += 2;
				continue;
			}
			if (c !== "{") {
				if (run < 0) run = this.at;
				this.at++;
				continue;
			}
			flush();
			const start = this.at;
			this.at++;
			if (nest >= CONSOLE_STRING_NEST_MAX) {
				const brace: ConsoleToken = { kind: "error", text: c, start, end: start + 1 };
				parts.push({ kind: "hole", tokens: [brace], closed: false, start, end: source.length });
				this.at = source.length;
				return { parts, closed: false };
			}
			const { tokens, closed } = this.code(nest + 1, quote !== null);
			parts.push({ kind: "hole", tokens, closed, start, end: this.at });
		}
		flush();
		return { parts, closed: quote === null };
	}
}

/** Minus is always separate. */
export const lexConsole = (source: string): ConsoleToken[] => new Lexer(source, false).code(0, false).tokens;

export const lexScript = (source: string): ConsoleToken[] => new Lexer(source, true).code(0, false).tokens;

export function trimConsole(source: string): string {
	const tokens = lexConsole(source);
	const [first] = tokens;
	const last = tokens.at(-1);
	return first && last ? source.slice(first.start, last.end) : "";
}

export const lexConsoleText = (text: string): ConsoleStringPart[] => new Lexer(text, false).body(null, 0).parts;

export type ConsoleStringPiece = Span & ({ kind: "text"; value: string } | { kind: "escape"; value: string });

export type ConsoleTemplatePiece =
	| ConsoleStringPiece
	| (Span & { kind: "hole"; node: ConsoleNode | null; closed: boolean; broken: boolean });

export type ConsoleNode = Span & {
	grouped?: true;
} & (
		| { kind: "literal"; value: string | number | boolean | null; pieces?: ConsoleStringPiece[] }
		| { kind: "template"; pieces: ConsoleTemplatePiece[]; closed: boolean }
		| { kind: "ident"; name: string }
		| { kind: "member"; target: ConsoleNode; name: string; closed: boolean }
		| { kind: "call"; target: ConsoleNode; args: ConsoleNode[]; closed: boolean }
		| { kind: "index"; target: ConsoleNode; index: ConsoleNode | null; closed: boolean }
		| { kind: "unary"; op: "-" | "!"; operand: ConsoleNode }
		| { kind: "binary"; op: ConsoleBinaryOp; left: ConsoleNode; right: ConsoleNode }
		| { kind: "list"; items: ConsoleNode[]; closed: boolean }
		| { kind: "dict"; entries: (Span & { key: string; value: ConsoleNode })[]; closed: boolean }
	);

export interface ConsoleStatement extends Span {
	node: ConsoleNode;
	/** Leading names may save. */
	assign?: Span & { name: string };
}

export interface ConsoleParse {
	/** Semicolon-separated statements. */
	statements: ConsoleStatement[];
	/** Partial input parses. */
	issues: ConsoleIssue[];
}

/** A word operator; still a name after `.` and as a key. */
const wordOp = (token: ConsoleToken): boolean => token.kind === "op" && WORD_OPS.has(token.text);

export const COMMENT_LOST = "a comment here would be lost; put it on its own line";

export class ConsoleParser {
	protected at = 0;
	private nodes = 0;
	private depth = 0;
	/** Open brackets; line breaks are space. */
	private nest = 0;
	protected faults = 0;
	/** Faults inside a faulted bracket stay silent. */
	private muted = 0;
	readonly issues: ConsoleIssue[] = [];

	constructor(
		protected tokens: readonly ConsoleToken[],
		protected length: number,
		private readonly nodesMax: number = CONSOLE_NODES_MAX,
	) {}

	private skipLines(): void {
		if (this.nest === 0) return;
		while (true) {
			const token = this.tokens[this.at];
			if (token?.kind === "comment") this.issue("unexpected", token.start, token.end, COMMENT_LOST);
			else if (token?.kind !== "newline") return;
			this.at++;
		}
	}

	protected peek(offset = 0): ConsoleToken | undefined {
		this.skipLines();
		return this.tokens[this.at + offset];
	}

	protected is(text: string): boolean {
		const token = this.peek();
		return token !== undefined && (token.kind === "punct" || token.kind === "op") && token.text === text;
	}

	protected take(): ConsoleToken | undefined {
		this.skipLines();
		return this.tokens[this.at++];
	}

	protected issue(code: string, start: number, end: number, message: string): void {
		this.faults++;
		if (this.muted === 0 && this.issues.length < 8) this.issues.push({ code, start, end, message });
	}

	private node<N extends ConsoleNode>(node: N): N {
		this.nodes++;
		if (this.nodes === this.nodesMax + 1) {
			this.issue("too_big", node.start, node.end, `more than ${this.nodesMax} nodes`);
		}
		return node;
	}

	protected fresh(): void {
		this.nodes = 0;
	}

	private end(): number {
		return this.peek()?.start ?? this.length;
	}

	parse(): ConsoleStatement[] {
		const statements: ConsoleStatement[] = [];
		while (this.peek()) {
			if (this.is(";")) {
				this.take();
				continue;
			}
			const first = this.peek() as ConsoleToken;
			if (statements.length === CONSOLE_STATEMENTS_MAX) {
				this.issue("too_big", first.start, this.length, `more than ${CONSOLE_STATEMENTS_MAX} statements`);
				break;
			}
			const equals = this.peek(1);
			let assign: ConsoleStatement["assign"];
			if (first.kind === "ident" && equals?.kind === "op" && equals.text === "=") {
				assign = { name: first.text, start: first.start, end: first.end };
				this.at += 2;
			}
			const node = this.expression();
			statements.push({ node, start: first.start, end: node.end, ...(assign ? { assign } : {}) });
			const rest = this.peek();
			if (rest && !this.is(";")) {
				const saving = rest.text === "=";
				this.issue(
					saving ? "assignment" : "unexpected",
					rest.start,
					rest.end,
					saving ? "only a name at the start of a statement can be saved" : `unexpected ${rest.text}`,
				);
				break;
			}
		}
		return statements;
	}

	protected expression(): ConsoleNode {
		return this.binary(0);
	}

	protected enclosed(close: string, start: number): ConsoleNode | null {
		const opened = this.open();
		const node = this.expression();
		return this.closeWith(close, start, opened) ? node : null;
	}

	/** One expression and nothing after it. */
	parseOne(): ConsoleNode {
		const node = this.expression();
		const rest = this.peek();
		if (rest) this.issue("unexpected", rest.start, rest.end, `unexpected ${rest.text}`);
		return node;
	}

	parseText(parts: readonly ConsoleStringPart[]): ConsoleNode {
		return this.string(parts, 0, this.length, true);
	}

	/** Loosest first. */
	private static readonly LEVELS: readonly (readonly ConsoleBinaryOp[])[] = [
		["or"],
		["and"],
		["==", "!="],
		["<", ">", "<=", ">="],
		["+", "-"],
		["*", "/"],
	];

	private binary(level: number): ConsoleNode {
		const ops = ConsoleParser.LEVELS[level];
		if (!ops) return this.unary();
		let left = this.binary(level + 1);
		while (ops.some((op) => this.is(op))) {
			const op = this.take()?.text as ConsoleBinaryOp;
			const right = this.binary(level + 1);
			left = this.node({ kind: "binary", op, left, right, start: left.start, end: right.end });
		}
		return left;
	}

	private unary(): ConsoleNode {
		if (this.depth >= CONSOLE_DEPTH_MAX) {
			const at = this.end();
			this.issue("too_big", at, at, `nested more than ${CONSOLE_DEPTH_MAX} deep`);
			return { kind: "literal", value: null, start: at, end: at };
		}
		this.depth++;
		try {
			if (this.is("-") || this.is("!")) {
				const token = this.take() as ConsoleToken;
				const operand = this.unary();
				return this.node({
					kind: "unary",
					op: token.text as "-" | "!",
					operand,
					start: token.start,
					end: operand.end,
				});
			}
			return this.postfix(this.primary());
		} finally {
			this.depth--;
		}
	}

	private postfix(base: ConsoleNode): ConsoleNode {
		let node = base;
		while (true) {
			if (this.is(".")) {
				const dot = this.take() as ConsoleToken;
				const name = this.peek();
				if (name && (name.kind === "ident" || name.kind === "keyword" || wordOp(name))) {
					this.take();
					node = this.node({
						kind: "member",
						target: node,
						name: name.text,
						closed: true,
						start: node.start,
						end: name.end,
					});
				} else {
					this.issue("incomplete", dot.start, dot.end, "a name must follow .");
					node = this.node({
						kind: "member",
						target: node,
						name: "",
						closed: false,
						start: node.start,
						end: dot.end,
					});
					return node;
				}
				continue;
			}
			if (this.is("(")) {
				if (node.kind !== "ident" && node.kind !== "member") {
					const paren = this.peek() as ConsoleToken;
					this.issue("not_callable", paren.start, paren.end, "only a name can be called");
				}
				this.take();
				const opened = this.open();
				const args = this.items(")");
				const closed = this.closeWith(")", node.start, opened);
				node = this.node({
					kind: "call",
					target: node,
					args,
					closed,
					start: node.start,
					end: this.closedEnd(closed),
				});
				continue;
			}
			if (this.is("[")) {
				this.take();
				const opened = this.open();
				const index = this.is("]") || !this.peek() ? null : this.expression();
				const closed = this.closeWith("]", node.start, opened);
				if (index === null) this.issue("incomplete", node.start, this.end(), "an index must fill []");
				node = this.node({
					kind: "index",
					target: node,
					index,
					closed,
					start: node.start,
					end: this.closedEnd(closed),
				});
				continue;
			}
			return node;
		}
	}

	private closedEnd(closed: boolean): number {
		return closed ? (this.tokens[this.at - 1]?.end ?? this.length) : this.length;
	}

	private open(): number {
		this.nest++;
		return this.faults;
	}

	private closeWith(text: string, start: number, opened: number): boolean {
		const closed = this.is(text);
		if (closed) this.take();
		else if (this.faults === opened) this.issue("incomplete", start, this.end(), `missing ${text}`);
		this.nest--;
		return closed;
	}

	/** Trailing commas are allowed. */
	private items(close: string): ConsoleNode[] {
		const items: ConsoleNode[] = [];
		while (this.peek() && !this.is(close)) {
			items.push(this.expression());
			if (!this.is(",")) break;
			this.take();
		}
		return items;
	}

	private hole(part: ConsoleStringPart & { kind: "hole" }): ConsoleTemplatePiece {
		const { start, end, closed } = part;
		const outer = { tokens: this.tokens, at: this.at, length: this.length, nest: this.nest, nodes: this.nodes };
		const faults = this.faults;
		this.tokens = part.tokens;
		this.at = 0;
		this.length = closed ? end - 1 : end;
		this.nest = 0;
		this.nodes = 0;
		let node: ConsoleNode | null = null;
		if (!closed) this.issue("incomplete", start, end, "missing }");
		if (!closed) this.muted++;
		if (end - start > CONSOLE_SOURCE_MAX) {
			this.issue("too_big", start, end, `longer than ${CONSOLE_SOURCE_MAX} characters`);
		} else if (part.tokens.length === 0) {
			if (closed) this.issue("empty", start, end, "a hole needs an expression");
		} else {
			node = this.expression();
			const rest = this.peek();
			if (rest && (rest.text === ";" || rest.text === "=")) {
				this.issue("unexpected", start, end, "a hole holds one expression");
			} else if (rest) this.issue("unexpected", rest.start, rest.end, `unexpected ${rest.text}`);
		}
		if (!closed) this.muted--;
		Object.assign(this, outer);
		return { kind: "hole", node, closed, broken: this.faults !== faults, start, end };
	}

	private string(parts: readonly ConsoleStringPart[], start: number, end: number, closed: boolean): ConsoleNode {
		const pieces: ConsoleTemplatePiece[] = parts.map((part) => (part.kind === "hole" ? this.hole(part) : part));
		const constant = pieces.filter((piece) => piece.kind !== "hole");
		if (constant.length < pieces.length) return this.node({ kind: "template", pieces, closed, start, end });
		const value = constant.map((piece) => piece.value).join("");
		return this.node({ kind: "literal", value, pieces: constant, start, end });
	}

	private primary(): ConsoleNode {
		const token = this.take();
		if (!token || token.kind === "newline") {
			if (token) this.at--;
			const at = token?.start ?? this.length;
			this.issue("incomplete", at, at, "an expression is missing");
			return this.node({ kind: "literal", value: null, start: at, end: at });
		}
		switch (token.kind) {
			case "number": {
				const value = Number(token.text);
				if (!Number.isFinite(value)) this.issue("too_big", token.start, token.end, "number out of range");
				return this.node({
					kind: "literal",
					value: Number.isFinite(value) ? value : 0,
					start: token.start,
					end: token.end,
				});
			}
			case "string": {
				if (token.closed) return this.string(token.parts ?? [], token.start, token.end, true);
				this.issue("incomplete", token.start, token.end, "missing closing quote");
				this.muted++;
				const open = this.string(token.parts ?? [], token.start, token.end, false);
				this.muted--;
				return open;
			}
			case "keyword":
				return this.node({
					kind: "literal",
					value: token.text === "null" ? null : token.text === "true",
					start: token.start,
					end: token.end,
				});
			case "ident":
				return this.node({ kind: "ident", name: token.text, start: token.start, end: token.end });
			case "comment":
				this.issue("unexpected", token.start, token.end, COMMENT_LOST);
				return this.node({ kind: "literal", value: null, start: token.start, end: token.end });
			case "error":
				this.issue("unexpected", token.start, token.end, `unexpected ${token.text}`);
				return this.node({ kind: "literal", value: null, start: token.start, end: token.end });
		}
		if (token.text === "(") {
			const opened = this.open();
			const inner = this.expression();
			const closed = this.closeWith(")", token.start, opened);
			return { ...inner, grouped: true, start: token.start, end: this.closedEnd(closed) };
		}
		if (token.text === "[") {
			const opened = this.open();
			const items = this.items("]");
			const closed = this.closeWith("]", token.start, opened);
			return this.node({ kind: "list", items, closed, start: token.start, end: this.closedEnd(closed) });
		}
		if (token.text === "{") {
			const opened = this.open();
			const entries: (Span & { key: string; value: ConsoleNode })[] = [];
			while (this.peek() && !this.is("}")) {
				const key = this.take() as ConsoleToken;
				const named = key.kind === "ident" || wordOp(key) || (key.kind === "string" && key.value !== undefined);
				if (!named) {
					this.issue("unexpected", key.start, key.end, "a key must be a name or a plain string");
					break;
				}
				if (!this.is(":")) {
					this.issue("incomplete", key.start, this.end(), "missing :");
					break;
				}
				this.take();
				const value = this.expression();
				entries.push({
					key: key.kind === "string" ? (key.value ?? "") : key.text,
					value,
					start: key.start,
					end: key.end,
				});
				if (!this.is(",")) break;
				this.take();
			}
			const closed = this.closeWith("}", token.start, opened);
			return this.node({ kind: "dict", entries, closed, start: token.start, end: this.closedEnd(closed) });
		}
		const saving = token.text === "=";
		this.issue(
			saving ? "assignment" : "unexpected",
			token.start,
			token.end,
			saving ? "only a name at the start of a statement can be saved" : `unexpected ${token.text}`,
		);
		return this.node({ kind: "literal", value: null, start: token.start, end: token.end });
	}
}

const tooLong = (length: number): ConsoleIssue => ({
	code: "too_big",
	start: 0,
	end: length,
	message: `longer than ${CONSOLE_SOURCE_MAX} characters`,
});

export function parseConsole(source: string): ConsoleParse {
	if (source.length > CONSOLE_SOURCE_MAX) return { statements: [], issues: [tooLong(source.length)] };
	const parser = new ConsoleParser(lexConsole(source), source.length);
	const statements = parser.parse();
	return { statements, issues: parser.issues };
}

/** No assignment, no second statement. */
export function parseConsoleExpression(source: string): { node: ConsoleNode | null; issues: ConsoleIssue[] } {
	if (source.length > CONSOLE_SOURCE_MAX) return { node: null, issues: [tooLong(source.length)] };
	const parser = new ConsoleParser(lexConsole(source), source.length);
	const node = parser.parseOne();
	return { node, issues: parser.issues };
}

export function parseConsoleText(text: string): { node: ConsoleNode; issues: ConsoleIssue[] } {
	const parser = new ConsoleParser([], text.length);
	const node = parser.parseText(lexConsoleText(text));
	return { node, issues: parser.issues };
}

const written = (table: Readonly<Record<string, string>>): Record<string, string> =>
	Object.fromEntries(Object.entries(table).map(([letter, character]) => [character, `\\${letter}`]));
const BODY_WRITTEN = written(BODY_ESCAPES);
/** Single quotes need no escape. */
const { "'": _single, ...QUOTED_WRITTEN } = { ...written(QUOTED_ESCAPES), ...BODY_WRITTEN };

const escapedBy = (run: string, table: Readonly<Record<string, string>>): string => {
	let out = "";
	for (const character of run) out += table[character] ?? character;
	return out;
};

export const writeConsoleRun = (run: string): string => escapedBy(run, BODY_WRITTEN);

export const quoteConsoleString = (value: string): string => `"${escapedBy(value, QUOTED_WRITTEN)}"`;

export function quoteConsoleText(text: string, hole: (source: string) => string = (source) => source): string {
	const body = lexConsoleText(text).map((part) =>
		part.kind === "hole" ? hole(text.slice(part.start, part.end)) : escapedBy(part.value, QUOTED_WRITTEN),
	);
	return `"${body.join("")}"`;
}

export const piecesOf = (node: ConsoleNode): readonly ConsoleTemplatePiece[] | null =>
	node.kind === "template" ? node.pieces : node.kind === "literal" ? (node.pieces ?? null) : null;
