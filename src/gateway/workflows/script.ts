import { type JsonValue, JsonValueSchema, WorkflowBackendSchema } from "./workflowSchemas.js";

export interface WorkflowScript {
	meta: Record<string, JsonValue>;
	metaLiteral: string;
	body: string;
	phases: string[];
}

export class WorkflowScriptError extends Error {
	constructor(
		readonly code: "meta_missing" | "meta_not_first" | "meta_not_literal" | "meta_invalid" | "module_syntax",
		message: string,
	) {
		super(message);
		this.name = "WorkflowScriptError";
	}
}

interface Token {
	value: string;
	start: number;
	end: number;
}

function skipString(source: string, start: number, quote: string): number {
	let index = start + 1;
	while (index < source.length) {
		const character = source[index];
		if (character === "\\") {
			index += 2;
			continue;
		}
		if (character === quote) return index + 1;
		index += 1;
	}
	return source.length;
}

function skipTemplate(source: string, start: number): number {
	let index = start + 1;
	while (index < source.length) {
		const character = source[index];
		if (character === "\\") {
			index += 2;
			continue;
		}
		if (character === "`") return index + 1;
		if (character === "$" && source[index + 1] === "{") {
			index = skipCodeBlock(source, index + 2);
			continue;
		}
		index += 1;
	}
	return source.length;
}

function templateExpressions(source: string, start: number): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let index = start + 1;
	while (index < source.length) {
		const character = source[index];
		if (character === "\\") {
			index += 2;
			continue;
		}
		if (character === "`") return ranges;
		if (character === "$" && source[index + 1] === "{") {
			const expressionStart = index + 2;
			const expressionEnd = skipCodeBlock(source, expressionStart);
			ranges.push([expressionStart, Math.max(expressionStart, expressionEnd - 1)]);
			index = expressionEnd;
			continue;
		}
		index += 1;
	}
	return ranges;
}

function skipCodeBlock(source: string, start: number): number {
	let depth = 1;
	let index = start;
	while (index < source.length && depth > 0) {
		const character = source[index];
		if (character === "'" || character === '"') {
			index = skipString(source, index, character);
			continue;
		}
		if (character === "`") {
			index = skipTemplate(source, index);
			continue;
		}
		if (character === "/" && source[index + 1] === "/") {
			index = source.indexOf("\n", index + 2);
			if (index < 0) return source.length;
			continue;
		}
		if (character === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 2;
			continue;
		}
		if (character === "{") depth += 1;
		if (character === "}") depth -= 1;
		index += 1;
	}
	return index;
}

function scanTokens(source: string, from = 0): Token[] {
	const tokens: Token[] = [];
	let index = from;
	while (index < source.length) {
		const character = source[index]!;
		if (/\s/u.test(character)) {
			index += 1;
			continue;
		}
		if (character === "/" && source[index + 1] === "/") {
			const end = source.indexOf("\n", index + 2);
			index = end < 0 ? source.length : end + 1;
			continue;
		}
		if (character === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 2;
			continue;
		}
		if (character === "'" || character === '"') {
			const end = skipString(source, index, character);
			tokens.push({ value: "<string>", start: index, end });
			index = end;
			continue;
		}
		if (character === "`") {
			const start = index;
			const end = skipTemplate(source, index);
			tokens.push({ value: "<template>", start: index, end });
			for (const [expressionStart, expressionEnd] of templateExpressions(source, start)) {
				const offset = expressionStart;
				const expression = scanTokens(source.slice(expressionStart, expressionEnd));
				tokens.push(
					...expression.map((token) => ({ ...token, start: token.start + offset, end: token.end + offset })),
				);
			}
			index = end;
			continue;
		}
		if (/[A-Za-z_$]/u.test(character)) {
			const start = index++;
			while (index < source.length && /[\w$]/u.test(source[index]!)) index += 1;
			tokens.push({ value: source.slice(start, index), start, end: index });
			continue;
		}
		tokens.push({ value: character, start: index, end: index + 1 });
		index += 1;
	}
	return tokens;
}

function firstStatementEnd(source: string, start: number): number {
	let index = start;
	let depth = 0;
	while (index < source.length) {
		const character = source[index]!;
		if (character === "'" || character === '"') {
			index = skipString(source, index, character);
			continue;
		}
		if (character === "`") {
			index = skipTemplate(source, index);
			continue;
		}
		if (character === "/" && source[index + 1] === "/") {
			const end = source.indexOf("\n", index + 2);
			index = end < 0 ? source.length : end + 1;
			continue;
		}
		if (character === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 2;
			continue;
		}
		if (character === "{" || character === "[" || character === "(") depth += 1;
		if (character === "}" || character === "]" || character === ")") depth -= 1;
		if (character === ";" && depth === 0) return index;
		index += 1;
	}
	return -1;
}

class JsonLiteralParser {
	private index = 0;

	constructor(private readonly source: string) {}

	parse(): unknown {
		const value = this.value();
		this.skipTrivia();
		if (this.index !== this.source.length) throw new Error("trailing literal text");
		return value;
	}

	private skipTrivia(): void {
		while (this.index < this.source.length) {
			if (/\s/u.test(this.source[this.index]!)) {
				this.index += 1;
				continue;
			}
			if (this.source.startsWith("//", this.index)) {
				const end = this.source.indexOf("\n", this.index + 2);
				this.index = end < 0 ? this.source.length : end + 1;
				continue;
			}
			if (this.source.startsWith("/*", this.index)) {
				const end = this.source.indexOf("*/", this.index + 2);
				if (end < 0) throw new Error("unterminated comment");
				this.index = end + 2;
				continue;
			}
			break;
		}
	}

	private take(character: string): boolean {
		this.skipTrivia();
		if (this.source[this.index] !== character) return false;
		this.index += 1;
		return true;
	}

	private expect(character: string): void {
		if (!this.take(character)) throw new Error(`expected ${character}`);
	}

	private string(): string {
		this.skipTrivia();
		const start = this.index;
		const quote = this.source[this.index];
		if (quote !== '"' && quote !== "'") throw new Error("expected string");
		const end = skipString(this.source, start, quote);
		if (end <= start + 1 || this.source[end - 1] !== quote) throw new Error("unterminated string");
		const raw = this.source.slice(start, end);
		this.index = end;
		if (quote === '"') return JSON.parse(raw) as string;
		let value = "";
		for (let offset = 1; offset < raw.length - 1; offset += 1) {
			const character = raw[offset]!;
			if (character !== "\\") {
				value += character;
				continue;
			}
			offset += 1;
			const escaped = raw[offset];
			const escapes: Record<string, string> = {
				"\\": "\\",
				"'": "'",
				'"': '"',
				n: "\n",
				r: "\r",
				t: "\t",
				b: "\b",
				f: "\f",
				v: "\v",
				0: "\0",
			};
			if (escaped === "u") {
				const hex = raw.slice(offset + 1, offset + 5);
				if (!/^[0-9a-f]{4}$/iu.test(hex)) throw new Error("invalid unicode escape");
				value += String.fromCharCode(Number.parseInt(hex, 16));
				offset += 4;
			} else if (escaped === "x") {
				const hex = raw.slice(offset + 1, offset + 3);
				if (!/^[0-9a-f]{2}$/iu.test(hex)) throw new Error("invalid hex escape");
				value += String.fromCharCode(Number.parseInt(hex, 16));
				offset += 2;
			} else if (escaped !== undefined) {
				value += escapes[escaped] ?? escaped;
			}
		}
		return value;
	}

	private value(): unknown {
		this.skipTrivia();
		const character = this.source[this.index];
		if (character === "{") return this.object();
		if (character === "[") return this.array();
		if (character === '"' || character === "'") return this.string();
		for (const [word, value] of [
			["true", true],
			["false", false],
			["null", null],
		] as const) {
			if (
				this.source.startsWith(word, this.index) &&
				!/[\w$]/u.test(this.source[this.index + word.length] ?? "")
			) {
				this.index += word.length;
				return value;
			}
		}
		const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(this.source.slice(this.index))?.[0];
		if (!number) throw new Error("value is not a literal");
		this.index += number.length;
		const parsed = Number(number);
		if (!Number.isFinite(parsed)) throw new Error("number is not finite");
		return parsed;
	}

	private object(): Record<string, unknown> {
		this.expect("{");
		const value: Record<string, unknown> = {};
		if (this.take("}")) return value;
		while (true) {
			this.skipTrivia();
			const quoted = this.source[this.index] === '"' || this.source[this.index] === "'";
			const key = quoted ? this.string() : /^[A-Za-z_$][\w$]*/u.exec(this.source.slice(this.index))?.[0];
			if (typeof key !== "string") throw new Error("object key is not a literal");
			if (!quoted) this.index += key.length;
			this.expect(":");
			Object.defineProperty(value, key, {
				value: this.value(),
				enumerable: true,
				configurable: true,
				writable: true,
			});
			if (this.take("}")) return value;
			this.expect(",");
			if (this.take("}")) return value;
		}
	}

	private array(): unknown[] {
		this.expect("[");
		const value: unknown[] = [];
		if (this.take("]")) return value;
		while (true) {
			value.push(this.value());
			if (this.take("]")) return value;
			this.expect(",");
			if (this.take("]")) return value;
		}
	}
}

export function extractWorkflowScript(source: string): WorkflowScript {
	const tokens = scanTokens(source);
	if (tokens.length < 4 || tokens[0]?.value !== "export") {
		throw new WorkflowScriptError("meta_not_first", "meta must be the first statement");
	}
	if (
		tokens[0]?.value !== "export" ||
		tokens[1]?.value !== "const" ||
		tokens[2]?.value !== "meta" ||
		tokens[3]?.value !== "="
	) {
		throw new WorkflowScriptError("meta_missing", "first statement must declare meta");
	}
	const end = firstStatementEnd(source, tokens[0]!.start);
	if (end < 0) throw new WorkflowScriptError("meta_not_literal", "meta declaration needs a semicolon");
	const equals = tokens[3]!.end;
	let meta: unknown;
	const rawLiteral = source.slice(equals, end).trim();
	try {
		meta = new JsonLiteralParser(rawLiteral).parse();
	} catch {
		throw new WorkflowScriptError("meta_not_literal", "meta must be a JSON literal");
	}
	if (!JsonValueSchema.safeParse(meta).success || meta === null || Array.isArray(meta) || typeof meta !== "object") {
		throw new WorkflowScriptError("meta_invalid", "meta must be a JSON object");
	}
	const body = source.slice(end + 1);
	if (scanTokens(body).some((token) => token.value === "import" || token.value === "export")) {
		throw new WorkflowScriptError("module_syntax", "imports and additional exports are refused");
	}
	const metaRecord = meta as Record<string, JsonValue>;
	const rawPhases = metaRecord.phases;
	const phases: string[] = [];
	if (rawPhases !== undefined) {
		if (!Array.isArray(rawPhases)) throw new WorkflowScriptError("meta_invalid", "meta phases must be an array");
		for (const phase of rawPhases) {
			const title =
				typeof phase === "string"
					? phase
					: phase && typeof phase === "object" && !Array.isArray(phase)
						? phase.title
						: undefined;
			if (typeof title !== "string" || title.length === 0) {
				throw new WorkflowScriptError("meta_invalid", "each phase needs a title");
			}
			phases.push(title);
		}
	}
	return { meta: metaRecord, metaLiteral: JSON.stringify(metaRecord), body, phases };
}

export function parseWorkflowDefaultBackend(value: unknown): "codex" | "copilot" | "claude" {
	return WorkflowBackendSchema.parse(value);
}
