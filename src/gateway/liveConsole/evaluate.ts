import { type ConsoleIssue, type ConsoleNode, parseConsole } from "../../shared/live-console-grammar.js";
import { ConsoleError, runBuiltin, sameValue } from "./builtins.js";
import type { ConsoleAudience, ConsoleEntity, ConsoleRegistry } from "./registry.js";

export const CONSOLE_STEPS_MAX = 100_000;

/** Defers entity member lookup. */
export class EntityRef {
	constructor(readonly entity: ConsoleEntity) {}
}

export type ConsoleResult = { ok: true; value: unknown } | { ok: false; issue: ConsoleIssue };

class Located extends ConsoleError {
	constructor(
		code: string,
		message: string,
		readonly start: number,
		readonly end: number,
	) {
		super(code, message);
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof EntityRef);

const kindOf = (value: unknown): string =>
	value === null || value === undefined
		? "none"
		: Array.isArray(value)
			? "a list"
			: value instanceof EntityRef
				? "an entity"
				: typeof value === "object"
					? "a record"
					: typeof value === "string"
						? "text"
						: typeof value === "number"
							? "a number"
							: "a yes/no";

/** Return detached read values. */
const settle = async (value: unknown): Promise<unknown> => {
	const held = await value;
	return held === undefined ? null : structuredClone(held);
};

export async function evaluateConsole(
	source: string,
	registry: ConsoleRegistry,
	audience: ConsoleAudience,
	stepsMax = CONSOLE_STEPS_MAX,
): Promise<ConsoleResult> {
	const parsed = parseConsole(source);
	const first = parsed.issues[0];
	if (first) return { ok: false, issue: first };
	if (!parsed.node) return { ok: false, issue: { code: "empty", start: 0, end: 0, message: "nothing to read" } };
	let steps = 0;
	let slow = 0;
	const step = (count = 1) => {
		steps += count;
		if (steps > stepsMax) throw new ConsoleError("too_big", `ran past ${stepsMax} steps`);
	};

	const fail = (node: ConsoleNode, code: string, message: string): never => {
		throw new Located(code, message, node.start, node.end);
	};

	const member = async (node: ConsoleNode & { kind: "member" }): Promise<unknown> => {
		const target = await walk(node.target);
		if (target instanceof EntityRef) {
			const found = Object.hasOwn(target.entity.members, node.name)
				? target.entity.members[node.name]
				: undefined;
			if (!found) fail(node, "no_member", `${target.entity.name} has no ${node.name}`);
			if (found?.kind === "method")
				fail(node, "is_method", `${target.entity.name}.${node.name} is a method; call it with ()`);
			return found?.kind === "property" ? settle(found.get()) : null;
		}
		if (isRecord(target)) {
			if (!Object.hasOwn(target, node.name)) fail(node, "no_member", `no field ${node.name}`);
			return target[node.name];
		}
		return fail(node, "wrong_type", `${kindOf(target)} has no fields`);
	};

	const call = async (node: ConsoleNode & { kind: "call" }): Promise<unknown> => {
		if (node.target.kind !== "member") return fail(node, "not_callable", "only a member can be called");
		const owner = await walk(node.target.target);
		const name = node.target.name;
		const args: unknown[] = [];
		for (const arg of node.args) args.push(await walk(arg));
		if (owner instanceof EntityRef) {
			const found = Object.hasOwn(owner.entity.members, name) ? owner.entity.members[name] : undefined;
			if (!found) return fail(node.target, "no_member", `${owner.entity.name} has no ${name}`);
			if (found.kind === "property")
				return fail(node, "not_callable", `${owner.entity.name}.${name} is not a method`);
			const required = found.params.filter((param) => !param.optional).length;
			if (args.length < required || args.length > found.params.length) {
				return fail(
					node,
					"wrong_args",
					`${owner.entity.name}.${name} takes ${required === found.params.length ? required : `${required} to ${found.params.length}`} arguments`,
				);
			}
			for (const [at, param] of found.params.entries()) {
				if (at >= args.length) break;
				const checked = param.schema.safeParse(args[at]);
				if (!checked.success) {
					return fail(
						node.args[at] ?? node,
						"wrong_args",
						`${owner.entity.name}.${name}: ${param.name} must be ${param.type}`,
					);
				}
				args[at] = checked.data;
			}
			if (found.slow && ++slow > 1) return fail(node, "too_slow", "one slow read per expression");
			try {
				return await settle(found.call(args));
			} catch (error) {
				if (error instanceof ConsoleError && !(error instanceof Located))
					return fail(node, error.code, error.message);
				throw error;
			}
		}
		try {
			return runBuiltin(name, owner, args, step);
		} catch (error) {
			if (error instanceof ConsoleError) return fail(node, error.code, error.message);
			throw error;
		}
	};

	const index = async (node: ConsoleNode & { kind: "index" }): Promise<unknown> => {
		const target = await walk(node.target);
		const key = node.index ? await walk(node.index) : null;
		if (Array.isArray(target)) {
			if (!Number.isInteger(key)) return fail(node, "wrong_type", "a list is indexed by a whole number");
			const at = (key as number) < 0 ? target.length + (key as number) : (key as number);
			if (at < 0 || at >= target.length)
				return fail(node, "out_of_range", `index ${key} is outside ${target.length} items`);
			return target[at];
		}
		if (isRecord(target)) {
			if (typeof key !== "string") return fail(node, "wrong_type", "a record is indexed by text");
			if (!Object.hasOwn(target, key)) return fail(node, "no_member", `no field ${key}`);
			return target[key];
		}
		return fail(node, "wrong_type", `${kindOf(target)} cannot be indexed`);
	};

	const finite = (node: ConsoleNode, value: number): number =>
		Number.isFinite(value) ? value : fail(node, "too_big", "number out of range");

	const scalar = (node: ConsoleNode, value: unknown): unknown => {
		if (value instanceof EntityRef) fail(node, "is_entity", `${value.entity.name} is an entity; pick a member`);
		return value;
	};

	const walk = async (node: ConsoleNode): Promise<unknown> => {
		step();
		switch (node.kind) {
			case "literal":
				return node.value;
			case "ident": {
				const entity = registry.get(node.name, audience);
				return entity ? new EntityRef(entity) : fail(node, "unknown_name", `no entity ${node.name}`);
			}
			case "member":
				return member(node);
			case "call":
				return call(node);
			case "index":
				return index(node);
			case "unary": {
				const operand = scalar(node.operand, await walk(node.operand));
				if (node.op === "!") {
					return typeof operand === "boolean"
						? !operand
						: fail(node, "wrong_type", `! needs a yes/no, not ${kindOf(operand)}`);
				}
				return typeof operand === "number"
					? finite(node, -operand)
					: fail(node, "wrong_type", `- needs a number, not ${kindOf(operand)}`);
			}
			case "binary": {
				const left = scalar(node.left, await walk(node.left));
				const right = scalar(node.right, await walk(node.right));
				if (node.op === "==") return sameValue(left, right);
				if (node.op === "!=") return !sameValue(left, right);
				if (node.op === "+" && typeof left === "string" && typeof right === "string") return left + right;
				if (typeof left !== "number" || typeof right !== "number") {
					return fail(
						node,
						"wrong_type",
						`${node.op} needs two numbers, not ${kindOf(left)} and ${kindOf(right)}`,
					);
				}
				if (node.op === "/" && right === 0) return fail(node, "division_by_zero", "division by zero");
				return finite(
					node,
					node.op === "+"
						? left + right
						: node.op === "-"
							? left - right
							: node.op === "*"
								? left * right
								: left / right,
				);
			}
			case "list": {
				const items: unknown[] = [];
				for (const item of node.items) items.push(scalar(item, await walk(item)));
				return items;
			}
			case "dict": {
				const record: Record<string, unknown> = Object.create(null);
				for (const entry of node.entries) record[entry.key] = scalar(entry.value, await walk(entry.value));
				return record;
			}
		}
	};

	try {
		return { ok: true, value: await walk(parsed.node) };
	} catch (error) {
		if (error instanceof Located) {
			return {
				ok: false,
				issue: { code: error.code, start: error.start, end: error.end, message: error.message },
			};
		}
		if (error instanceof ConsoleError) {
			return { ok: false, issue: { code: error.code, start: 0, end: source.length, message: error.message } };
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			issue: { code: "failed", start: 0, end: source.length, message: `the read failed: ${message}` },
		};
	}
}
