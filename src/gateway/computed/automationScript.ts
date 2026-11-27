import type { TriggerGiven } from "../../shared/automation-fit.js";
import { sidesOf } from "../../shared/automation-walk.js";
import {
	type ConsoleNode,
	type ConsoleStringPiece,
	type ConsoleTemplatePiece,
	isConsoleVariableName,
	parseConsoleExpression,
	parseConsoleText,
	piecesOf,
	quoteConsoleString,
	quoteConsoleText,
	trimConsole,
	writeConsoleRun,
} from "../../shared/live-console-grammar.js";
import {
	AUTOMATION_ACTIONS,
	type AutomationActionKind,
	type AutomationActionParam,
	type AutomationActionRow,
} from "../../shared/schemasAutomation.js";
import {
	FUNCTION_PARAMS_MAX,
	FUNCTION_STEPS_MAX,
	FUNCTION_STEPS_TOTAL_MAX,
	type FunctionParam,
	type FunctionStep,
	FunctionStepSchema,
	PARAM_NAME_RE,
	SCRIPT_SOURCE_MAX,
	STEP_TEXT_MAX,
	type StepArg,
	SWITCH_CASE_VALUES_MAX,
	SWITCH_CASES_MAX,
} from "../../shared/schemasFunction.js";
import type { ConsoleDescription } from "../../shared/schemasLiveConsole.js";
import {
	opensStatement,
	parseScriptSource,
	type ScriptIf,
	type ScriptNode,
	type ScriptSwitch,
} from "../../shared/script-grammar.js";
import { GIVEN_SCRIPT_TYPES, PARAM_SCRIPT_TYPES, typeOfNode } from "../../shared/script-types.js";
import { ASSISTANT_RULE_VALUE_MAX } from "../../shared/wire-vocabulary.js";
import { doingAction } from "../liveConsole/doing.js";

export interface ScriptTables {
	switches: readonly { id: string; name: string }[];
	functions: readonly { id: string; name: string; params: readonly FunctionParam[] }[];
}

/** UTF-16 offsets into the script. */
export interface ScriptIssue {
	start: number;
	end: number;
	message: string;
}

/** Where a step's value sits in the script, to place a save's refusal. */
export interface ScriptPlace {
	step: string;
	param: string;
	start: number;
	end: number;
	/** A text's characters, each with its own span in the script. */
	chars?: readonly (readonly [number, number])[];
}

/** A name a statement sets, and where it is offered. */
export interface ScriptBinding {
	name: string;
	start: number;
	end: number;
	/** A kept value; absent for a catch's `e`. */
	value?: StepArg;
	type?: string;
}

export interface ScriptStatement {
	step: string;
	start: number;
	end: number;
}

interface ScriptRead {
	bindings: ScriptBinding[];
	statements: ScriptStatement[];
}

export type ScriptParse = ScriptRead &
	(
		| { steps: FunctionStep[]; places: ScriptPlace[]; issues?: undefined }
		| { issues: ScriptIssue[]; steps?: undefined }
	);

const ISSUES_MAX = 8;
/** Case value index. */
const casePlace = (number: number, chip: number): string => `case:${number}:${chip}`;
const CALL = AUTOMATION_ACTIONS.run_function.call;
export const SCRIPT_UNWRITABLE = "it holds a step a script cannot write";
export const SCRIPT_UNREADABLE = "its text would not read back as the same steps";
export const SCRIPT_TOO_LONG = `it is longer than ${SCRIPT_SOURCE_MAX} characters as text`;
const TASK = "Task";

////////////////////////////////
//  Text and number encoding

/** A line break between tokens is a space. */
const oneLine = (source: string): string => source.replace(/[\r\n]/g, " ");

export function canonicalExpression(source: string): string {
	const written = trimConsole(source);
	return parseConsoleExpression(written).issues.length > 0 ? written : oneLine(written);
}

const quoteText = (text: string): string =>
	quoteConsoleText(text, parseConsoleText(text).issues.length > 0 ? (hole) => hole : oneLine);

/** Each character's own span in the script. */
type Chars = (readonly [number, number])[];

function charsOf(pieces: readonly ConsoleStringPiece[]): Chars {
	const chars: Chars = [];
	for (const piece of pieces) {
		for (let at = 0; at < piece.value.length; at++) {
			chars.push(piece.kind === "escape" ? [piece.start, piece.end] : [piece.start + at, piece.start + at + 1]);
		}
	}
	return chars;
}

function bodyOf(pieces: readonly ConsoleTemplatePiece[], source: string): { text: string; chars: Chars } {
	let text = "";
	const chars: Chars = [];
	const put = (written: string, start: number, end: number) => {
		text += written;
		for (let n = 0; n < written.length; n++) chars.push([start, end]);
	};
	for (const piece of pieces) {
		if (piece.kind === "escape") put(writeConsoleRun(piece.value), piece.start, piece.end);
		else {
			// Holes keep their written form.
			const hole = piece.kind === "hole";
			const run = hole ? oneLine(source.slice(piece.start, piece.end)) : piece.value;
			for (let at = 0; at < run.length; at++) {
				const c = run[at] as string;
				put(hole ? c : writeConsoleRun(c), piece.start + at, piece.start + at + 1);
			}
		}
	}
	return { text, chars };
}

/** Plain decimals, never an exponent. */
export function printNumber(value: number): string {
	if (value === 0) return "0";
	const written = String(Math.abs(value));
	const sign = value < 0 ? "-" : "";
	const [mantissa, exponent] = written.split("e") as [string, string | undefined];
	if (exponent === undefined) return sign + written;
	const [whole, fraction = ""] = mantissa.split(".") as [string, string | undefined];
	const digits = whole + fraction;
	const point = whole.length + Number(exponent);
	if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
	if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length);
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

////////////////////////////////
//  Print

const rowOf = (action: string): AutomationActionRow | null =>
	Object.hasOwn(AUTOMATION_ACTIONS, action) ? AUTOMATION_ACTIONS[action as AutomationActionKind] : null;

/** A name when exactly one holds it and no id is spelled so. */
function nameFor(id: string, held: readonly { id: string; name: string }[]): string {
	const name = held.find((entry) => entry.id === id)?.name;
	if (name === undefined || name === "") return id;
	const alone = held.filter((entry) => entry.name === name).length === 1 && !held.some((entry) => entry.id === name);
	return alone ? name : id;
}

/** An id for a name: null when two hold it. */
function idFor(written: string, held: readonly { id: string; name: string }[]): string | null {
	if (held.some((entry) => entry.id === written)) return written;
	const named = held.filter((entry) => entry.name === written);
	if (named.length > 1) return null;
	return named[0]?.id ?? written;
}

type Position =
	| { reads: "text" }
	| { reads: "plain"; held?: readonly { id: string; name: string }[]; what?: string }
	| { reads: "value" };

const VALUE: Position = { reads: "value" };

const plugs = (tables: ScriptTables): Position => ({ reads: "plain", held: tables.switches, what: "plug" });

const positionOf = (param: AutomationActionParam, tables: ScriptTables): Position =>
	param.kind === "text" ? { reads: "text" } : param.kind === "switch" ? plugs(tables) : { reads: "plain" };

const negative = (node: ConsoleNode): node is ConsoleNode & { kind: "unary" } =>
	node.kind === "unary" &&
	node.op === "-" &&
	node.operand.kind === "literal" &&
	typeof node.operand.value === "number" &&
	!node.operand.grouped;

const constant = (node: ConsoleNode): boolean => !node.grouped && (node.kind === "literal" || negative(node));

/** Prints steps as script; `readOnly` when parsing it back would lose a step. */
export interface ScriptPrint extends ScriptRead {
	text: string;
	readOnly?: string;
}

export function printScript(steps: readonly FunctionStep[], tables: ScriptTables): ScriptPrint {
	const [only] = steps;
	// Stored errors stay editable.
	if (steps.length === 1 && only?.kind === "unparsed") return { text: only.source, bindings: [], statements: [] };
	let unwritable = false;
	const lines: string[] = [];

	/** `absent`: a bare null here is a value left out. */
	const value = (arg: StepArg, at: Position, absent = false): string => {
		if (arg.kind === "expression") {
			const source = canonicalExpression(arg.text);
			const { node } = parseConsoleExpression(source);
			const bareNull = node?.kind === "literal" && node.value === null && !node.grouped;
			// Bare, a string with a hole is a text or refused.
			const template = node?.kind === "template" && !node.grouped && at.reads !== "value";
			// Parentheses keep it an expression.
			return node && (template || (constant(node) && (!bareNull || absent))) ? `(${source})` : source;
		}
		if (typeof arg.value === "number") return printNumber(arg.value);
		if (typeof arg.value === "boolean") return String(arg.value);
		if (at.reads === "text") return quoteText(arg.value);
		return quoteConsoleString(at.reads === "plain" && at.held ? nameFor(arg.value, at.held) : arg.value);
	};

	const doing = (step: Extract<FunctionStep, { kind: "do" }>): string | null => {
		const row = rowOf(step.action);
		const params = row?.params ?? [];
		const known = Object.keys(step.args).every((name) => params.some((param) => param.name === name));
		if (!row || step.action === "run_function" || step.as !== undefined || !known) return null;
		const last = params.findLastIndex((param) => Object.hasOwn(step.args, param.name));
		const written = params.slice(0, last + 1).map((param) => {
			const arg = step.args[param.name];
			return arg ? value(arg, positionOf(param, tables), true) : "null";
		});
		return `${row.call.entity}.${row.call.method}(${written.join(", ")})`;
	};

	const calling = (step: Extract<FunctionStep, { kind: "call" }>): string => {
		const callee = tables.functions.find((entry) => entry.id === step.function);
		// Parsing refuses a function not held.
		unwritable ||= callee === undefined;
		const order = [
			...(callee?.params ?? []).map((param) => param.name),
			...Object.keys(step.values ?? {}).sort(),
		].filter((name, at, all) => all.indexOf(name) === at && Object.hasOwn(step.values ?? {}, name));
		const entries = order.map((name) => {
			const device = callee?.params.find((param) => param.name === name)?.type === "device";
			const key = isConsoleVariableName(name) ? name : quoteConsoleString(name);
			return `${key}: ${value(step.values?.[name] as StepArg, device ? plugs(tables) : VALUE)}`;
		});
		const values = entries.length > 0 ? `, {${entries.join(", ")}}` : "";
		return `${CALL.entity}.${CALL.method}(${quoteConsoleString(nameFor(step.function, tables.functions))}${values})`;
	};

	/** Lines a step spans; `skip` past what belongs to the step before. */
	const spans: { step: string; first: number; last: number; skip: number }[] = [];
	const bound: { name: string; from: number; to: number | null; value?: StepArg; type?: string }[] = [];
	const keepable = (name: string | undefined): boolean =>
		name === undefined || (!opensStatement(name) && isConsoleVariableName(name));
	const keptAs = (name: string | undefined): string => (name === undefined ? "" : `${name} = `);

	const block = (list: readonly FunctionStep[], indent: string, prefix: string): void => {
		let commented = false;
		for (const [index, step] of list.entries()) {
			const path = `${prefix}${index}`;
			const written = step.kind === "do" ? doing(step) : null;
			const comment = step.kind === "note" || (step.kind === "do" && written === null);
			// A blank line parts two notes.
			if (comment && commented) lines.push("");
			commented = comment;
			const first = lines.length;
			switch (step.kind) {
				case "note":
					for (const line of step.text.replace(/\r\n?/g, "\n").split("\n")) {
						lines.push(`${indent}//${line === "" ? "" : ` ${line}`}`);
					}
					break;
				case "let":
					// A stored name the language took since.
					unwritable ||= opensStatement(step.name) || !isConsoleVariableName(step.name);
					lines.push(`${indent}${step.name} = ${value(step.value, VALUE)}`);
					bound.push({ name: step.name, from: first, to: null, value: step.value });
					break;
				case "exit":
					lines.push(`${indent}exit`);
					break;
				case "unparsed":
					unwritable = true;
					lines.push(`${indent}// ${SCRIPT_UNWRITABLE}`);
					break;
				case "throw":
					lines.push(`${indent}throw${step.text === undefined ? "" : ` ${quoteText(step.text)}`}`);
					break;
				case "wait":
					lines.push(`${indent}wait(${value(step.minutes, VALUE)})`);
					break;
				case "do":
					unwritable ||= written === null;
					lines.push(`${indent}${written ?? `// ${step.action}: ${SCRIPT_UNWRITABLE}`}`);
					break;
				case "call":
					lines.push(`${indent}${calling(step)}`);
					break;
				case "parallel":
					lines.push(`${indent}parallel {`);
					block(step.steps, `${indent}\t`, `${path}.0.`);
					lines.push(`${indent}}`);
					break;
				case "start":
					unwritable ||= !keepable(step.as);
					lines.push(`${indent}${keptAs(step.as)}start {`);
					block(step.steps, `${indent}\t`, `${path}.0.`);
					lines.push(`${indent}}`);
					if (step.as) bound.push({ name: step.as, from: lines.length - 1, to: null, type: TASK });
					break;
				case "await":
					unwritable ||= !keepable(step.as);
					lines.push(`${indent}${keptAs(step.as)}await ${canonicalExpression(step.task)}`);
					if (step.as) bound.push({ name: step.as, from: first, to: null, type: TASK });
					break;
				case "try": {
					lines.push(`${indent}try {`);
					block(step.steps, `${indent}\t`, `${path}.0.`);
					const caught = lines.length;
					lines.push(`${indent}} catch (e) {`);
					block(step.catch, `${indent}\t`, `${path}.1.`);
					lines.push(`${indent}}`);
					bound.push({ name: "e", from: caught, to: lines.length - 1 });
					break;
				}
				case "if": {
					let held: Extract<FunctionStep, { kind: "if" }> | undefined = step;
					let opening = `${indent}if`;
					let at = path;
					const chained: { step: string; first: number }[] = [];
					while (held) {
						lines.push(`${opening} (${canonicalExpression(held.when)}) {`);
						block(held.steps ?? [], `${indent}\t`, `${at}.0.`);
						const rest: readonly FunctionStep[] = held.else ?? [];
						const [only] = rest;
						held = rest.length === 1 && only?.kind === "if" ? only : undefined;
						if (held) {
							opening = `${indent}} else if`;
							at = `${at}.1.0`;
							chained.push({ step: at, first: lines.length });
						} else if (rest.length > 0) {
							lines.push(`${indent}} else {`);
							block(rest, `${indent}\t`, `${at}.1.`);
						}
					}
					lines.push(`${indent}}`);
					for (const link of chained) spans.push({ ...link, last: lines.length - 1, skip: "} else ".length });
					break;
				}
				case "switch": {
					lines.push(`${indent}switch (${canonicalExpression(step.subject)}) {`);
					for (const [number, held] of step.cases.entries()) {
						const values = held.values.map((each) => ` ${quoteConsoleString(each)}`).join(",");
						lines.push(`${indent}\tcase${values} {`);
						block(held.steps, `${indent}\t\t`, `${path}.${number}.`);
						lines.push(`${indent}\t}`);
					}
					if ((step.default ?? []).length > 0) {
						lines.push(`${indent}\tdefault {`);
						block(step.default ?? [], `${indent}\t\t`, `${path}.${step.cases.length}.`);
						lines.push(`${indent}\t}`);
					}
					lines.push(`${indent}}`);
					break;
				}
				default:
					step satisfies never;
			}
			spans.push({ step: path, first, last: lines.length - 1, skip: 0 });
		}
	};

	block(steps, "", "");
	const text = lines.join("\n");
	if (text.length > SCRIPT_SOURCE_MAX) return { text: "", readOnly: SCRIPT_TOO_LONG, bindings: [], statements: [] };
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	const startOf = (line: number) =>
		(starts[line] as number) + ((lines[line] as string).match(/^\t*/) as RegExpMatchArray)[0].length;
	const endOf = (line: number) => (starts[line] as number) + (lines[line] as string).length;
	const statements = spans
		.map(({ step, first, last, skip }) => ({ step, start: startOf(first) + skip, end: endOf(last) }))
		.sort((left, right) => left.start - right.start);
	const bindings = bound
		.map(
			({ name, from, to, value: kept, type }): ScriptBinding =>
				to === null
					? {
							name,
							start: endOf(from),
							end: text.length,
							...(kept ? { value: kept } : {}),
							...(type ? { type } : {}),
						}
					: { name, start: endOf(from) - 1, end: endOf(to) },
		)
		.sort((left, right) => left.start - right.start);
	// What cannot be read back is never offered to edit.
	const readOnly = unwritable ? SCRIPT_UNWRITABLE : parseScript(text, tables).steps ? undefined : SCRIPT_UNREADABLE;
	return { text, ...(readOnly ? { readOnly } : {}), bindings, statements };
}

////////////////////////////////
//  Parse

class Refused extends Error {
	constructor(readonly issue: ScriptIssue) {
		super(issue.message);
	}
}

function overBounds(steps: readonly FunctionStep[]): { step: string; message: string } | null {
	let total = 0;
	const walk = (list: readonly FunctionStep[], prefix: string): ReturnType<typeof overBounds> => {
		for (const [index, step] of list.entries()) {
			const path = `${prefix}${index}`;
			if (index >= FUNCTION_STEPS_MAX)
				return { step: path, message: `more than ${FUNCTION_STEPS_MAX} steps in one block` };
			if (++total > FUNCTION_STEPS_TOTAL_MAX)
				return { step: path, message: `more than ${FUNCTION_STEPS_TOTAL_MAX} steps` };
			for (const held of sidesOf(step)) {
				const found = walk(held.steps, `${path}.${held.number}.`);
				if (found) return found;
			}
		}
		return null;
	};
	return walk(steps, "");
}

export function parseScript(source: string, tables: ScriptTables): ScriptParse {
	const bindings: ScriptBinding[] = [];
	const statements: ScriptStatement[] = [];
	const tree = parseScriptSource(source);
	// A span of none still marks a character.
	const issues: ScriptIssue[] = tree.issues.map(({ start, end, message }) => ({
		start,
		end: Math.max(end, start + 1),
		message,
	}));
	const places: ScriptPlace[] = [];
	const tooLong = `longer than ${STEP_TEXT_MAX} characters`;

	const fail = (start: number, end: number, message: string): never => {
		throw new Refused({ start, end, message });
	};

	const quoted = (node: ConsoleNode): boolean =>
		!node.grouped && (node.kind === "template" || (node.kind === "literal" && typeof node.value === "string"));

	const text = (node: ConsoleNode, place: { step: string; param: string }): string => {
		const read = bodyOf(piecesOf(node) ?? [], source);
		if (read.text.length > STEP_TEXT_MAX) fail(node.start, node.end, tooLong);
		places.push({ ...place, start: node.start, end: node.end, chars: read.chars });
		return read.text;
	};

	const expression = (node: ConsoleNode, place: { step: string; param: string }): string => {
		const written = oneLine(source.slice(node.start, node.end));
		if (written.length > STEP_TEXT_MAX) fail(node.start, node.end, tooLong);
		places.push({ ...place, start: node.start, end: node.end });
		return written;
	};

	const lift = (node: ConsoleNode, place: { step: string; param: string }, at: Position): StepArg => {
		const { start, end } = node;
		if (quoted(node) && at.reads === "text") return { kind: "literal", value: text(node, place) };
		if (node.kind === "template" && !node.grouped && at.reads === "plain") {
			fail(start, end, "only a text takes a hole");
		}
		if (!constant(node) || (node.kind === "literal" && node.value === null)) {
			return { kind: "expression", text: expression(node, place) };
		}
		const pieces = node.kind === "literal" ? node.pieces : undefined;
		places.push({ ...place, start, end, ...(pieces ? { chars: charsOf(pieces) } : {}) });
		if (negative(node)) return { kind: "literal", value: -(node.operand as { value: number }).value };
		const value = (node as ConsoleNode & { kind: "literal" }).value as string | number | boolean;
		if (typeof value !== "string") return { kind: "literal", value };
		if (value.length > STEP_TEXT_MAX) fail(start, end, tooLong);
		if (at.reads !== "plain" || !at.held) return { kind: "literal", value };
		const id = idFor(value, at.held);
		if (id === null) fail(start, end, `two ${at.what}s are named ${value}; write its id`);
		return { kind: "literal", value: id as string };
	};

	const called = (node: ConsoleNode): AutomationActionKind | null => {
		if (node.kind !== "call" || node.grouped || !node.closed) return null;
		const { target } = node;
		if (target.kind !== "member" || target.target.kind !== "ident") return null;
		return doingAction(target.target.name, target.name);
	};

	const absent = (node: ConsoleNode): boolean => node.kind === "literal" && node.value === null && !node.grouped;

	const calling = (args: readonly ConsoleNode[], whole: ScriptNode, path: string): FunctionStep => {
		const [target, record] = args;
		const named = target && quoted(target) && target.kind === "literal";
		if (!target || !named) return fail(whole.start, whole.end, "name the function to run, in quotes");
		const written = target.value as string;
		const id = idFor(written, tables.functions);
		if (id === null) fail(target.start, target.end, `two functions are named ${written}; write its id`);
		const callee = tables.functions.find((entry) => entry.id === id);
		if (!callee) fail(target.start, target.end, `no function is named ${written}`);
		const values: Record<string, StepArg> = {};
		if (record && !absent(record)) {
			if (record.kind !== "dict" || record.grouped || !record.closed) {
				return fail(record.start, whole.end, "its values are written {name: value}");
			}
			for (const entry of record.entries) {
				const param = entry.key;
				if (!PARAM_NAME_RE.test(param)) fail(entry.start, entry.value.end, "write a value as name: value");
				if (Object.hasOwn(values, param)) fail(entry.start, entry.end, `${param} is given twice`);
				if (Object.keys(values).length >= FUNCTION_PARAMS_MAX) {
					fail(entry.start, entry.end, `more than ${FUNCTION_PARAMS_MAX} values`);
				}
				const declared = callee?.params.find((held) => held.name === param);
				if (callee && !declared) fail(entry.start, entry.end, `it takes no ${param}`);
				const at = declared?.type === "device" ? plugs(tables) : VALUE;
				values[param] = lift(entry.value, { step: path, param }, at);
			}
		}
		// Declared order, then the rest by name.
		const order = [...(callee?.params ?? []).map((held) => held.name), ...Object.keys(values).sort()];
		const sorted = Object.fromEntries(
			order.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key] as StepArg]),
		);
		return { kind: "call", function: id as string, ...(Object.keys(sorted).length > 0 ? { values: sorted } : {}) };
	};

	const doing = (node: ScriptNode & { kind: "run" }, path: string): FunctionStep => {
		const action = called(node.node);
		if (!action || node.node.kind !== "call") {
			return fail(node.start, node.end, "it does nothing: keep it under a name, or call an action");
		}
		const row = AUTOMATION_ACTIONS[action];
		const { args } = node.node;
		if (args.length > row.params.length) {
			const name = `${row.call.entity}.${row.call.method}`;
			fail(node.start, node.end, `${name} takes at most ${row.params.length} values`);
		}
		if (action === "run_function") return calling(args, node, path);
		const read: Record<string, StepArg> = {};
		for (const [index, arg] of args.entries()) {
			const param = row.params[index] as AutomationActionParam;
			if (absent(arg)) continue;
			read[param.name] = lift(arg, { step: path, param: param.name }, positionOf(param, tables));
		}
		return { kind: "do", action, args: read };
	};

	const branch = (node: ScriptIf, path: string): FunctionStep => {
		const when = expression(node.when, { step: path, param: "when" });
		const steps = block(node.then.steps, `${path}.0`);
		let otherwise: FunctionStep[] = [];
		if (node.otherwise && "kind" in node.otherwise) {
			const at = `${path}.1.0`;
			otherwise = [branch(node.otherwise, at)];
			statements.push({ step: at, start: node.otherwise.start, end: node.otherwise.end });
		} else if (node.otherwise) otherwise = block(node.otherwise.steps, `${path}.1`);
		return {
			kind: "if",
			when,
			...(steps.length > 0 ? { steps } : {}),
			...(otherwise.length > 0 ? { else: otherwise } : {}),
		};
	};

	const caseValue = (node: ConsoleNode, place: { step: string; param: string }): string => {
		if (node.kind === "template" && !node.grouped) fail(node.start, node.end, "a case value takes no hole");
		if (node.kind !== "literal" || node.grouped || typeof node.value !== "string") {
			return fail(node.start, node.end, "write a case value in quotes");
		}
		if (node.value.length > ASSISTANT_RULE_VALUE_MAX) {
			fail(node.start, node.end, `longer than ${ASSISTANT_RULE_VALUE_MAX} characters`);
		}
		places.push({ ...place, start: node.start, end: node.end, chars: charsOf(node.pieces ?? []) });
		return node.value;
	};

	const switched = (node: ScriptSwitch, path: string): FunctionStep => {
		const subject = expression(node.subject, { step: path, param: "subject" });
		if (node.cases.length > SWITCH_CASES_MAX) fail(node.start, node.end, `more than ${SWITCH_CASES_MAX} cases`);
		const cases = node.cases.map((held, number) => {
			if (held.values.length > SWITCH_CASE_VALUES_MAX) {
				fail(held.start, held.body.start, `more than ${SWITCH_CASE_VALUES_MAX} values in one case`);
			}
			const values = held.values.map((value, chip) =>
				caseValue(value, { step: path, param: casePlace(number, chip) }),
			);
			return { values, steps: block(held.body.steps, `${path}.${number}`) };
		});
		const fallback = node.otherwise ? block(node.otherwise.steps, `${path}.${node.cases.length}`) : [];
		return { kind: "switch", subject, cases, ...(fallback.length > 0 ? { default: fallback } : {}) };
	};

	const named = (node: { as?: { text: string; start: number; end: number } }, path: string): string | undefined => {
		const { as } = node;
		if (!as) return undefined;
		if (!PARAM_NAME_RE.test(as.text)) fail(as.start, as.end, "a name is lowercase letters, digits and _");
		places.push({ step: path, param: "as", start: as.start, end: as.end });
		return as.text;
	};

	const step = (node: ScriptNode, path: string): FunctionStep => {
		switch (node.kind) {
			case "note":
				if (node.text.length > STEP_TEXT_MAX) fail(node.start, node.end, tooLong);
				return { kind: "note", text: node.text };
			case "let": {
				const { name } = node;
				if (!PARAM_NAME_RE.test(name.text)) {
					fail(name.start, name.end, "a name is lowercase letters, digits and _");
				}
				if (called(node.value)) fail(node.start, node.end, "this action gives nothing to keep");
				places.push({ step: path, param: "name", start: name.start, end: name.end });
				const value = lift(node.value, { step: path, param: "value" }, VALUE);
				bindings.push({ name: name.text, start: node.end, end: source.length, value });
				return { kind: "let", name: name.text, value };
			}
			case "run":
				return doing(node, path);
			case "if":
				return branch(node, path);
			case "switch":
				return switched(node, path);
			case "try": {
				const steps = block(node.body.steps, `${path}.0`);
				bindings.push({ name: "e", start: node.handler.start, end: node.handler.end });
				return { kind: "try", steps, catch: block(node.handler.steps, `${path}.1`) };
			}
			case "parallel":
				return { kind: "parallel", steps: block(node.body.steps, `${path}.0`) };
			case "start": {
				const as = named(node, path);
				const steps = block(node.body.steps, `${path}.0`);
				if (as) bindings.push({ name: as, start: node.end, end: source.length, type: TASK });
				return { kind: "start", ...(as ? { as } : {}), steps };
			}
			case "await": {
				const as = named(node, path);
				const task = expression(node.task, { step: path, param: "task" });
				if (as) bindings.push({ name: as, start: node.end, end: source.length, type: TASK });
				return { kind: "await", task, ...(as ? { as } : {}) };
			}
			case "exit":
				return { kind: "exit" };
			case "throw": {
				if (!node.text) return { kind: "throw" };
				if (!quoted(node.text)) fail(node.text.start, node.text.end, "throw takes a text in quotes");
				return { kind: "throw", text: text(node.text, { step: path, param: "text" }) };
			}
			case "wait":
				return { kind: "wait", minutes: lift(node.minutes, { step: path, param: "minutes" }, VALUE) };
		}
	};

	function block(nodes: readonly ScriptNode[], prefix: string): FunctionStep[] {
		const steps: FunctionStep[] = [];
		for (const node of nodes) {
			const path = prefix === "" ? String(steps.length) : `${prefix}.${steps.length}`;
			try {
				const read = step(node, path);
				statements.push({ step: path, start: node.start, end: node.end });
				steps.push(read);
			} catch (error) {
				if (!(error instanceof Refused)) throw error;
				issues.push(error.issue);
			}
		}
		return steps;
	}

	const steps = block(tree.steps, "");
	if (issues.length > 0) {
		issues.sort((left, right) => left.start - right.start);
		return { issues: issues.slice(0, ISSUES_MAX), bindings, statements: [] };
	}
	const refused = (at: string, message: string): ScriptParse => {
		const where = statements.find((held) => held.step === at);
		const issue = { start: where?.start ?? 0, end: where?.end ?? source.length, message };
		return { issues: [issue], bindings, statements: [] };
	};
	const over = overBounds(steps);
	if (over) return refused(over.step, over.message);
	const bad = steps.findIndex((held) => !FunctionStepSchema.safeParse(held).success);
	if (bad >= 0) return refused(String(bad), "a step here cannot be kept");
	statements.sort((left, right) => left.start - right.start);
	bindings.sort((left, right) => left.start - right.start);
	return { steps, places, bindings, statements };
}

export function placeIssue(
	read: { places: readonly ScriptPlace[]; statements: readonly ScriptStatement[] },
	issue: { step: string; param?: string; start?: number; end?: number; case?: number; chip?: number },
): { start: number; end: number } | null {
	const param =
		issue.case !== undefined && issue.chip !== undefined ? casePlace(issue.case, issue.chip) : issue.param;
	const place = read.places.find((held) => held.step === issue.step && held.param === param);
	if (!place) {
		const whole = read.statements.find((held) => held.step === issue.step);
		return whole ? { start: whole.start, end: whole.end } : null;
	}
	if (issue.start === undefined || issue.end === undefined) return { start: place.start, end: place.end };
	// Offsets outside the value are held to it.
	const length = place.chars ? place.chars.length : place.end - place.start;
	const from = Math.min(issue.start, length);
	const to = Math.min(Math.max(issue.end, from), length);
	if (!place.chars) return { start: place.start + from, end: place.start + to };
	const start = place.chars[from]?.[0] ?? place.end;
	const end = to > from ? ((place.chars[to - 1]?.[1] ?? place.end) as number) : start;
	return { start, end };
}

////////////////////////////////
//  Scope

export interface ScriptNameRead {
	name: string;
	type: string;
	start: number;
	end: number;
}

/** Each name with its type and where it is offered; a name kept again ends its earlier reach. */
export function scriptNames(input: {
	length: number;
	bindings: readonly ScriptBinding[];
	given?: TriggerGiven;
	params?: readonly FunctionParam[];
	description: ConsoleDescription;
}): ScriptNameRead[] {
	const whole = { start: 0, end: input.length };
	const declared = (input.params ?? []).map((param) => ({
		name: param.name,
		type: PARAM_SCRIPT_TYPES[param.type],
		...whole,
	}));
	const given = (input.given?.names ?? [])
		.filter((held) => !declared.some((param) => param.name === held.name))
		.map((held) => ({ name: held.name, type: GIVEN_SCRIPT_TYPES[held.type], ...whole }));
	const names: ScriptNameRead[] = [...given, ...declared];
	const kept = new Map<string, ScriptNameRead>();
	for (const binding of [...input.bindings].sort((left, right) => left.start - right.start)) {
		if (binding.type) {
			const earlier = kept.get(binding.name);
			if (earlier) earlier.end = binding.start;
			const read = { name: binding.name, type: binding.type, start: binding.start, end: binding.end };
			kept.set(binding.name, read);
			names.push(read);
			continue;
		}
		if (!binding.value) {
			names.push({ name: binding.name, type: "Error", start: binding.start, end: binding.end });
			continue;
		}
		const { value } = binding;
		const seen = new Map(
			names
				.filter((held) => held.start <= binding.start && binding.start <= held.end)
				.map((held) => [held.name, held.type]),
		);
		const literal = value.kind === "literal" ? value.value : "";
		const type =
			value.kind === "expression"
				? typeOfNode(parseConsoleExpression(value.text).node, {
						names: seen,
						eventFields: input.given?.eventFields,
						description: input.description,
					})
				: typeof literal === "string"
					? "Text"
					: typeof literal === "number"
						? "Number"
						: "Truth";
		const earlier = kept.get(binding.name);
		if (earlier) earlier.end = binding.start;
		const read = { name: binding.name, type, start: binding.start, end: binding.end };
		kept.set(binding.name, read);
		names.push(read);
	}
	return names;
}
