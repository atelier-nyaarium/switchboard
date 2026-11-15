export const CONSOLE_SOURCE_MAX = 2_000;
export const CONSOLE_NODES_MAX = 256;
export const CONSOLE_STATEMENTS_MAX = 16;

const KEYWORDS = new Set(["true", "false", "null"]);
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

/** Record parsing drops `__proto__`. */
export const isConsoleVariableName = (name: string): boolean =>
	VARIABLE_NAME.test(name) && name !== "__proto__" && !KEYWORDS.has(name);

/** UTF-16 offsets, end-exclusive. */
export interface ConsoleIssue {
	code: string;
	start: number;
	end: number;
	message: string;
}

export type ConsoleTokenKind = "ident" | "number" | "string" | "keyword" | "punct" | "op" | "error";

export interface ConsoleToken {
	kind: ConsoleTokenKind;
	text: string;
	start: number;
	end: number;
	closed?: boolean;
	value?: string;
}

const PUNCT = new Set([".", "(", ")", "[", "]", "{", "}", ",", ":", ";"]);
const TWO_CHAR_OPS = new Set(["==", "!="]);
const ONE_CHAR_OPS = new Set(["!", "+", "-", "*", "/", "="]);
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", '"': '"', "'": "'" };

const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdentStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

/** Minus is always separate. */
export function lexConsole(source: string): ConsoleToken[] {
	const tokens: ConsoleToken[] = [];
	let at = 0;
	while (at < source.length) {
		const c = source[at] as string;
		if (isSpace(c)) {
			at++;
			continue;
		}
		const start = at;
		if (isIdentStart(c)) {
			while (at < source.length && isIdentPart(source[at] as string)) at++;
			const text = source.slice(start, at);
			tokens.push({ kind: KEYWORDS.has(text) ? "keyword" : "ident", text, start, end: at });
			continue;
		}
		if (isDigit(c)) {
			while (at < source.length && isDigit(source[at] as string)) at++;
			if (source[at] === "." && isDigit(source[at + 1] ?? "")) {
				at++;
				while (at < source.length && isDigit(source[at] as string)) at++;
			}
			tokens.push({ kind: "number", text: source.slice(start, at), start, end: at });
			continue;
		}
		if (c === '"' || c === "'") {
			at++;
			let value = "";
			let closed = false;
			while (at < source.length) {
				const ch = source[at] as string;
				if (ch === c) {
					at++;
					closed = true;
					break;
				}
				if (ch === "\\" && at + 1 < source.length) {
					const next = source[at + 1] as string;
					value += ESCAPES[next] ?? next;
					at += 2;
					continue;
				}
				value += ch;
				at++;
			}
			tokens.push({ kind: "string", text: source.slice(start, at), start, end: at, closed, value });
			continue;
		}
		const two = source.slice(at, at + 2);
		if (TWO_CHAR_OPS.has(two)) {
			at += 2;
			tokens.push({ kind: "op", text: two, start, end: at });
			continue;
		}
		at++;
		const kind: ConsoleTokenKind = PUNCT.has(c) ? "punct" : ONE_CHAR_OPS.has(c) ? "op" : "error";
		tokens.push({ kind, text: c, start, end: at });
	}
	return tokens;
}

interface Span {
	start: number;
	end: number;
}

export type ConsoleNode = Span &
	(
		| { kind: "literal"; value: string | number | boolean | null }
		| { kind: "ident"; name: string }
		| { kind: "member"; target: ConsoleNode; name: string; closed: boolean }
		| { kind: "call"; target: ConsoleNode; args: ConsoleNode[]; closed: boolean }
		| { kind: "index"; target: ConsoleNode; index: ConsoleNode | null; closed: boolean }
		| { kind: "unary"; op: "-" | "!"; operand: ConsoleNode }
		| { kind: "binary"; op: "==" | "!=" | "+" | "-" | "*" | "/"; left: ConsoleNode; right: ConsoleNode }
		| { kind: "list"; items: ConsoleNode[]; closed: boolean }
		| { kind: "dict"; entries: { key: string; value: ConsoleNode }[]; closed: boolean }
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

class Parser {
	private at = 0;
	private nodes = 0;
	readonly issues: ConsoleIssue[] = [];

	constructor(
		private readonly tokens: ConsoleToken[],
		private readonly length: number,
	) {}

	private peek(offset = 0): ConsoleToken | undefined {
		return this.tokens[this.at + offset];
	}

	private is(text: string): boolean {
		const token = this.peek();
		return token !== undefined && (token.kind === "punct" || token.kind === "op") && token.text === text;
	}

	private take(): ConsoleToken | undefined {
		return this.tokens[this.at++];
	}

	private issue(code: string, start: number, end: number, message: string): void {
		if (this.issues.length < 8) this.issues.push({ code, start, end, message });
	}

	private node<N extends ConsoleNode>(node: N): N {
		this.nodes++;
		if (this.nodes === CONSOLE_NODES_MAX + 1) {
			this.issue("too_big", node.start, node.end, `more than ${CONSOLE_NODES_MAX} nodes`);
		}
		return node;
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
			// Include the closing bracket.
			const end = Math.max(node.end, this.tokens[this.at - 1]?.end ?? node.end);
			statements.push({ node, start: first.start, end, ...(assign ? { assign } : {}) });
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

	private expression(): ConsoleNode {
		return this.binary(0);
	}

	private static readonly LEVELS: readonly (readonly string[])[] = [
		["==", "!="],
		["+", "-"],
		["*", "/"],
	];

	private binary(level: number): ConsoleNode {
		const ops = Parser.LEVELS[level];
		if (!ops) return this.unary();
		let left = this.binary(level + 1);
		while (ops.some((op) => this.is(op))) {
			const op = this.take()?.text as "==" | "!=" | "+" | "-" | "*" | "/";
			const right = this.binary(level + 1);
			left = this.node({ kind: "binary", op, left, right, start: left.start, end: right.end });
		}
		return left;
	}

	private unary(): ConsoleNode {
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
	}

	private postfix(base: ConsoleNode): ConsoleNode {
		let node = base;
		while (true) {
			if (this.is(".")) {
				const dot = this.take() as ConsoleToken;
				const name = this.peek();
				if (name?.kind === "ident" || name?.kind === "keyword") {
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
				const args = this.items(")");
				const closed = this.closeWith(")", node.start);
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
				const index = this.is("]") || !this.peek() ? null : this.expression();
				const closed = this.closeWith("]", node.start);
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

	private closeWith(text: string, start: number): boolean {
		if (this.is(text)) {
			this.take();
			return true;
		}
		this.issue("incomplete", start, this.end(), `missing ${text}`);
		return false;
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

	private primary(): ConsoleNode {
		const token = this.take();
		if (!token) {
			this.issue("incomplete", this.length, this.length, "an expression is missing");
			return this.node({ kind: "literal", value: null, start: this.length, end: this.length });
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
			case "string":
				if (!token.closed) this.issue("incomplete", token.start, token.end, "missing closing quote");
				return this.node({ kind: "literal", value: token.value ?? "", start: token.start, end: token.end });
			case "keyword":
				return this.node({
					kind: "literal",
					value: token.text === "null" ? null : token.text === "true",
					start: token.start,
					end: token.end,
				});
			case "ident":
				return this.node({ kind: "ident", name: token.text, start: token.start, end: token.end });
			case "error":
				this.issue("unexpected", token.start, token.end, `unexpected ${token.text}`);
				return this.node({ kind: "literal", value: null, start: token.start, end: token.end });
		}
		if (token.text === "(") {
			const inner = this.expression();
			this.closeWith(")", token.start);
			return inner;
		}
		if (token.text === "[") {
			const items = this.items("]");
			const closed = this.closeWith("]", token.start);
			return this.node({ kind: "list", items, closed, start: token.start, end: this.closedEnd(closed) });
		}
		if (token.text === "{") {
			const entries: { key: string; value: ConsoleNode }[] = [];
			while (this.peek() && !this.is("}")) {
				const key = this.take() as ConsoleToken;
				if (key.kind !== "ident" && key.kind !== "string") {
					this.issue("unexpected", key.start, key.end, "a key must be a name or a string");
					break;
				}
				if (!this.closeWith(":", key.start)) break;
				entries.push({ key: key.kind === "string" ? (key.value ?? "") : key.text, value: this.expression() });
				if (!this.is(",")) break;
				this.take();
			}
			const closed = this.closeWith("}", token.start);
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

export function parseConsole(source: string): ConsoleParse {
	if (source.length > CONSOLE_SOURCE_MAX) {
		return {
			statements: [],
			issues: [
				{
					code: "too_big",
					start: 0,
					end: source.length,
					message: `longer than ${CONSOLE_SOURCE_MAX} characters`,
				},
			],
		};
	}
	const parser = new Parser(lexConsole(source), source.length);
	const statements = parser.parse();
	return { statements, issues: parser.issues };
}
