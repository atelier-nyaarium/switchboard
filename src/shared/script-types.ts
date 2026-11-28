import { EVENT_GIVEN_FIELDS, type GivenType } from "./automation-fit.js";
import type { ConsoleNode } from "./live-console-grammar.js";
import type { FunctionParamType } from "./schemasFunction.js";
import type { ConsoleDescription } from "./schemasLiveConsole.js";

/** A type is one of these, or a label the registry declares. */
export const SCRIPT_TYPES = [
	"Text",
	"Number",
	"Boolean",
	"Time",
	"Device",
	"Event",
	"Error",
	"Task",
	"List",
	"Record",
	"Unknown",
] as const;
export type ScriptType = (typeof SCRIPT_TYPES)[number];

export const SCRIPT_TYPE_MAX = 80;

export const GIVEN_SCRIPT_TYPES = {
	event: "Event",
	text: "Text",
	number: "Number",
	device: "Device",
	time: "Time",
} as const satisfies Record<GivenType, ScriptType>;

export const PARAM_SCRIPT_TYPES = {
	device: "Device",
	text: "Text",
	number: "Number",
} as const satisfies Record<FunctionParamType, ScriptType>;

export const ERROR_MEMBERS: Readonly<Record<string, string>> = {
	code: "Text",
	message: "Text",
	// First failure per branch.
	errors: "List<Error>",
};

export const TASK_MEMBERS: Readonly<Record<string, string>> = {
	done: "Boolean",
	failed: "Boolean",
	error: "Error",
};

export interface TypeScope {
	/** Held names; one shadows an entity. */
	names: ReadonlyMap<string, string>;
	/** An event's declared fields, beside the given ones. */
	eventFields?: readonly string[];
	description: ConsoleDescription;
}

export function membersOf(type: string, scope: TypeScope): Readonly<Record<string, string>> {
	if (type === "Error") return ERROR_MEMBERS;
	if (type === "Task") return TASK_MEMBERS;
	if (type === "Event") {
		const fields = [...EVENT_GIVEN_FIELDS, ...(scope.eventFields ?? [])];
		return Object.fromEntries(fields.map((field) => [field, "Text"]));
	}
	const declared = scope.description.entities.find((entity) => entity.catalogue && entity.name === type);
	const read = (declared?.members ?? []).filter((member) => member.kind === "property");
	return Object.fromEntries(read.map((member) => [member.name, member.returns]));
}

const COMPARES: ReadonlySet<string> = new Set(["==", "!=", "<", ">", "<=", ">=", "and", "or"]);
/** What a `List<Item>` label holds. */
export const elementOf = (type: string | undefined): string | undefined => type?.match(/^List<(.+)>$/)?.[1];
const known = (label: string | undefined): string =>
	label === undefined || label === "" || label === "Any" ? "Unknown" : label.slice(0, SCRIPT_TYPE_MAX);

/** Never refuses: `Unknown` where nothing declares it. */
export function typeOfNode(node: ConsoleNode | null, scope: TypeScope): string {
	if (!node) return "Unknown";
	const entityOf = (target: ConsoleNode) =>
		target.kind === "ident" && !scope.names.has(target.name)
			? scope.description.entities.find((entity) => !entity.catalogue && entity.name === target.name)
			: undefined;
	switch (node.kind) {
		case "literal":
			if (typeof node.value === "string") return "Text";
			if (typeof node.value === "number") return "Number";
			return typeof node.value === "boolean" ? "Boolean" : "Unknown";
		case "template":
			return "Text";
		case "ident":
			return known(scope.names.get(node.name));
		case "member": {
			const entity = entityOf(node.target);
			if (entity) {
				const member = entity.members.find((held) => held.name === node.name);
				return member?.kind === "property" ? known(member.returns) : "Unknown";
			}
			return known(membersOf(typeOfNode(node.target, scope), scope)[node.name]);
		}
		case "call": {
			const { target } = node;
			if (target.kind === "ident") {
				const free = scope.description.builtins.find(
					(builtin) => builtin.receiver === "none" && builtin.name === target.name,
				);
				return known(free?.returns);
			}
			if (target.kind !== "member") return "Unknown";
			const method = entityOf(target.target)?.members.find((held) => held.name === target.name);
			if (method) return method.kind === "method" ? known(method.returns) : "Unknown";
			const builtin = scope.description.builtins.find(
				(held) => held.receiver !== "none" && held.name === target.name,
			);
			return known(builtin?.returns);
		}
		case "index":
			return known(elementOf(typeOfNode(node.target, scope)));
		case "unary":
			return node.op === "!" ? "Boolean" : "Number";
		case "binary": {
			if (COMPARES.has(node.op)) return "Boolean";
			if (node.op !== "+") return "Number";
			// Two texts join.
			const sides = [typeOfNode(node.left, scope), typeOfNode(node.right, scope)];
			if (sides.includes("Text")) return "Text";
			return sides.every((side) => side === "Number") ? "Number" : "Unknown";
		}
		case "list":
			return "List";
		case "dict":
			return "Record";
	}
}
