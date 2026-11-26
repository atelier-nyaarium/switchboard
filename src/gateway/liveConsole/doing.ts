import { z } from "zod";
import {
	AUTOMATION_ACTIONS,
	type AutomationActionKind,
	type AutomationActionParam,
	type AutomationActionRow,
} from "../../shared/schemasAutomation.js";
import type { ConsoleEntity, ConsoleMember, ConsoleParam } from "./registry.js";

const DESCRIPTIONS: Readonly<Record<string, string>> = {
	assistant: "The assistant, told by an automation.",
	ifttt: "IFTTT events this Gateway sends.",
	functions: "Functions an automation runs.",
};

const typeOf = (param: AutomationActionParam): string => {
	switch (param.kind) {
		case "switch":
			return "Device";
		case "choice":
			return (param.options ?? []).map((option) => `"${option.value}"`).join(" or ");
		case "values":
			return "Record";
		case "text":
		case "word":
		case "function":
			return "Text";
	}
};

const paramOf = (param: AutomationActionParam): ConsoleParam => ({
	name: param.name,
	// Nothing evaluates a doing member.
	schema: z.unknown(),
	type: typeOf(param),
	description: param.label,
	...(param.optional ? { optional: true } : {}),
	...(param.kind === "switch" ? { completes: "devices" as const } : {}),
});

export function doingAction(entity: string, method: string): AutomationActionKind | null {
	const rows = Object.entries(AUTOMATION_ACTIONS) as [AutomationActionKind, AutomationActionRow][];
	return rows.find(([, row]) => row.call.entity === entity && row.call.method === method)?.[0] ?? null;
}

function doingMembers(): Map<string, Record<string, ConsoleMember>> {
	const byEntity = new Map<string, Record<string, ConsoleMember>>();
	for (const [kind, row] of Object.entries(AUTOMATION_ACTIONS) as [AutomationActionKind, AutomationActionRow][]) {
		const members = byEntity.get(row.call.entity) ?? {};
		members[row.call.method] = {
			kind: "doing",
			description: `${row.label}.`,
			params: row.params.map(paramOf),
			action: kind,
		};
		byEntity.set(row.call.entity, members);
	}
	return byEntity;
}

export function withDoing(entities: readonly ConsoleEntity[]): ConsoleEntity[] {
	const doing = doingMembers();
	const merged = entities.map((entity) => {
		const added = doing.get(entity.name);
		doing.delete(entity.name);
		if (!added) return entity;
		const taken = Object.keys(added).find((name) => Object.hasOwn(entity.members, name));
		if (taken) throw new Error(`console member ${entity.name}.${taken} is registered twice`);
		return { ...entity, members: { ...entity.members, ...added } };
	});
	const alone = [...doing].map(
		([name, members]): ConsoleEntity => ({
			name,
			description: DESCRIPTIONS[name] ?? "Actions an automation takes.",
			audiences: ["script"],
			members,
		}),
	);
	return [...merged, ...alone];
}
