import type { TriggerGiven } from "../../shared/automation-fit.js";
import type { ConsoleOp } from "../../shared/console-protocol.js";
import type { AutomationTrigger } from "../../shared/schemasAutomation.js";
import type { FunctionParam, FunctionStep } from "../../shared/schemasFunction.js";
import type { ConsoleDescription } from "../../shared/schemasLiveConsole.js";
import {
	type ConsoleScriptParseResult,
	type ConsoleScriptPrintResult,
	SCRIPT_ISSUE_MAX,
	SCRIPT_NAMES_MAX,
	SCRIPT_TYPE_MEMBERS_MAX,
	type ScriptFunction,
} from "../../shared/schemasScript.js";
import { membersOf } from "../../shared/script-types.js";
import { oneLine } from "../../shared/system-reminder.js";
import { parseScript, placeIssue, printScript, type ScriptTables, scriptNames } from "./automationScript.js";

export interface ScriptOpsDeps {
	switches: () => ScriptTables["switches"];
	functions: () => readonly ScriptFunction[];
	/** Throws for a trigger it cannot read. */
	givenOf: (trigger: AutomationTrigger) => TriggerGiven;
	vocabulary: () => ConsoleDescription;
	/** The first step a save would refuse. */
	stepIssue: (body: {
		params: readonly FunctionParam[];
		steps: readonly FunctionStep[];
	}) => { step: string; param?: string; start?: number; end?: number; message: string } | null;
}

const cut = (message: string) => oneLine(message).slice(0, SCRIPT_ISSUE_MAX);

type PrintRequest = Omit<Extract<ConsoleOp, { kind: "script_print" }>, "kind">;
type ParseRequest = Omit<Extract<ConsoleOp, { kind: "script_parse" }>, "kind">;
type Context = Pick<ParseRequest, "trigger" | "params" | "functions">;

export function scriptOps(deps: ScriptOpsDeps) {
	/** The draft's functions over the stored ones. */
	const tables = (context: Context): ScriptTables => {
		const drafted = context.functions ?? [];
		const stored = deps.functions().filter((held) => !drafted.some((draft) => draft.id === held.id));
		return { switches: deps.switches(), functions: [...drafted, ...stored] };
	};

	const given = (trigger: AutomationTrigger | undefined): TriggerGiven | undefined => {
		if (!trigger) return undefined;
		try {
			return deps.givenOf(trigger);
		} catch {
			return undefined;
		}
	};

	const namesOf = (context: Context, read: Parameters<typeof scriptNames>[0]["bindings"], length: number) =>
		scriptNames({
			length,
			bindings: read,
			given: given(context.trigger),
			params: context.params,
			description: deps.vocabulary(),
		}).slice(0, SCRIPT_NAMES_MAX);

	/** The types a script names that no registry declares. */
	const typesOf = (context: Context): ConsoleScriptPrintResult["types"] => {
		const eventFields = given(context.trigger)?.eventFields;
		const scope = { names: new Map<string, string>(), eventFields, description: deps.vocabulary() };
		return ["Error", "Task", ...(eventFields ? ["Event"] : [])].map((name) => ({
			name,
			members: Object.entries(membersOf(name, scope))
				.map(([member, type]) => ({ name: member, type }))
				.slice(0, SCRIPT_TYPE_MEMBERS_MAX),
		}));
	};

	return {
		print(request: PrintRequest): ConsoleScriptPrintResult {
			const printed = printScript(request.steps, tables(request));
			return {
				text: printed.text,
				...(printed.readOnly ? { readOnly: printed.readOnly } : {}),
				names: namesOf(request, printed.bindings, printed.text.length),
				types: typesOf(request),
				statements: printed.statements,
			};
		},

		parse(request: ParseRequest): ConsoleScriptParseResult {
			const parsed = parseScript(request.text, tables(request));
			const names = namesOf(request, parsed.bindings, request.text.length);
			const types = typesOf(request);
			if (!parsed.steps) {
				const issues = parsed.issues.map((issue) => ({ ...issue, message: cut(issue.message) }));
				return { issues, names, types, statements: [] };
			}
			const refused = deps.stepIssue({ params: request.params ?? [], steps: parsed.steps });
			const where = refused ? (placeIssue(parsed, refused) ?? { start: 0, end: request.text.length }) : null;
			const placed = request.place ? placeIssue(parsed, request.place) : null;
			return {
				steps: parsed.steps,
				...(refused && where ? { issues: [{ ...where, message: cut(refused.message) }] } : {}),
				names,
				types,
				statements: parsed.statements,
				...(placed ? { placed } : {}),
			};
		},
	};
}
