import type { z } from "zod";
import { canonicalJson, sha256Hex } from "../../shared/canonical-json.js";
import type {
	ConsoleCompletes,
	ConsoleDescription,
	ConsoleEntityDescription,
} from "../../shared/schemasLiveConsole.js";
import { BUILTINS } from "./builtins.js";

export type ConsoleAudience = "host" | "owner";

export interface ConsoleParam {
	name: string;
	schema: z.ZodType;
	type: string;
	description: string;
	optional?: boolean;
	completes?: ConsoleCompletes;
}

export type ConsoleMember =
	| { kind: "property"; description: string; type: string; get: () => unknown }
	| {
			kind: "method";
			description: string;
			params: readonly ConsoleParam[];
			returns: string;
			/** One slow read per request. */
			slow?: boolean;
			call: (args: unknown[]) => unknown;
	  };

/** Handlers are read-only. */
export interface ConsoleEntity {
	name: string;
	description: string;
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

export function describeEntity(entity: ConsoleEntity): ConsoleEntityDescription {
	return {
		name: entity.name,
		description: entity.description,
		catalogue: entity.catalogue === true,
		members: Object.entries(entity.members).map(([name, member]) => ({
			name,
			kind: member.kind,
			returns: member.kind === "property" ? member.type : member.returns,
			description: member.description,
			params:
				member.kind === "property"
					? []
					: member.params.map((param) => ({
							name: param.name,
							type: param.type,
							description: param.description,
							optional: param.optional === true,
							...(param.completes ? { completes: param.completes } : {}),
						})),
			slow: member.kind === "method" && member.slow === true,
		})),
	};
}

const BUILTIN_DESCRIPTIONS: ConsoleDescription["builtins"] = BUILTINS.map((builtin) => ({
	name: builtin.name,
	receiver: builtin.receiver,
	params: builtin.params.map((param) => ({ name: param.name, type: param.type })),
	returns: builtin.returns,
	description: builtin.description,
}));

const RECEIVERS = { list: "List", object: "Record", collection: "List or Record" } as const;

const params = (list: readonly { name: string; type: string; optional?: boolean }[]) =>
	list.map((param) => `${param.name}${param.optional ? "?" : ""}: ${param.type}`).join(", ");

export function entityText(entity: ConsoleEntityDescription): string[] {
	const lines = [`${entity.name}: ${entity.description}`];
	for (const member of entity.members) {
		const call = member.kind === "method" ? `(${params(member.params)})` : "";
		lines.push(`  ${entity.name}.${member.name}${call} -> ${member.returns}  ${member.description}`);
		for (const param of member.params) lines.push(`    ${param.name}: ${param.description}`);
	}
	return lines;
}

function descriptionText(description: ConsoleDescription): string {
	const section = (title: string, list: ConsoleEntityDescription[]) =>
		list.length === 0 ? [] : [title, ...list.flatMap(entityText), ""];
	return [
		"Read-only expressions over this Gateway.",
		'Grammar: paths and calls (sensors.read("Freezer")), indexing (x[0], x["key"]), == != ! + - * /, lists [a, b] and dicts {k: v}. No assignment.',
		"Builtins on values:",
		...description.builtins.map(
			(builtin) =>
				`  ${RECEIVERS[builtin.receiver]}.${builtin.name}(${params(builtin.params)}) -> ${builtin.returns}  ${builtin.description}`,
		),
		"Type an entity's name alone to list its members.",
		"",
		...section(
			"Types:",
			description.entities.filter((entity) => entity.catalogue),
		),
		...section(
			"Services:",
			description.entities.filter((entity) => !entity.catalogue),
		),
	]
		.join("\n")
		.trimEnd();
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

	const projection = (audience: ConsoleAudience): ConsoleDescription => ({
		builtins: BUILTIN_DESCRIPTIONS,
		entities: served(audience).map(describeEntity),
	});

	return {
		get(name: string, audience: ConsoleAudience): ConsoleEntity | null {
			const entity = byName.get(name);
			return entity?.audiences.includes(audience) ? entity : null;
		},
		names: (audience: ConsoleAudience) => served(audience).map((entity) => entity.name),
		projection,
		describe: (audience: ConsoleAudience) => descriptionText(projection(audience)),
		hash: (audience: ConsoleAudience) => sha256Hex(canonicalJson(projection(audience))).slice(0, 16),
	};
}

export type ConsoleRegistry = ReturnType<typeof createConsoleRegistry>;
