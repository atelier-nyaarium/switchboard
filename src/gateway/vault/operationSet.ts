// What a grant covers: the shape of every command a line names, wrappers peeled.

import {
	type ArithmeticExpression,
	type Command,
	type Node,
	parse,
	type Redirect,
	type Statement,
	type TestExpression,
	type Word,
	type WordPart,
} from "unbash";
import { peelWrappers } from "../../shared/command-wrappers.js";
import { VAULT_SHAPES_MAX } from "../../shared/schemasVault.js";
import { shapeFrom } from "../../shared/selector-key.js";

/** A trailing slash keeps the whole spelling. */
function isStatic(part: WordPart): boolean {
	switch (part.type) {
		case "Literal":
		case "SingleQuoted":
		case "AnsiCQuoted":
			return true;
		case "DoubleQuoted":
		case "LocaleString":
			return part.parts.every((child) => child.type === "Literal");
		default:
			return false;
	}
}

/** The word dequoted, or its spelling when it expands. */
function spelled(word: Word): string {
	return word.parts === undefined || word.parts.every(isStatic) ? word.value : word.text;
}

/** One command's shape, wrappers peeled. A `time` pipeline's command loses a leading `--`. */
function shapeOf(words: string[], timed: boolean): string | undefined {
	let program = words[0];
	let rest = words.slice(1);
	if (timed && program === "--") {
		program = rest[0];
		rest = rest.slice(1);
	}
	return program === undefined ? undefined : shapeFrom(peelWrappers([program, ...rest]));
}

/** Each switch is exhaustive, so a new unbash node fails to typecheck. */
class Collector {
	readonly shapes = new Set<string>();

	statements(statements: Statement[]): void {
		for (const statement of statements) this.node(statement);
	}

	node(node: Node | undefined, timed = false): void {
		if (node === undefined) return;
		switch (node.type) {
			case "Statement":
				this.node(node.command);
				this.redirects(node.redirects);
				return;
			case "Command":
				this.command(node, timed);
				return;
			case "Pipeline":
				for (const [index, command] of node.commands.entries())
					this.node(command, node.time === true && index === 0);
				return;
			case "AndOr":
				for (const command of node.commands) this.node(command);
				return;
			case "CompoundList":
				this.statements(node.commands);
				return;
			case "Subshell":
			case "BraceGroup":
				this.node(node.body);
				return;
			case "While":
				this.node(node.clause);
				this.node(node.body);
				return;
			case "If":
				this.node(node.clause);
				this.node(node.then);
				this.node(node.else);
				return;
			case "For":
			case "Select":
				this.words(node.wordlist);
				this.node(node.body);
				return;
			case "Case":
				this.word(node.word);
				for (const item of node.items) {
					this.words(item.pattern);
					this.node(item.body);
				}
				return;
			case "Function":
			case "Coproc":
				this.node(node.body);
				this.redirects(node.redirects);
				return;
			case "ArithmeticFor":
				this.arithmetic(node.initialize);
				this.arithmetic(node.test);
				this.arithmetic(node.update);
				this.node(node.body);
				return;
			case "TestCommand":
				this.test(node.expression);
				return;
			case "ArithmeticCommand":
				this.arithmetic(node.expression);
				return;
			default:
				unreachable(node);
		}
	}

	private command(node: Command, timed: boolean): void {
		for (const prefix of node.prefix) {
			this.word(prefix.value);
			this.words(prefix.array ?? []);
		}
		this.redirects(node.redirects);
		if (node.name === undefined) return;
		const words = [node.name, ...node.suffix];
		this.words(words);
		const shape = shapeOf(words.map(spelled), timed);
		// An empty program word names none.
		if (shape) this.shapes.add(shape);
	}

	private redirects(redirects: Redirect[]): void {
		for (const redirect of redirects) {
			this.word(redirect.target);
			this.word(redirect.body);
		}
	}

	private words(words: Word[]): void {
		for (const word of words) this.word(word);
	}

	private word(word: Word | undefined): void {
		this.parts(word?.parts);
	}

	private parts(parts: WordPart[] | undefined): void {
		for (const part of parts ?? []) this.part(part);
	}

	private part(part: WordPart): void {
		switch (part.type) {
			case "Literal":
			case "SingleQuoted":
			case "AnsiCQuoted":
			case "SimpleExpansion":
				return;
			case "DoubleQuoted":
			case "LocaleString":
			case "ExtendedGlob":
			case "BraceExpansion":
				this.parts(part.parts);
				return;
			case "CommandExpansion":
			case "ProcessSubstitution":
				this.statements(part.script?.commands ?? []);
				return;
			case "ArithmeticExpansion":
				this.arithmetic(part.expression);
				return;
			case "ParameterExpansion":
				this.parts(part.indexParts);
				this.word(part.operand);
				this.word(part.slice?.offset);
				this.word(part.slice?.length);
				this.word(part.replace?.pattern);
				this.word(part.replace?.replacement);
				return;
			default:
				unreachable(part);
		}
	}

	private arithmetic(expression: ArithmeticExpression | undefined): void {
		if (expression === undefined) return;
		switch (expression.type) {
			case "ArithmeticBinary":
				this.arithmetic(expression.left);
				this.arithmetic(expression.right);
				return;
			case "ArithmeticUnary":
				this.arithmetic(expression.operand);
				return;
			case "ArithmeticTernary":
				this.arithmetic(expression.test);
				this.arithmetic(expression.consequent);
				this.arithmetic(expression.alternate);
				return;
			case "ArithmeticGroup":
				this.arithmetic(expression.expression);
				return;
			case "ArithmeticWord":
				this.parts(expression.parts);
				return;
			case "ArithmeticCommandExpansion":
				this.statements(expression.script?.commands ?? []);
				return;
			default:
				unreachable(expression);
		}
	}

	private test(expression: TestExpression): void {
		switch (expression.type) {
			case "TestUnary":
				this.word(expression.operand);
				return;
			case "TestBinary":
				this.word(expression.left);
				this.word(expression.right);
				return;
			case "TestLogical":
				this.test(expression.left);
				this.test(expression.right);
				return;
			case "TestNot":
				this.test(expression.operand);
				return;
			case "TestGroup":
				this.test(expression.expression);
				return;
			default:
				unreachable(expression);
		}
	}
}

function unreachable(node: never): never {
	throw new Error(`unbash node not walked: ${String((node as { type?: string }).type)}`);
}

/**
 * Every program a command line names, each as its shape, sorted. A parse failure, or a program
 * count outside one to `VAULT_SHAPES_MAX`, makes the line its own shape, covering nothing else.
 */
export function operationSet(operation: string): string[] {
	const text = operation.trim();
	try {
		const script = parse(text);
		if ((script.errors?.length ?? 0) > 0) return [text];
		const collector = new Collector();
		collector.statements(script.commands);
		if (collector.shapes.size === 0 || collector.shapes.size > VAULT_SHAPES_MAX) return [text];
		return [...collector.shapes].sort();
	} catch {
		return [text];
	}
}

/** Every requested shape must be granted, and a request naming none is covered by none. */
export function coveredBy(requested: readonly string[], granted: readonly string[]): boolean {
	return requested.length > 0 && requested.every((shape) => granted.includes(shape));
}
