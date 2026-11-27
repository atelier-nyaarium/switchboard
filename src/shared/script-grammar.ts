import {
	type ConsoleIssue,
	type ConsoleNode,
	ConsoleParser,
	type ConsoleToken,
	lexScript,
} from "./live-console-grammar.js";
import { SCRIPT_SOURCE_MAX } from "./schemasFunction.js";

export const SCRIPT_RESERVED = [
	"if",
	"else",
	"switch",
	"case",
	"default",
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

export const SCRIPT_BLOCKS_MAX = 16;
export const SCRIPT_STATEMENT_NODES_MAX = 4_096;

const RESERVED = new Set<string>(SCRIPT_RESERVED);

export const opensStatement = (name: string): boolean => RESERVED.has(name);

interface Span {
	start: number;
	end: number;
}

export interface ScriptBlock extends Span {
	steps: ScriptNode[];
}

export type ScriptIf = Span & { kind: "if"; when: ConsoleNode; then: ScriptBlock; otherwise?: ScriptBlock | ScriptIf };

export interface ScriptCase extends Span {
	values: ConsoleNode[];
	body: ScriptBlock;
}

export type ScriptSwitch = Span & {
	kind: "switch";
	subject: ConsoleNode;
	cases: ScriptCase[];
	otherwise?: ScriptBlock;
};

export type ScriptNode =
	| ScriptIf
	| ScriptSwitch
	| (Span &
			(
				| { kind: "note"; text: string }
				| { kind: "let"; name: Span & { text: string }; value: ConsoleNode }
				| { kind: "run"; node: ConsoleNode }
				| { kind: "try"; body: ScriptBlock; handler: ScriptBlock }
				| { kind: "parallel"; body: ScriptBlock }
				| { kind: "start"; as?: Span & { text: string }; body: ScriptBlock }
				| { kind: "await"; as?: Span & { text: string }; task: ConsoleNode }
				| { kind: "exit" }
				| { kind: "throw"; text?: ConsoleNode }
				| { kind: "wait"; minutes: ConsoleNode }
			));

export interface ScriptTree {
	steps: ScriptNode[];
	issues: ConsoleIssue[];
}

const noted = (comment: ConsoleToken): string => {
	const line = comment.text.slice(2);
	return line.startsWith(" ") ? line.slice(1) : line;
};

class ScriptParser extends ConsoleParser {
	private blocks = 0;

	private get next(): ConsoleToken | undefined {
		return this.tokens[this.at];
	}

	private word(text: string): boolean {
		return this.next?.kind === "ident" && this.next.text === text;
	}

	private lines(): void {
		while (this.next?.kind === "newline") this.at++;
	}

	private get last(): number {
		return this.tokens[this.at - 1]?.end ?? 0;
	}

	private statements(): ScriptNode[] {
		const steps: ScriptNode[] = [];
		while (true) {
			this.lines();
			const token = this.next;
			if (!token || this.is("}")) return steps;
			const faults = this.faults;
			const began = this.at;
			this.fresh();
			const read = this.statement(token);
			if (this.faults === faults) {
				steps.push(...read);
				continue;
			}
			this.recover();
			if (this.at === began) this.at++;
		}
	}

	private recover(): void {
		let depth = 0;
		while (this.next) {
			const token = this.next;
			if (token.kind === "newline" && depth === 0) return;
			if (token.kind === "punct" && token.text === "{") depth++;
			if (token.kind === "punct" && token.text === "}") {
				if (depth === 0) return;
				depth--;
			}
			this.at++;
		}
	}

	private ended(): boolean {
		const token = this.next;
		if (!token || token.kind === "newline" || token.kind === "comment" || this.is("}")) return true;
		this.issue("unexpected", token.start, token.end, `unexpected ${token.text}`);
		return false;
	}

	private statement(first: ConsoleToken): ScriptNode[] {
		if (first.kind === "comment") return [this.note()];
		if (this.is("{")) {
			this.issue("unexpected", first.start, first.end, "a { opens nothing here");
			return [];
		}
		const blocky =
			first.kind === "ident" &&
			(first.text === "if" || first.text === "switch" || first.text === "try" || first.text === "parallel");
		const faults = this.faults;
		const step = first.kind === "ident" && RESERVED.has(first.text) ? this.worded(first) : this.plain(first);
		// Faults say so once.
		if (!step || this.faults !== faults) return [];
		if (blocky) return [step];
		if (!this.ended()) return [];
		// A trailing comment precedes its statement.
		const trailing = this.next;
		if (trailing?.kind !== "comment") return [step];
		this.at++;
		return [{ kind: "note", text: noted(trailing), start: trailing.start, end: trailing.end }, step];
	}

	private note(): ScriptNode {
		const first = this.next as ConsoleToken;
		const lines: string[] = [];
		let last = first;
		while (this.next?.kind === "comment") {
			last = this.next;
			lines.push(noted(last));
			this.at++;
			const follows = this.tokens[this.at]?.kind === "newline" && this.tokens[this.at + 1]?.kind === "comment";
			if (!follows) break;
			this.at++;
		}
		return { kind: "note", text: lines.join("\n"), start: first.start, end: last.end };
	}

	private plain(first: ConsoleToken): ScriptNode | null {
		const equals = this.tokens[this.at + 1];
		if (first.kind === "ident" && equals?.kind === "op" && equals.text === "=") {
			this.at += 2;
			const name = { text: first.text, start: first.start, end: first.end };
			const word = this.next;
			if (word?.kind === "ident" && (word.text === "start" || word.text === "await")) {
				const step = this.worded(word);
				return step && (step.kind === "start" || step.kind === "await")
					? { ...step, as: name, start: first.start }
					: step;
			}
			const value = this.expression();
			return { kind: "let", name, value, start: first.start, end: value.end };
		}
		const node = this.expression();
		return { kind: "run", node, start: first.start, end: node.end };
	}

	private parenthesized(word: ConsoleToken, missing: string, empty: string): ConsoleNode | null {
		const open = this.next;
		if (!open || !this.is("(")) {
			const stray = open && open.kind !== "newline" && !this.is("{") ? open : word;
			this.issue("incomplete", stray.start, stray.end, missing);
			return null;
		}
		this.at++;
		if (this.is(")")) {
			this.issue("incomplete", open.start, (this.next as ConsoleToken).end, empty);
			return null;
		}
		return this.enclosed(")", open.start);
	}

	private block(after: ConsoleToken): ScriptBlock | null {
		const from = this.at;
		this.lines();
		const open = this.next;
		if (!open || !this.is("{")) {
			this.at = from;
			this.issue("incomplete", after.start, after.end, "a { is missing");
			return null;
		}
		if (this.blocks >= SCRIPT_BLOCKS_MAX) {
			this.issue("too_big", open.start, open.end, `blocks nest more than ${SCRIPT_BLOCKS_MAX} deep`);
			return null;
		}
		this.at++;
		this.blocks++;
		const steps = this.statements();
		this.blocks--;
		const close = this.next;
		if (!close) {
			this.issue("incomplete", after.start, after.end, "its } is missing");
			return null;
		}
		this.at++;
		return { steps, start: open.start, end: close.end };
	}

	private follows(text: string): ConsoleToken | null {
		const from = this.at;
		this.lines();
		const token = this.next;
		if (token && this.word(text)) {
			this.at++;
			return token;
		}
		this.at = from;
		return null;
	}

	private branch(word: ConsoleToken): ScriptIf | null {
		const when = this.parenthesized(word, "a condition is missing: if (condition) {", "write the condition in ( )");
		const then = when && this.block(word);
		if (!when || !then) return null;
		const other = this.follows("else");
		if (!other) return { kind: "if", when, then, start: word.start, end: then.end };
		const again = this.next;
		if (again && this.word("if")) {
			this.at++;
			const otherwise = this.branch(again);
			return otherwise && { kind: "if", when, then, otherwise, start: word.start, end: otherwise.end };
		}
		const otherwise = this.block(other);
		return otherwise && { kind: "if", when, then, otherwise, start: word.start, end: otherwise.end };
	}

	/** `case "a", "b" { }`. */
	private casing(word: ConsoleToken): ScriptCase | null {
		this.at++;
		const values: ConsoleNode[] = [];
		while (true) {
			const token = this.next;
			if (!token || token.kind === "newline" || token.kind === "comment" || this.is("{")) {
				this.issue("incomplete", word.start, word.end, 'a case needs its values: case "a", "b" {');
				return null;
			}
			values.push(this.expression());
			if (!this.is(",")) break;
			this.at++;
		}
		const body = this.block(word);
		return body && { values, body, start: word.start, end: body.end };
	}

	private switched(word: ConsoleToken): ScriptSwitch | null {
		const subject = this.parenthesized(
			word,
			"a subject is missing: switch (subject) {",
			"write the subject in ( )",
		);
		if (!subject) return null;
		const from = this.at;
		this.lines();
		if (!this.is("{")) {
			this.at = from;
			this.issue("incomplete", word.start, word.end, "a { is missing");
			return null;
		}
		this.at++;
		const faults = this.faults;
		const cases: ScriptCase[] = [];
		let otherwise: ScriptBlock | undefined;
		while (true) {
			this.lines();
			const token = this.next;
			if (!token) {
				if (this.faults === faults) this.issue("incomplete", word.start, word.end, "its } is missing");
				return null;
			}
			if (this.is("}")) {
				this.at++;
				return {
					kind: "switch",
					subject,
					cases,
					...(otherwise ? { otherwise } : {}),
					start: word.start,
					end: token.end,
				};
			}
			const before = this.faults;
			if (otherwise) this.issue("unexpected", token.start, token.end, "default comes last");
			else if (this.word("case")) {
				const read = this.casing(token);
				if (read) cases.push(read);
			} else if (this.word("default")) {
				this.at++;
				otherwise = this.block(token) ?? undefined;
			} else this.issue("unexpected", token.start, token.end, "a switch holds case and default");
			if (this.faults !== before) this.recover();
		}
	}

	private worded(word: ConsoleToken): ScriptNode | null {
		this.at++;
		const { start } = word;
		switch (word.text as ScriptWord) {
			case "if":
				return this.branch(word);
			case "switch":
				return this.switched(word);
			case "case":
				this.issue("unexpected", word.start, word.end, "a case goes inside a switch's { }");
				return null;
			case "default":
				this.issue("unexpected", word.start, word.end, "a default goes inside a switch's { }");
				return null;
			case "try": {
				const body = this.block(word);
				if (!body) return null;
				const caught = this.follows("catch");
				if (!caught) {
					this.issue("incomplete", word.start, word.end, "a try needs its catch (e) { }");
					return null;
				}
				const [open, name, close] = this.tokens.slice(this.at, this.at + 3);
				const punct = (token: ConsoleToken | undefined, text: string) =>
					token?.kind === "punct" && token.text === text;
				const named = punct(open, "(") && name?.kind === "ident" && name.text === "e" && punct(close, ")");
				if (!named) {
					this.issue("unexpected", caught.start, this.next?.end ?? caught.end, "write catch (e)");
					return null;
				}
				this.at += 3;
				const handler = this.block(caught);
				return handler && { kind: "try", body, handler, start, end: handler.end };
			}
			case "parallel": {
				const body = this.block(word);
				return body && { kind: "parallel", body, start, end: body.end };
			}
			case "start": {
				const from = this.at;
				this.lines();
				const opens = this.is("{");
				this.at = from;
				if (opens) {
					const body = this.block(word);
					return body && { kind: "start", body, start, end: body.end };
				}
				const open = this.next;
				// Lone statement as block.
				if (!open || open.kind === "newline" || open.kind === "comment" || this.is("}")) {
					this.issue(
						"incomplete",
						word.start,
						word.end,
						"start what? write start { } or start and a statement",
					);
					return null;
				}
				// Any one statement, a worded one too.
				const only = open.kind === "ident" && RESERVED.has(open.text) ? this.worded(open) : this.plain(open);
				if (!only) return null;
				return {
					kind: "start",
					body: { steps: [only], start: only.start, end: only.end },
					start,
					end: only.end,
				};
			}
			case "await": {
				const said = this.next;
				if (!said || said.kind === "newline" || said.kind === "comment" || this.is("}")) {
					this.issue("incomplete", word.start, word.end, "await what? write await and a task");
					return null;
				}
				const task = this.expression();
				return { kind: "await", task, start, end: task.end };
			}
			case "exit":
				if (this.next && this.next.kind !== "newline" && this.next.kind !== "comment" && !this.is("}")) {
					this.issue("unexpected", this.next.start, this.next.end, "exit stands alone");
					return null;
				}
				return { kind: "exit", start, end: word.end };
			case "throw": {
				const said = this.next;
				if (!said || said.kind === "newline" || said.kind === "comment" || this.is("}")) {
					return { kind: "throw", start, end: word.end };
				}
				const text = this.expression();
				return { kind: "throw", text, start, end: text.end };
			}
			case "wait": {
				const minutes = this.parenthesized(word, "write wait(minutes)", "write wait(minutes)");
				return minutes && { kind: "wait", minutes, start, end: this.last };
			}
			case "else":
				this.issue("unexpected", word.start, word.end, "an else follows an if's }");
				return null;
			case "catch":
				this.issue("unexpected", word.start, word.end, "a catch follows a try's }");
				return null;
			default:
				this.issue("unexpected", word.start, word.end, `${word.text} is not in the language yet`);
				return null;
		}
	}

	script(): ScriptNode[] {
		const steps = this.statements();
		while (this.next) {
			const stray = this.next;
			this.issue("unexpected", stray.start, stray.end, "a } closes nothing here");
			this.at++;
			steps.push(...this.statements());
		}
		return steps;
	}
}

export function parseScriptSource(source: string): ScriptTree {
	if (source.length > SCRIPT_SOURCE_MAX) {
		const message = `longer than ${SCRIPT_SOURCE_MAX} characters`;
		return { steps: [], issues: [{ code: "too_big", start: 0, end: source.length, message }] };
	}
	const parser = new ScriptParser(lexScript(source), source.length, SCRIPT_STATEMENT_NODES_MAX);
	const steps = parser.script();
	return { steps, issues: parser.issues };
}
