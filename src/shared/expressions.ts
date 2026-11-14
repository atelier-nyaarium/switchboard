// Bounded expression DAG.

import { z } from "zod";
import { BYTES_MAX, parseDecimal } from "./field-types.js";

export const EXPRESSION_MAX_NODES = 64;

export const COMPARE_OPS = ["eq", "ne", "lt", "le", "gt", "ge"] as const;
export const ARITH_OPS = ["add", "sub", "mul", "div", "intdiv", "mod", "and", "shift"] as const;
/** Integer ops truncate toward zero. */
const INTEGRAL_OPS = new Set(["intdiv", "mod", "and", "shift"]);
export const BAND_SIDES = ["low", "ok", "high"] as const;

const index = z.number().int().nonnegative();

export const FieldRefSchema = z.discriminatedUnion("source", [
	z.strictObject({ source: z.literal("device"), device: z.string().min(1).max(64), key: z.string().min(1).max(64) }),
	z.strictObject({ source: z.literal("computed"), id: z.string().min(1).max(64) }),
	z.strictObject({ source: z.literal("input"), key: z.string().min(1).max(64) }),
]);
export type FieldRef = z.infer<typeof FieldRefSchema>;

export const refKey = (ref: FieldRef): string =>
	ref.source === "device"
		? `device:${ref.device}/${ref.key}`
		: ref.source === "computed"
			? `computed:${ref.id}`
			: `input:${ref.key}`;

export const ExpressionNodeSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("field"), ref: FieldRefSchema }),
	z.strictObject({
		kind: z.literal("literal"),
		type: z.enum(["number", "text", "boolean"]),
		value: z.string().max(256),
	}),
	z.strictObject({ kind: z.literal("compare"), op: z.enum(COMPARE_OPS), left: index, right: index }),
	z.strictObject({ kind: z.literal("all"), args: z.array(index).min(1).max(16) }),
	z.strictObject({ kind: z.literal("any"), args: z.array(index).min(1).max(16) }),
	z.strictObject({ kind: z.literal("not"), arg: index }),
	z.strictObject({
		kind: z.literal("choose"),
		branches: z
			.array(z.strictObject({ when: index, result: index }))
			.min(1)
			.max(16),
		otherwise: index,
	}),
	/** Dead zone gates changes. */
	z.strictObject({
		kind: z.literal("band"),
		input: index,
		low: z.number().optional(),
		high: z.number().optional(),
		deadZone: z.number().nonnegative(),
	}),
	z.strictObject({
		kind: z.literal("take"),
		input: index,
		offset: z
			.number()
			.int()
			.min(0)
			.max(BYTES_MAX - 1),
		length: z.number().int().min(1).max(6),
		signed: z.boolean(),
		endian: z.enum(["big", "little"]),
	}),
	z.strictObject({ kind: z.literal("arith"), op: z.enum(ARITH_OPS), left: index, right: index }),
	z.strictObject({ kind: z.literal("unknown"), reason: z.string().min(1).max(80) }),
]);
export type ExpressionNode = z.infer<typeof ExpressionNodeSchema>;

export const ExpressionSchema = z.array(ExpressionNodeSchema).min(1).max(EXPRESSION_MAX_NODES);

export type ExprType =
	| { type: "number"; integral: boolean }
	| { type: "text" }
	| { type: "choice"; members: string[] }
	| { type: "boolean" }
	| { type: "bytes" }
	| { type: "unknown" };

export interface ExprIssue {
	path: (string | number)[];
	message: string;
	code: "invalid_ref" | "invalid_type" | "invalid_value" | "too_big";
}

export type ExprCheck = { ok: true; type: ExprType; refs: FieldRef[] } | { ok: false; issue: ExprIssue };

export type RefTypes = (ref: FieldRef) => ExprType | null;

const NUMBER: ExprType = { type: "number", integral: false };
const INTEGER: ExprType = { type: "number", integral: true };

function sameType(a: ExprType, b: ExprType): boolean {
	if (a.type === "unknown" || b.type === "unknown") return true;
	if (a.type === "choice" && (b.type === "choice" || b.type === "text")) return true;
	if (a.type === "text" && b.type === "choice") return true;
	return a.type === b.type;
}

/** Literal choices ignore unknowns. */
function joinBranches(types: ExprType[], literals: (string | null)[]): ExprType | null {
	const kept = types
		.map((type, i) => ({ type, literal: literals[i] ?? null }))
		.filter((b) => b.type.type !== "unknown");
	if (kept.length === 0) return { type: "unknown" };
	if (kept.every((b) => b.literal !== null))
		return { type: "choice", members: [...new Set(kept.map((b) => b.literal as string))] };
	const first = (kept[0] as { type: ExprType }).type;
	if (!kept.every((b) => sameType(b.type, first))) return null;
	if (first.type === "number")
		return kept.every((b) => b.type.type === "number" && b.type.integral) ? INTEGER : NUMBER;
	return first;
}

export function checkExpression(nodes: readonly ExpressionNode[], typeOf: RefTypes): ExprCheck {
	const types: ExprType[] = [];
	const textLiteral: (string | null)[] = [];
	const refs: FieldRef[] = [];
	const fail = (at: number, code: ExprIssue["code"], message: string): ExprCheck => ({
		ok: false,
		issue: { path: ["nodes", at], message, code },
	});
	for (const [at, node] of nodes.entries()) {
		const earlier = (i: number) => i < at;
		const of = (i: number) => types[i] as ExprType;
		const wants = (i: number, t: ExprType["type"]) => earlier(i) && (of(i).type === t || of(i).type === "unknown");
		textLiteral.push(null);
		switch (node.kind) {
			case "field": {
				const type = typeOf(node.ref);
				if (!type) return fail(at, "invalid_ref", `${refKey(node.ref)} is not a field here`);
				refs.push(node.ref);
				types.push(type);
				break;
			}
			case "literal": {
				if (node.type === "number") {
					const value = parseDecimal(node.value);
					if (value === null) return fail(at, "invalid_value", `${node.value} is not a number`);
					if (Number.isInteger(value) && !Number.isSafeInteger(value))
						return fail(at, "too_big", `${node.value} is too large`);
					types.push(Number.isInteger(value) ? INTEGER : NUMBER);
				} else if (node.type === "boolean") {
					if (node.value !== "true" && node.value !== "false")
						return fail(at, "invalid_value", "true or false");
					types.push({ type: "boolean" });
				} else {
					types.push({ type: "text" });
					textLiteral[at] = node.value;
				}
				break;
			}
			case "compare": {
				if (!earlier(node.left) || !earlier(node.right)) return fail(at, "invalid_ref", "names a later node");
				const [left, right] = [of(node.left), of(node.right)];
				if (!sameType(left, right)) return fail(at, "invalid_type", "compares two types");
				const ordered = node.op !== "eq" && node.op !== "ne";
				if (ordered && left.type !== "number" && left.type !== "unknown") {
					return fail(at, "invalid_type", "orders only numbers");
				}
				if (left.type === "bytes") return fail(at, "invalid_type", "bytes do not compare");
				types.push({ type: "boolean" });
				break;
			}
			case "all":
			case "any": {
				if (!node.args.every((i) => wants(i, "boolean")))
					return fail(at, "invalid_type", `${node.kind} takes booleans`);
				types.push({ type: "boolean" });
				break;
			}
			case "not": {
				if (!wants(node.arg, "boolean")) return fail(at, "invalid_type", "not takes a boolean");
				types.push({ type: "boolean" });
				break;
			}
			case "choose": {
				const all = [...node.branches.flatMap((b) => [b.when, b.result]), node.otherwise];
				if (!all.every(earlier)) return fail(at, "invalid_ref", "names a later node");
				if (!node.branches.every((b) => wants(b.when, "boolean")))
					return fail(at, "invalid_type", "a when is not a boolean");
				const outcomes = [...node.branches.map((b) => b.result), node.otherwise];
				const joined = joinBranches(
					outcomes.map(of),
					outcomes.map((i) => textLiteral[i] ?? null),
				);
				if (!joined) return fail(at, "invalid_type", "its branches give different types");
				types.push(joined);
				break;
			}
			case "band": {
				if (!wants(node.input, "number")) return fail(at, "invalid_type", "band takes a number");
				if (node.low === undefined && node.high === undefined)
					return fail(at, "invalid_value", "band needs a low or a high");
				if (node.low !== undefined && node.high !== undefined) {
					if (node.low >= node.high) return fail(at, "invalid_value", "low is not below high");
					if (node.deadZone * 2 >= node.high - node.low)
						return fail(at, "invalid_value", "the dead zone is wider than the band");
				}
				types.push({ type: "choice", members: [...BAND_SIDES] });
				break;
			}
			case "take": {
				if (!wants(node.input, "bytes")) return fail(at, "invalid_type", "take reads bytes");
				types.push(INTEGER);
				break;
			}
			case "arith": {
				if (!wants(node.left, "number") || !wants(node.right, "number"))
					return fail(at, "invalid_type", "takes numbers");
				const integral = (i: number) => {
					const t = of(i);
					return t.type === "unknown" || (t.type === "number" && t.integral);
				};
				if (INTEGRAL_OPS.has(node.op) && !(integral(node.left) && integral(node.right))) {
					return fail(at, "invalid_type", `${node.op} takes whole numbers`);
				}
				const whole = integral(node.left) && integral(node.right) && node.op !== "div";
				types.push(whole ? INTEGER : NUMBER);
				break;
			}
			case "unknown":
				types.push({ type: "unknown" });
				break;
		}
	}
	return { ok: true, type: types[types.length - 1] as ExprType, refs };
}

export type Value = { known: true; value: number | string | boolean } | { known: false; reason: string };

export const known = (value: number | string | boolean): Value => ({ known: true, value });
export const unknown = (reason: string): Value => ({ known: false, reason });

/** Type mismatches read unknown. */
export function conforms(type: ExprType, value: Value): Value {
	if (!value.known) return value;
	const held = value.value;
	const fits =
		type.type === "number"
			? typeof held === "number" && Number.isFinite(held) && (!type.integral || Number.isInteger(held))
			: type.type === "boolean"
				? typeof held === "boolean"
				: type.type === "choice"
					? typeof held === "string" && type.members.includes(held)
					: type.type === "bytes"
						? typeof held === "string" && held.length <= BYTES_MAX * 2 && bytesOf(held) !== null
						: type.type === "text" && typeof held === "string";
	return fits ? value : unknown(type.type === "unknown" ? "unreadable type" : "wrong type");
}

export type BandSide = (typeof BAND_SIDES)[number];

export interface Evaluation {
	value: Value;
	/** Persist indexed band sides. */
	sides: Record<number, BandSide>;
}

function bytesOf(hex: string): number[] | null {
	if (!/^(?:[0-9a-f]{2})*$/.test(hex)) return null;
	const out: number[] = [];
	for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
	return out;
}

function take(hex: string, node: Extract<ExpressionNode, { kind: "take" }>): Value {
	const bytes = hex.length > BYTES_MAX * 2 ? null : bytesOf(hex);
	if (!bytes || node.offset + node.length > bytes.length) return unknown("short frame");
	const slice = bytes.slice(node.offset, node.offset + node.length);
	const ordered = node.endian === "big" ? slice : [...slice].reverse();
	let total = 0n;
	for (const byte of ordered) total = (total << 8n) | BigInt(byte);
	if (node.signed && ordered[0] !== undefined && ordered[0] >= 0x80) total -= 1n << BigInt(8 * node.length);
	return known(Number(total));
}

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** Unsafe integers become unknown. */
const ranged = (value: number): Value =>
	Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? known(value) : unknown("out of range");
const exact = (value: bigint): Value =>
	value > SAFE || value < -SAFE ? unknown("out of range") : known(Number(value));

function wholeArith(op: (typeof ARITH_OPS)[number], left: bigint, right: bigint): Value {
	switch (op) {
		case "add":
			return exact(left + right);
		case "sub":
			return exact(left - right);
		case "mul":
			return exact(left * right);
		case "div":
			return right === 0n ? unknown("division by zero") : ranged(Number(left) / Number(right));
		case "intdiv":
			return right === 0n ? unknown("division by zero") : exact(left / right);
		case "mod":
			return right === 0n ? unknown("division by zero") : exact(left % right);
		case "and":
			return exact(left & right);
		case "shift": {
			// Negative shifts right.
			if (right > 64n) return left === 0n ? known(0) : unknown("out of range");
			if (right < -64n) return known(0);
			return exact(right >= 0n ? left << right : left / (1n << -right));
		}
	}
}

function arith(op: (typeof ARITH_OPS)[number], left: number, right: number): Value {
	if (Number.isSafeInteger(left) && Number.isSafeInteger(right)) return wholeArith(op, BigInt(left), BigInt(right));
	if (INTEGRAL_OPS.has(op)) return unknown("not a whole number");
	switch (op) {
		case "add":
			return ranged(left + right);
		case "sub":
			return ranged(left - right);
		case "mul":
			return ranged(left * right);
		default:
			return right === 0 ? unknown("division by zero") : ranged(left / right);
	}
}

function compare(op: (typeof COMPARE_OPS)[number], left: number | string | boolean, right: number | string | boolean) {
	switch (op) {
		case "eq":
			return left === right;
		case "ne":
			return left !== right;
		case "lt":
			return left < right;
		case "le":
			return left <= right;
		case "gt":
			return left > right;
		case "ge":
			return left >= right;
	}
}

function band(node: Extract<ExpressionNode, { kind: "band" }>, value: number, was: BandSide | undefined): BandSide {
	const { low, high, deadZone } = node;
	if (was === "low" && low !== undefined && value < low + deadZone) return "low";
	if (was === "high" && high !== undefined && value > high - deadZone) return "high";
	if (low !== undefined && value < low) return "low";
	if (high !== undefined && value > high) return "high";
	return "ok";
}

/** Unreadable inputs yield unknown. */
export function evaluate(
	nodes: readonly ExpressionNode[],
	input: (ref: FieldRef) => Value,
	sides: Readonly<Record<number, BandSide>> = {},
): Evaluation {
	const values: Value[] = [];
	const nextSides: Record<number, BandSide> = { ...sides };
	const at = (i: number): Value => values[i] ?? unknown("bad node");
	for (const [i, node] of nodes.entries()) {
		try {
			values.push(evaluateNode(node, at, input, sides[i], (side) => (nextSides[i] = side)));
		} catch {
			// Avoid store quarantine.
			values.push(unknown("could not evaluate"));
		}
	}
	return { value: at(nodes.length - 1), sides: nextSides };
}

function evaluateNode(
	node: ExpressionNode,
	at: (i: number) => Value,
	input: (ref: FieldRef) => Value,
	side: BandSide | undefined,
	setSide: (side: BandSide) => void,
): Value {
	switch (node.kind) {
		case "field":
			return input(node.ref);
		case "literal":
			if (node.type === "number") return known(parseDecimal(node.value) ?? Number.NaN);
			if (node.type === "boolean") return known(node.value === "true");
			return known(node.value);
		case "compare": {
			const [left, right] = [at(node.left), at(node.right)];
			if (!left.known) return left;
			if (!right.known) return right;
			return known(compare(node.op, left.value, right.value));
		}
		case "all":
		case "any": {
			const short = node.kind === "any";
			let missing: Value | null = null;
			for (const arg of node.args) {
				const value = at(arg);
				if (!value.known) missing ??= value;
				else if (value.value === short) return known(short);
			}
			return missing ?? known(!short);
		}
		case "not": {
			const value = at(node.arg);
			return value.known ? known(!value.value) : value;
		}
		case "choose": {
			for (const branch of node.branches) {
				const when = at(branch.when);
				if (!when.known) return when;
				if (when.value === true) return at(branch.result);
			}
			return at(node.otherwise);
		}
		case "band": {
			const value = at(node.input);
			if (!value.known || typeof value.value !== "number") return value.known ? unknown("not a number") : value;
			const next = band(node, value.value, side);
			setSide(next);
			return known(next);
		}
		case "take": {
			const value = at(node.input);
			if (!value.known) return value;
			return typeof value.value === "string" ? take(value.value, node) : unknown("not bytes");
		}
		case "arith": {
			const [left, right] = [at(node.left), at(node.right)];
			if (!left.known) return left;
			if (!right.known) return right;
			if (typeof left.value !== "number" || typeof right.value !== "number") return unknown("not a number");
			return arith(node.op, left.value, right.value);
		}
		case "unknown":
			return unknown(node.reason);
	}
}
