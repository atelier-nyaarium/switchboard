import { type ConsoleNode, parseConsole } from "../../shared/live-console-grammar.js";
import { scanHoles } from "../../shared/text-holes.js";
import { freeBuiltin } from "./builtins.js";
import { evaluateConsole } from "./evaluate.js";
import type { ConsoleAudience, ConsoleRegistry } from "./registry.js";
import { numberText } from "./render.js";

/** Host audience; slow members barred. */
const AUDIENCE: ConsoleAudience = "host";
const HOLE_STEPS_MAX = 2_000;
export const HOLE_FAILED = "{?}";

/** UTF-16 offsets, end-exclusive. */
export interface HoleIssue {
	start: number;
	end: number;
	message: string;
}

/** `shown` prints for a bare name. */
export interface HoleName {
	value: unknown;
	shown?: string;
}

type Found = { start: number; end: number; message: string } | null;

function unreadable(node: ConsoleNode, names: ReadonlySet<string>, registry: ConsoleRegistry): Found {
	const walk = (child: ConsoleNode | null): Found => (child ? unreadable(child, names, registry) : null);
	const slow = (target: ConsoleNode, name: string): boolean => {
		if (target.kind !== "ident") return false;
		const found = registry.get(target.name, AUDIENCE)?.members[name];
		return found?.kind === "method" && found.slow === true;
	};
	switch (node.kind) {
		case "literal":
			return null;
		case "ident":
			return names.has(node.name) || registry.get(node.name, AUDIENCE)
				? null
				: { start: node.start, end: node.end, message: `no name ${node.name} here` };
		case "member":
			return walk(node.target);
		case "call": {
			const { target } = node;
			if (target.kind === "ident") {
				if (!freeBuiltin(target.name)) {
					return { start: target.start, end: target.end, message: `no function ${target.name}()` };
				}
			} else if (target.kind === "member") {
				if (slow(target.target, target.name)) {
					return { start: node.start, end: node.end, message: "too slow for an automation" };
				}
				const inner = walk(target.target);
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

export function holeIssue(text: string, names: readonly string[], registry: ConsoleRegistry): HoleIssue | null {
	const scope = new Set(names);
	for (const part of scanHoles(text)) {
		if (part.kind !== "hole") continue;
		const whole = { start: part.start, end: part.end };
		if (!part.closed) return { ...whole, message: "missing }" };
		const inner = part.start + 1;
		const parsed = parseConsole(part.source);
		const first = parsed.issues[0];
		if (first) return { start: inner + first.start, end: inner + first.end, message: first.message };
		const [statement, second] = parsed.statements;
		if (!statement) return { ...whole, message: "a hole needs an expression" };
		if (second || statement.assign) return { ...whole, message: "a hole holds one expression" };
		const found = unreadable(statement.node, scope, registry);
		if (found) return { start: inner + found.start, end: inner + found.end, message: found.message };
	}
	return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Null when multiline. */
function holeText(value: unknown): string | null {
	if (value === null || value === undefined) return "none";
	if (typeof value === "string") return value;
	if (typeof value === "number") return numberText(value);
	if (typeof value === "boolean") return value ? "yes" : "no";
	return isRecord(value) && typeof value.shown === "string" ? value.shown : null;
}

export interface FilledText {
	text: string;
	failed: number;
}

/** Never throws. */
export async function fillHoles(
	text: string,
	names: Readonly<Record<string, HoleName>>,
	registry: ConsoleRegistry,
): Promise<FilledText> {
	const variables = Object.fromEntries(Object.entries(names).map(([name, held]) => [name, { value: held.value }]));
	let filled = "";
	let failed = 0;
	for (const part of scanHoles(text)) {
		if (part.kind === "text") {
			filled += part.text;
			continue;
		}
		const name = part.source.trim();
		const alone = Object.hasOwn(names, name) ? names[name] : undefined;
		if (part.closed && alone?.shown !== undefined) {
			filled += alone.shown;
			continue;
		}
		const answer = part.closed
			? await evaluateConsole(part.source, registry, AUDIENCE, {
					variables,
					stepsMax: HOLE_STEPS_MAX,
					noSlow: true,
				})
			: null;
		const [only, more] = answer?.ok ? answer.results : [];
		const printed = only && !more && !only.assigned ? holeText(only.value) : null;
		if (printed === null) failed += 1;
		filled += printed ?? HOLE_FAILED;
	}
	return { text: filled, failed };
}
