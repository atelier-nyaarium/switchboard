import {
	type ConsoleNode,
	parseConsole,
	parseConsoleExpression,
	parseConsoleText,
	piecesOf,
} from "../../shared/live-console-grammar.js";
import { PLACEHOLDER_FAILED } from "../../shared/text-placeholders.js";
import { arityIssue, freeBuiltin, valueBuiltin } from "./builtins.js";
import { type ConsoleVariable, DOING_REFUSED, evaluateConsole, evaluateNode } from "./evaluate.js";
import { type ConsoleAudience, type ConsoleRegistry, resolveName } from "./registry.js";

/** Host audience; slow members barred. */
const AUDIENCE: ConsoleAudience = "host";
const PLACEHOLDER_STEPS_MAX = 2_000;

/** UTF-16 offsets, end-exclusive. */
export interface PlaceholderIssue {
	start: number;
	end: number;
	message: string;
}

/** `shown` prints for a bare name. */
export interface PlaceholderName {
	value: unknown;
	shown?: string;
}

type Found = { start: number; end: number; message: string } | null;

function unreadable(node: ConsoleNode, names: ReadonlySet<string>, registry: ConsoleRegistry): Found {
	const walk = (child: ConsoleNode | null): Found => (child ? unreadable(child, names, registry) : null);
	const meaningOf = (name: string) =>
		resolveName(registry, AUDIENCE, name, (held) => (names.has(held) ? true : undefined));
	const entityOf = (target: ConsoleNode) => {
		const meaning = target.kind === "ident" ? meaningOf(target.name) : null;
		return meaning?.kind === "entity" ? meaning.entity : null;
	};
	switch (node.kind) {
		case "literal":
			return null;
		case "template":
			// A broken placeholder is the parser's to report.
			return (
				node.pieces
					.map((piece) => (piece.kind === "placeholder" && !piece.broken ? walk(piece.node) : null))
					.find((issue) => issue !== null) ?? null
			);
		case "ident": {
			const meaning = meaningOf(node.name);
			if (meaning.kind === "held") return null;
			const message =
				meaning.kind === "entity" ? `name what to read of ${node.name}` : `no name ${node.name} here`;
			return { start: node.start, end: node.end, message };
		}
		case "member": {
			const entity = entityOf(node.target);
			if (!entity) return walk(node.target);
			const found = Object.hasOwn(entity.members, node.name) ? entity.members[node.name] : undefined;
			if (!found) return { start: node.start, end: node.end, message: `${entity.name} has no ${node.name}` };
			if (found.kind === "doing") return { start: node.start, end: node.end, message: DOING_REFUSED };
			return found.kind === "method"
				? { start: node.start, end: node.end, message: `call it: ${node.name}()` }
				: null;
		}
		case "call": {
			const { target } = node;
			if (target.kind === "ident") {
				const builtin = freeBuiltin(target.name);
				if (!builtin) return { start: target.start, end: target.end, message: `no function ${target.name}()` };
				const wrong = arityIssue(builtin, node.args.length);
				if (wrong) return { start: node.start, end: node.end, message: wrong };
			} else if (target.kind === "member") {
				const entity = entityOf(target.target);
				const found =
					entity && Object.hasOwn(entity.members, target.name) ? entity.members[target.name] : undefined;
				if (found?.kind === "doing") return { start: node.start, end: node.end, message: DOING_REFUSED };
				if (found?.kind === "method" && found.slow) {
					return { start: node.start, end: node.end, message: "too slow for an automation" };
				}
				// Off an entity, only a value's own methods.
				if (entity ? found?.kind !== "method" : !valueBuiltin(target.name)) {
					return { start: target.start, end: target.end, message: `no method ${target.name}()` };
				}
				const inner = entity ? null : walk(target.target);
				if (inner) return inner;
			}
			return node.args.map(walk).find((issue) => issue !== null) ?? null;
		}
		case "index":
			return walk(node.target) ?? walk(node.index);
		case "unary":
			return walk(node.operand);
		case "binary":
			return walk(node.left) ?? walk(node.right);
		case "list":
			return node.items.map(walk).find((issue) => issue !== null) ?? null;
		case "dict":
			return node.entries.map((entry) => walk(entry.value)).find((issue) => issue !== null) ?? null;
	}
}

type SourceIssue = { at: "whole"; why: "empty" | "many" } | { at: "span"; start: number; end: number; message: string };

/** Offsets within the source. */
function sourceIssue(source: string, scope: ReadonlySet<string>, registry: ConsoleRegistry): SourceIssue | null {
	const parsed = parseConsole(source);
	const first = parsed.issues[0];
	if (first) return { at: "span", start: first.start, end: first.end, message: first.message };
	const [statement, second] = parsed.statements;
	if (!statement) return { at: "whole", why: "empty" };
	if (second || statement.assign) return { at: "whole", why: "many" };
	const found = unreadable(statement.node, scope, registry);
	return found ? { at: "span", ...found } : null;
}

export function placeholderIssue(
	text: string,
	names: readonly string[],
	registry: ConsoleRegistry,
): PlaceholderIssue | null {
	const { node, issues } = parseConsoleText(text);
	const [syntax] = issues;
	const meaning = unreadable(node, new Set(names), registry);
	const first = syntax && (!meaning || syntax.start <= meaning.start) ? syntax : meaning;
	return first ? { start: first.start, end: first.end, message: first.message } : null;
}

/** A bare expression, no braces. */
export function expressionIssue(
	source: string,
	names: readonly string[],
	registry: ConsoleRegistry,
): PlaceholderIssue | null {
	const found = sourceIssue(source, new Set(names), registry);
	if (!found) return null;
	if (found.at === "span") return { start: found.start, end: found.end, message: found.message };
	return {
		start: 0,
		end: source.length,
		message: found.why === "empty" ? "it needs an expression" : "it holds one expression",
	};
}

/** One registry's placeholders port. */
export const placeholdersOver = (registry: ConsoleRegistry) => ({
	issue: (text: string, names: readonly string[]) => placeholderIssue(text, names, registry),
	expression: (source: string, names: readonly string[]) => expressionIssue(source, names, registry),
	fill: (text: string, names: Readonly<Record<string, PlaceholderName>>) => fillPlaceholders(text, names, registry),
	evaluate: (source: string, names: Readonly<Record<string, PlaceholderName>>) =>
		evaluatePlaceholder(source, names, registry),
	shown: (source: string, names: Readonly<Record<string, PlaceholderName>>) =>
		shownPlaceholder(source, names, registry),
	entity: (name: string) => registry.has(name),
});

export type ConsolePlaceholders = ReturnType<typeof placeholdersOver>;

export interface FilledText {
	text: string;
	failed: number;
}

const variablesOf = (names: Readonly<Record<string, PlaceholderName>>): Record<string, ConsoleVariable> =>
	Object.fromEntries(
		Object.entries(names).map(([name, held]) => [
			name,
			{ value: held.value, ...(held.shown === undefined ? {} : { shown: held.shown }) },
		]),
	);

/** Null when it fails. */
export async function evaluatePlaceholder(
	source: string,
	names: Readonly<Record<string, PlaceholderName>>,
	registry: ConsoleRegistry,
): Promise<{ value: unknown } | null> {
	const answer = await evaluateConsole(source, registry, AUDIENCE, {
		variables: variablesOf(names),
		stepsMax: PLACEHOLDER_STEPS_MAX,
		noSlow: true,
	});
	const [only, more] = answer.ok ? answer.results : [];
	return only && !more && !only.assigned ? { value: only.value } : null;
}

export async function shownPlaceholder(
	source: string,
	names: Readonly<Record<string, PlaceholderName>>,
	registry: ConsoleRegistry,
): Promise<string | null> {
	const { node, issues } = parseConsoleExpression(source);
	if (!node || issues.length > 0) return null;
	const { start, end } = node;
	const alone: ConsoleNode = {
		kind: "template",
		pieces: [{ kind: "placeholder", node, closed: true, broken: false, start, end }],
		closed: true,
		start,
		end,
	};
	const options = { variables: variablesOf(names), stepsMax: PLACEHOLDER_STEPS_MAX, noSlow: true };
	const answer = await evaluateNode(alone, source.length, registry, AUDIENCE, options);
	return answer.ok && typeof answer.value === "string" ? answer.value : null;
}

/** Never throws. */
export async function fillPlaceholders(
	text: string,
	names: Readonly<Record<string, PlaceholderName>>,
	registry: ConsoleRegistry,
): Promise<FilledText> {
	const options = { variables: variablesOf(names), stepsMax: PLACEHOLDER_STEPS_MAX, noSlow: true };
	let filled = "";
	let failed = 0;
	for (const piece of piecesOf(parseConsoleText(text).node) ?? []) {
		if (piece.kind !== "placeholder") {
			filled += piece.value;
			continue;
		}
		// Each placeholder is read alone, so one that fails marks itself.
		const alone: ConsoleNode = {
			kind: "template",
			pieces: [piece],
			closed: true,
			start: piece.start,
			end: piece.end,
		};
		const answer = piece.broken ? null : await evaluateNode(alone, text.length, registry, AUDIENCE, options);
		const printed = answer?.ok && typeof answer.value === "string" ? answer.value : null;
		if (printed === null) failed += 1;
		filled += printed ?? PLACEHOLDER_FAILED;
	}
	return { text: filled, failed };
}
