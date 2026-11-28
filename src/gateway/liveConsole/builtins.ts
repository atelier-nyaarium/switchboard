import { canonicalJson } from "../../shared/canonical-json.js";
import { roundTo } from "../../shared/field-types.js";
import { elementOf } from "../../shared/script-types.js";
import { JOIN_KEYS, waitedOf } from "../../shared/task-values.js";

export class ConsoleError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

type Receiver = "list" | "object" | "collection" | "none";

export interface Builtin {
	name: string;
	receiver: Receiver;
	/** `rest`: last param, repeatable. */
	params: readonly {
		name: string;
		check: (value: unknown) => boolean;
		type: string;
		optional?: boolean;
		rest?: boolean;
	}[];
	returns: string;
	description: string;
	/** Evaluates arguments on demand. */
	lazy?: boolean;
	/** Receiver sets result type. */
	type: (receiver: string | undefined) => string | undefined;
	/** Charge steps for work. */
	run: (receiver: unknown, args: unknown[], step: (count: number) => void) => unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
const field = (value: unknown) => typeof value === "string";
const any = () => true;
const number = (value: unknown) => typeof value === "number";
const places = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6;
const same = (receiver: string | undefined) => receiver;

export { elementOf };

/** A task or a join, as a step reads it. */
interface Standing {
	done: boolean;
	failed: boolean;
	error: { code: string; message: string } | null;
}

const isTask = (value: unknown): value is Standing =>
	isRecord(value) && waitedOf(value) !== null && typeof value.done === "boolean" && typeof value.failed === "boolean";

const tasks = [
	{ name: "first", check: isTask, type: "Task" },
	{ name: "more", check: isTask, type: "Task", optional: true, rest: true },
] as const;

/** `all` or `any` of tasks, standing as they stand. */
function joined(mode: "all" | "any", held: readonly unknown[]): Record<string, unknown> {
	const once = [...new Map((held as Standing[]).map((item) => [canonicalJson(waitedOf(item)), item])).values()];
	const key = { [JOIN_KEYS[mode]]: once };
	if (mode === "any") return { ...key, done: once.some((item) => item.done), failed: false, error: null };
	const done = once.every((item) => item.done);
	const errors = done
		? once.flatMap((item) => (item.error ? [{ code: item.error.code, message: item.error.message }] : []))
		: [];
	const error =
		errors.length > 0 ? { code: "parallel", message: `${errors.length} of ${once.length} failed`, errors } : null;
	return { ...key, done, failed: error !== null, error };
}

export const sameValue = (left: unknown, right: unknown): boolean =>
	left === right || canonicalJson(left ?? null) === canonicalJson(right ?? null);

export const BUILTINS: readonly Builtin[] = [
	{
		name: "count",
		receiver: "collection",
		params: [],
		returns: "Number",
		description: "Items in a list, or fields in a record.",
		type: () => undefined,
		run: (receiver) => (Array.isArray(receiver) ? receiver.length : Object.keys(receiver as object).length),
	},
	{
		name: "first",
		receiver: "list",
		params: [],
		returns: "Item or none",
		description: "The first item.",
		type: elementOf,
		run: (receiver) => (receiver as unknown[])[0] ?? null,
	},
	{
		name: "take",
		receiver: "list",
		params: [{ name: "n", check: count, type: "Number" }],
		returns: "List",
		description: "The first n items.",
		type: same,
		run: (receiver, [n], step) => {
			step(Math.min(n as number, (receiver as unknown[]).length));
			return (receiver as unknown[]).slice(0, n as number);
		},
	},
	{
		name: "skip",
		receiver: "list",
		params: [{ name: "n", check: count, type: "Number" }],
		returns: "List",
		description: "All but the first n items.",
		type: same,
		run: (receiver, [n], step) => {
			step((receiver as unknown[]).length);
			return (receiver as unknown[]).slice(n as number);
		},
	},
	{
		name: "keys",
		receiver: "object",
		params: [],
		returns: "List<Text>",
		description: "A record's field names.",
		type: () => "List<Text>",
		run: (receiver, _args, step) => {
			const keys = Object.keys(receiver as object);
			step(keys.length);
			return keys;
		},
	},
	{
		name: "where",
		receiver: "list",
		params: [
			{ name: "field", check: field, type: "Text" },
			{ name: "value", check: any, type: "Any" },
		],
		returns: "List",
		description: "Records whose field equals value.",
		type: same,
		run: (receiver, [name, value], step) => {
			const list = receiver as unknown[];
			step(list.length);
			const wanted = canonicalJson(value ?? null);
			return list.filter((item) => {
				if (!isRecord(item)) return false;
				const held = Object.hasOwn(item, name as string) ? item[name as string] : null;
				return held === value || canonicalJson(held ?? null) === wanted;
			});
		},
	},
	{
		name: "round",
		receiver: "none",
		params: [
			{ name: "x", check: number, type: "Number" },
			{ name: "places", check: places, type: "Number", optional: true },
		],
		returns: "Number",
		description: "x to that many decimals, none when left out.",
		type: () => undefined,
		run: (_receiver, [x, digits]) => roundTo(x as number, (digits as number | undefined) ?? 0),
	},
	{
		name: "all",
		receiver: "none",
		params: tasks,
		returns: "Task",
		description: "A task done when every one is, failed when any failed.",
		type: () => "Task",
		run: (_receiver, args) => joined("all", args),
	},
	{
		name: "any",
		receiver: "none",
		params: tasks,
		returns: "Task",
		description: "A task done with the first to end; awaiting it gives that one.",
		type: () => "Task",
		run: (_receiver, args) => joined("any", args),
	},
	{
		name: "if",
		receiver: "none",
		params: [
			{ name: "condition", check: (value) => typeof value === "boolean", type: "Boolean" },
			{ name: "then", check: any, type: "Any" },
			{ name: "else", check: any, type: "Any" },
		],
		returns: "Any",
		description: "then when the condition is true, else when false; only the one chosen is read.",
		lazy: true,
		type: () => undefined,
		run: (_receiver, [condition, then, elseValue]) => (condition ? then : elseValue),
	},
];

const BY_NAME = new Map(
	BUILTINS.filter((builtin) => builtin.receiver !== "none").map((builtin) => [builtin.name, builtin]),
);
const FREE = new Map(
	BUILTINS.filter((builtin) => builtin.receiver === "none").map((builtin) => [builtin.name, builtin]),
);

export const freeBuiltin = (name: string): Builtin | undefined => FREE.get(name);

const ON_VALUES = new Set(BUILTINS.filter((builtin) => builtin.receiver !== "none").map((builtin) => builtin.name));

/** A method some value takes. */
export const valueBuiltin = (name: string): boolean => ON_VALUES.has(name);

const restOf = (builtin: Builtin) => (builtin.params.at(-1)?.rest ? builtin.params.at(-1) : undefined);

const arity = (builtin: Builtin): string => {
	const { name, params } = builtin;
	const required = params.filter((param) => !param.optional).length;
	const range = restOf(builtin)
		? `${required} or more`
		: required === params.length
			? `${required}`
			: `${required} to ${params.length}`;
	return `${name}() takes ${range} argument${params.length === 1 && !restOf(builtin) ? "" : "s"}`;
};

export function arityIssue(builtin: Builtin, count: number): string | null {
	const required = builtin.params.filter((param) => !param.optional).length;
	const most = restOf(builtin) ? Number.POSITIVE_INFINITY : builtin.params.length;
	return count < required || count > most ? arity(builtin) : null;
}

export function checkArgs(builtin: Builtin, args: readonly unknown[]): void {
	const wrong = arityIssue(builtin, args.length);
	if (wrong) throw new ConsoleError("wrong_args", wrong);
	args.forEach((arg, at) => {
		const param = builtin.params[at] ?? restOf(builtin);
		if (param && !param.check(arg))
			throw new ConsoleError("wrong_args", `${builtin.name}(): ${param.name} must be ${param.type}`);
	});
}

export function runFree(builtin: Builtin, args: unknown[], step: (count: number) => void): unknown {
	checkArgs(builtin, args);
	return builtin.run(null, args, step);
}

const fits = (receiver: Receiver, value: unknown) =>
	receiver === "list"
		? Array.isArray(value)
		: receiver === "object"
			? isRecord(value)
			: receiver === "collection" && (Array.isArray(value) || isRecord(value));

export function runBuiltin(
	name: string,
	receiver: unknown,
	held: string | undefined,
	args: unknown[],
	step: (count: number) => void,
): { value: unknown; type: string | undefined } {
	const builtin = BY_NAME.get(name);
	if (!builtin) {
		throw new ConsoleError(
			"no_member",
			FREE.has(name) ? `${name}() is called by its name alone` : `no builtin ${name}()`,
		);
	}
	if (!fits(builtin.receiver, receiver)) {
		throw new ConsoleError(
			"wrong_type",
			`${name}() works on a ${builtin.receiver === "collection" ? "list or record" : builtin.receiver}`,
		);
	}
	checkArgs(builtin, args);
	return { value: builtin.run(receiver, args, step), type: builtin.type(held) };
}
