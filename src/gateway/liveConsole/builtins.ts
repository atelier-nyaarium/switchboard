import { canonicalJson } from "../../shared/canonical-json.js";
import { roundTo } from "../../shared/field-types.js";

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
	params: readonly { name: string; check: (value: unknown) => boolean; type: string; optional?: boolean }[];
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
export const elementOf = (type: string | undefined) => type?.match(/^List<(.+)>$/)?.[1];

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
		name: "if",
		receiver: "none",
		params: [
			{ name: "when", check: (value) => typeof value === "boolean", type: "Yes/no" },
			{ name: "then", check: any, type: "Any" },
			{ name: "otherwise", check: any, type: "Any" },
		],
		returns: "Any",
		description: "then when it holds, else otherwise; only the one chosen is read.",
		lazy: true,
		type: () => undefined,
		run: (_receiver, [when, then, otherwise]) => (when ? then : otherwise),
	},
];

const BY_NAME = new Map(
	BUILTINS.filter((builtin) => builtin.receiver !== "none").map((builtin) => [builtin.name, builtin]),
);
const FREE = new Map(
	BUILTINS.filter((builtin) => builtin.receiver === "none").map((builtin) => [builtin.name, builtin]),
);

export const freeBuiltin = (name: string): Builtin | undefined => FREE.get(name);

const arity = ({ name, params }: Builtin): string => {
	const required = params.filter((param) => !param.optional).length;
	const range = required === params.length ? `${required}` : `${required} to ${params.length}`;
	return `${name}() takes ${range} argument${params.length === 1 ? "" : "s"}`;
};

export function checkArgs(builtin: Builtin, args: readonly unknown[]): void {
	const required = builtin.params.filter((param) => !param.optional).length;
	if (args.length < required || args.length > builtin.params.length) {
		throw new ConsoleError("wrong_args", arity(builtin));
	}
	args.forEach((arg, at) => {
		const param = builtin.params[at];
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
