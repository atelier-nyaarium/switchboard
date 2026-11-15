import { createHash } from "node:crypto";
import type { z } from "zod";
import { BUILTINS } from "./builtins.js";

export type ConsoleAudience = "host" | "owner";

export interface ConsoleParam {
	name: string;
	schema: z.ZodType;
	/** Signature type label. */
	type: string;
	description: string;
	optional?: boolean;
}

export type ConsoleMember =
	| { kind: "property"; description: string; type: string; get: () => unknown }
	| {
			kind: "method";
			description: string;
			params: readonly ConsoleParam[];
			returns: string;
			/** One slow read per expression. */
			slow?: boolean;
			call: (args: unknown[]) => unknown;
	  };

/** Handlers must be read-only. */
export interface ConsoleEntity {
	name: string;
	description: string;
	/** Marks a type catalogue. */
	catalogue?: boolean;
	audiences: readonly ConsoleAudience[];
	members: Readonly<Record<string, ConsoleMember>>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function check(entity: ConsoleEntity): void {
	if (!NAME.test(entity.name)) throw new Error(`console entity name ${entity.name} is not a name`);
	for (const [name, member] of Object.entries(entity.members)) {
		if (!NAME.test(name)) throw new Error(`console member ${entity.name}.${name} is not a name`);
		if (member.kind !== "method") continue;
		let optional = false;
		for (const param of member.params) {
			if (!NAME.test(param.name))
				throw new Error(`console param ${entity.name}.${name}(${param.name}) is not a name`);
			if (optional && !param.optional) {
				throw new Error(
					`console param ${entity.name}.${name}(${param.name}) is required after an optional one`,
				);
			}
			optional ||= param.optional === true;
		}
	}
}

export function signatureOf(entity: string, name: string, member: ConsoleMember): string {
	if (member.kind === "property") return `${entity}.${name} -> ${member.type}`;
	const params = member.params.map((param) => `${param.name}${param.optional ? "?" : ""}: ${param.type}`).join(", ");
	return `${entity}.${name}(${params}) -> ${member.returns}`;
}

const RECEIVERS = { list: "List", object: "Record", collection: "List or Record" } as const;

const GRAMMAR_LINES = [
	"Read-only expressions over this Gateway.",
	'Grammar: paths and calls (sensors.read("Freezer")), indexing (x[0], x["key"]), == != ! + - * /, lists [a, b] and dicts {k: v}. No assignment.',
	"Builtins on values:",
	...BUILTINS.map(
		(builtin) =>
			`  ${RECEIVERS[builtin.receiver]}.${builtin.name}(${builtin.params.map((param) => `${param.name}: ${param.type}`).join(", ")}) -> ${builtin.returns}  ${builtin.description}`,
	),
	"Type an entity's name alone to list its members.",
];

export function entityText(entity: ConsoleEntity): string[] {
	const lines = [`${entity.name}: ${entity.description}`];
	for (const [name, member] of Object.entries(entity.members)) {
		lines.push(`  ${signatureOf(entity.name, name, member)}  ${member.description}`);
		if (member.kind === "method")
			for (const param of member.params) lines.push(`    ${param.name}: ${param.description}`);
	}
	return lines;
}

export function createConsoleRegistry(entities: readonly ConsoleEntity[]) {
	const byName = new Map<string, ConsoleEntity>();
	for (const entity of entities) {
		check(entity);
		if (byName.has(entity.name)) throw new Error(`console entity ${entity.name} is registered twice`);
		byName.set(entity.name, entity);
	}

	const served = (audience: ConsoleAudience) =>
		[...byName.values()].filter((entity) => entity.audiences.includes(audience));

	const describe = (audience: ConsoleAudience): string => {
		const all = served(audience);
		const section = (title: string, list: ConsoleEntity[]) =>
			list.length === 0 ? [] : [title, ...list.flatMap((entity) => entityText(entity)), ""];
		return [
			...GRAMMAR_LINES,
			"",
			...section(
				"Types:",
				all.filter((entity) => entity.catalogue),
			),
			...section(
				"Services:",
				all.filter((entity) => !entity.catalogue),
			),
		]
			.join("\n")
			.trimEnd();
	};

	return {
		get(name: string, audience: ConsoleAudience): ConsoleEntity | null {
			const entity = byName.get(name);
			return entity?.audiences.includes(audience) ? entity : null;
		},
		names: (audience: ConsoleAudience) => served(audience).map((entity) => entity.name),
		describe,
		hash: (audience: ConsoleAudience) => createHash("sha256").update(describe(audience)).digest("hex").slice(0, 12),
	};
}

export type ConsoleRegistry = ReturnType<typeof createConsoleRegistry>;
