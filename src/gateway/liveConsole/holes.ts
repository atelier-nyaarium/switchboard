import { type ConsoleNode, parseConsole } from "../../shared/live-console-grammar.js";
import { oneLine } from "../../shared/system-reminder.js";
import { HOLE_FAILED, scanHoles } from "../../shared/text-holes.js";
import { arityIssue, freeBuiltin, valueBuiltin } from "./builtins.js";
import { evaluateConsole } from "./evaluate.js";
import type { ConsoleAudience, ConsoleRegistry } from "./registry.js";
import { numberText } from "./render.js";

/** Host audience; slow members barred. */
const AUDIENCE: ConsoleAudience = "host";
const HOLE_STEPS_MAX = 2_000;

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
	/** A trigger's name shadows no entity. */
	const entityOf = (target: ConsoleNode) =>
		target.kind === "ident" && !names.has(target.name) ? registry.get(target.name, AUDIENCE) : null;
	switch (node.kind) {
		case "literal":
			return null;
		case "ident": {
			if (names.has(node.name)) return null;
			const message = registry.get(node.name, AUDIENCE)
				? `name what to read of ${node.name}`
				: `no name ${node.name} here`;
			return { start: node.start, end: node.end, message };
		}
		case "member": {
			const entity = entityOf(node.target);
			if (!entity) return walk(node.target);
			const found = Object.hasOwn(entity.members, node.name) ? entity.members[node.name] : undefined;
			if (!found) return { start: node.start, end: node.end, message: `${entity.name} has no ${node.name}` };
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

/** One line; null for what has no short form. */
function holeText(value: unknown): string | null {
	if (value === null || value === undefined) return "none";
	if (typeof value === "string") return oneLine(value);
	if (typeof value === "number") return numberText(value);
	if (typeof value === "boolean") return value ? "yes" : "no";
	return isRecord(value) && typeof value.shown === "string" ? value.shown : null;
}

export interface FilledText {
	text: string;
	failed: number;
}

const variablesOf = (names: Readonly<Record<string, HoleName>>) =>
	Object.fromEntries(Object.entries(names).map(([name, held]) => [name, { value: held.value }]));

/** Null when it fails. */
export async function evaluateHole(
	source: string,
	names: Readonly<Record<string, HoleName>>,
	registry: ConsoleRegistry,
): Promise<{ value: unknown } | null> {
	const answer = await evaluateConsole(source, registry, AUDIENCE, {
		variables: variablesOf(names),
		stepsMax: HOLE_STEPS_MAX,
		noSlow: true,
	});
	const [only, more] = answer.ok ? answer.results : [];
	return only && !more && !only.assigned ? { value: only.value } : null;
}

/** Never throws. */
export async function fillHoles(
	text: string,
	names: Readonly<Record<string, HoleName>>,
	registry: ConsoleRegistry,
): Promise<FilledText> {
	const variables = variablesOf(names);
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
