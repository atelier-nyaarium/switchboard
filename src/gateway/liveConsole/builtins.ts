import { canonicalJson } from "../../shared/canonical-json.js";

export class ConsoleError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

type Receiver = "list" | "object" | "collection";

export interface Builtin {
	name: string;
	receiver: Receiver;
	params: readonly { name: string; check: (value: unknown) => boolean; type: string }[];
	returns: string;
	description: string;
	/** The result's label, from the receiver's. */
	type: (receiver: string | undefined) => string | undefined;
	/** Charge steps for work. */
	run: (receiver: unknown, args: unknown[], step: (count: number) => void) => unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
const field = (value: unknown) => typeof value === "string";
const any = () => true;
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
			// Serialized once, not per item.
			const wanted = canonicalJson(value ?? null);
			return list.filter((item) => {
				if (!isRecord(item)) return false;
				const held = Object.hasOwn(item, name as string) ? item[name as string] : null;
				return held === value || canonicalJson(held ?? null) === wanted;
			});
		},
	},
];

const BY_NAME = new Map(BUILTINS.map((builtin) => [builtin.name, builtin]));

const fits = (receiver: Receiver, value: unknown) =>
	receiver === "list"
		? Array.isArray(value)
		: receiver === "object"
			? isRecord(value)
			: Array.isArray(value) || isRecord(value);

/** The result with its label. */
export function runBuiltin(
	name: string,
	receiver: unknown,
	held: string | undefined,
	args: unknown[],
	step: (count: number) => void,
): { value: unknown; type: string | undefined } {
	const builtin = BY_NAME.get(name);
	if (!builtin) throw new ConsoleError("no_member", `no builtin ${name}()`);
	if (!fits(builtin.receiver, receiver)) {
		throw new ConsoleError(
			"wrong_type",
			`${name}() works on a ${builtin.receiver === "collection" ? "list or record" : builtin.receiver}`,
		);
	}
	if (args.length !== builtin.params.length) {
		throw new ConsoleError(
			"wrong_args",
			`${name}() takes ${builtin.params.length} argument${builtin.params.length === 1 ? "" : "s"}`,
		);
	}
	builtin.params.forEach((param, at) => {
		if (!param.check(args[at]))
			throw new ConsoleError("wrong_args", `${name}(): ${param.name} must be ${param.type}`);
	});
	return { value: builtin.run(receiver, args, step), type: builtin.type(held) };
}
