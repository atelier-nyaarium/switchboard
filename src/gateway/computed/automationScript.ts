import type { TriggerGiven } from "../../shared/automation-fit.js";
import { type ConsoleToken, lexConsole, parseConsoleExpression } from "../../shared/live-console-grammar.js";
import {
	AUTOMATION_ACTIONS,
	type AutomationActionKind,
	type AutomationActionParam,
	type AutomationActionRow,
} from "../../shared/schemasAutomation.js";
import {
	FUNCTION_DEPTH_MAX,
	FUNCTION_PARAMS_MAX,
	FUNCTION_STEPS_MAX,
	FUNCTION_STEPS_TOTAL_MAX,
	type FunctionParam,
	type FunctionStep,
	FunctionStepSchema,
	PARAM_NAME_RE,
	STEP_TEXT_MAX,
	type StepArg,
} from "../../shared/schemasFunction.js";
import type { ConsoleDescription } from "../../shared/schemasLiveConsole.js";
import { opensStatement, SCRIPT_SOURCE_MAX, type ScriptPiece, scanScript } from "../../shared/script-scan.js";
import { GIVEN_SCRIPT_TYPES, PARAM_SCRIPT_TYPES, typeOfNode } from "../../shared/script-types.js";
import { scanHoles } from "../../shared/text-holes.js";
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
const CALL = AUTOMATION_ACTIONS.run_function.call;
export const SCRIPT_UNWRITABLE = "it holds a step a script cannot write";
export const SCRIPT_UNREADABLE = "its text would not read back as the same steps";
export const SCRIPT_TOO_LONG = `it is longer than ${SCRIPT_SOURCE_MAX} characters as text`;

////////////////////////////////
//  Text and number encoding

/** A run's lone backslash doubled; `\{`, `\}` and `\\` kept. */
function canonicalRun(run: string): string {
	let out = "";
	for (let at = 0; at < run.length; at++) {
		const c = run[at] as string;
		if (c !== "\\") {
			out += c;
			continue;
		}
		const next = run[at + 1];
		if (next === "{" || next === "}" || next === "\\") {
			out += c + next;
			at++;
		} else out += "\\\\";
	}
	return out;
}

/** A text's parts as written: a hole is an expression, never touched. */
const partsOf = (text: string) =>
	scanHoles(text).map((part) => ({ hole: part.kind === "hole", raw: text.slice(part.start, part.end) }));

/** A plain string as a text that fills nothing. */
const unfilled = (value: string): string => value.replace(/[\\{}]/g, (c) => `\\${c}`);

const QUOTED: Readonly<Record<string, string>> = { '"': '\\"', "\n": "\\n", "\t": "\\t", "\r": "\\r" };

/** Inside a hole a backslash is written twice, so its expression reads back as it was. */
function printText(text: string): string {
	const body = partsOf(text).map((part) =>
		part.hole
			? part.raw.replace(/[\\"\n\t\r]/g, (c) => QUOTED[c] ?? "\\\\")
			: canonicalRun(part.raw).replace(/["\n\t\r]/g, (c) => QUOTED[c] as string),
	);
	return `"${body.join("")}"`;
}

/** A string that is no text: a name, an id, a choice. */
const printPlain = (value: string): string => `"${value.replace(/[\\"\n\t]/g, (c) => QUOTED[c] ?? `\\${c}`)}"`;

const UNQUOTED: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", '"': '"', "'": "'" };

/** Each character's own span in the script. */
type Chars = (readonly [number, number])[];

/** A closed string token's text, and where each of its characters came from. Mirrors `scanHoles`. */
function readText(raw: string, offset: number): { text: string; chars: Chars } {
	const body = raw.slice(1, -1);
	let text = "";
	const chars: Chars = [];
	/** Open braces of the hole being read; a quote hides braces. */
	let depth = 0;
	let quote: string | null = null;
	let escaped = false;
	const feed = (c: string): void => {
		if (quote !== null) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === quote) quote = null;
			return;
		}
		if (c === '"' || c === "'") quote = c;
		else if (c === "{") depth++;
		else if (c === "}") depth--;
	};
	const put = (piece: string, at: number, width: number) => {
		text += piece;
		for (let n = 0; n < piece.length; n++) chars.push([offset + 1 + at, offset + 1 + at + width]);
		if (depth > 0) for (const c of piece) feed(c);
	};
	for (let at = 0; at < body.length; at++) {
		const c = body[at] as string;
		const next = body[at + 1];
		const plain = next === undefined ? undefined : UNQUOTED[next];
		if (c !== "\\") {
			const opens = depth === 0 && c === "{";
			put(c, at, 1);
			if (opens) depth = 1;
			continue;
		}
		if (depth > 0) {
			// In a hole `\\\\` is one backslash; any other pair is as written.
			if (next === undefined) put(c, at, 1);
			else put(plain ?? (next === "\\" ? c : c + next), at, 2);
		} else if (next === undefined) put("\\\\", at, 1);
		else if (plain !== undefined) put(plain, at, 2);
		else if (next === "{" || next === "}" || next === "\\") put(c + next, at, 2);
		// An unknown escape is a backslash and its letter.
		else put(`\\\\${next}`, at, 2);
		if (next !== undefined) at++;
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

/** Line breaks out of an expression, a space for each character; a string keeps its own as `\n`. */
export function canonicalExpression(source: string): string {
	const strings = lexConsole(source).filter((token) => token.kind === "string");
	let out = "";
	let at = 0;
	const plain = (to: number) => {
		out += source.slice(at, to).replace(/[\r\n]/g, " ");
		at = to;
	};
	for (const token of strings) {
		plain(token.start);
		out += source.slice(token.start, token.end).replace(/\n/g, "\\n");
		at = token.end;
	}
	plain(source.length);
	return out.trim();
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

/** How a string reads where it sits. */
type Position =
	/** An action's text: its literal fills. */
	| { reads: "text" }
	/** As written; `held` names an id. */
	| { reads: "plain"; held?: readonly { id: string; name: string }[]; what?: string }
	/** A kept or given value: a literal as written, a text filled. */
	| { reads: "value" };

const VALUE: Position = { reads: "value" };

/** A name the expression grammar reads as a name. */
const bare = (name: string): boolean => {
	const tokens = lexConsole(name);
	return tokens.length === 1 && tokens[0]?.kind === "ident";
};

const plugs = (tables: ScriptTables): Position => ({ reads: "plain", held: tables.switches, what: "plug" });

const positionOf = (param: AutomationActionParam, tables: ScriptTables): Position =>
	param.kind === "text" ? { reads: "text" } : param.kind === "switch" ? plugs(tables) : { reads: "plain" };

/** A text holds a hole or an escape. */
const fills = (text: string): boolean => /[{}\\]/.test(text);

/** An expression a bare literal would be read for. */
const literalLike = (tokens: readonly ConsoleToken[]): boolean => {
	const [first, second] = tokens;
	if (tokens.length === 2) return first?.kind === "op" && first.text === "-" && second?.kind === "number";
	return tokens.length === 1 && (first?.kind === "string" || first?.kind === "number" || first?.kind === "keyword");
};

/** Prints steps as script; `readOnly` when parsing it back would lose a step. */
export interface ScriptPrint extends ScriptRead {
	text: string;
	readOnly?: string;
}

export function printScript(steps: readonly FunctionStep[], tables: ScriptTables): ScriptPrint {
	let unwritable = false;
	const lines: string[] = [];

	/** `absent`: a bare null here is a value left out. */
	const value = (arg: StepArg, at: Position, absent = false): string => {
		if (arg.kind === "expression") {
			const source = canonicalExpression(arg.text);
			const tokens = lexConsole(source);
			const bareNull = tokens.length === 1 && tokens[0]?.kind === "keyword" && tokens[0].text === "null";
			// Parentheses keep it an expression.
			return literalLike(tokens) && (!bareNull || absent) ? `(${source})` : source;
		}
		if (arg.kind === "text") {
			// Only a kept or given value holds one.
			unwritable ||= at.reads !== "value";
			return printText(arg.text);
		}
		if (typeof arg.value === "number") return printNumber(arg.value);
		if (typeof arg.value === "boolean") return String(arg.value);
		if (at.reads === "plain") return printPlain(at.held ? nameFor(arg.value, at.held) : arg.value);
		return printText(at.reads === "text" ? arg.value : unfilled(arg.value));
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
			const key = bare(name) ? name : printPlain(name);
			return `${key}: ${value(step.values?.[name] as StepArg, device ? plugs(tables) : VALUE)}`;
		});
		const values = entries.length > 0 ? `, {${entries.join(", ")}}` : "";
		return `${CALL.entity}.${CALL.method}(${printPlain(nameFor(step.function, tables.functions))}${values})`;
	};

	/** Lines a step spans; `skip` past what belongs to the step before. */
	const spans: { step: string; first: number; last: number; skip: number }[] = [];
	const bound: { name: string; from: number; to: number | null; value?: StepArg }[] = [];

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
					unwritable ||= opensStatement(step.name) || !bare(step.name);
					lines.push(`${indent}${step.name} = ${value(step.value, VALUE)}`);
					bound.push({ name: step.name, from: first, to: null, value: step.value });
					break;
				case "exit":
					lines.push(`${indent}exit`);
					break;
				case "throw":
					lines.push(`${indent}throw${step.text === undefined ? "" : ` ${printText(step.text)}`}`);
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
			({ name, from, to, value: kept }): ScriptBinding =>
				to === null
					? { name, start: endOf(from), end: text.length, value: kept }
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

const isPunct = (token: ConsoleToken | undefined, text: string) => token?.kind === "punct" && token.text === text;
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

function closing(tokens: readonly ConsoleToken[], open: number): number {
	let depth = 0;
	for (let at = open; at < tokens.length; at++) {
		const token = tokens[at] as ConsoleToken;
		if (token.kind !== "punct") continue;
		if (OPENERS.has(token.text)) depth++;
		else if (CLOSERS.has(token.text) && --depth === 0) return at;
	}
	return -1;
}

/** A trailing comma is allowed. */
function splitTop(tokens: readonly ConsoleToken[], from: number, to: number): [number, number][] {
	const ranges: [number, number][] = [];
	let depth = 0;
	let start = from;
	for (let at = from; at < to; at++) {
		const token = tokens[at] as ConsoleToken;
		if (token.kind !== "punct") continue;
		if (OPENERS.has(token.text)) depth++;
		else if (CLOSERS.has(token.text)) depth--;
		else if (token.text === "," && depth === 0) {
			ranges.push([start, at]);
			start = at + 1;
		}
	}
	if (start < to) ranges.push([start, to]);
	return ranges;
}

function overBounds(steps: readonly FunctionStep[]): { step: string; message: string } | null {
	let total = 0;
	const walk = (list: readonly FunctionStep[], prefix: string, depth: number): ReturnType<typeof overBounds> => {
		for (const [index, step] of list.entries()) {
			const path = `${prefix}${index}`;
			if (index >= FUNCTION_STEPS_MAX)
				return { step: path, message: `more than ${FUNCTION_STEPS_MAX} steps in one block` };
			if (++total > FUNCTION_STEPS_TOTAL_MAX)
				return { step: path, message: `more than ${FUNCTION_STEPS_TOTAL_MAX} steps` };
			if (depth > FUNCTION_DEPTH_MAX)
				return { step: path, message: `blocks nest more than ${FUNCTION_DEPTH_MAX} deep` };
			const sides =
				step.kind === "if"
					? [step.steps ?? [], step.else ?? []]
					: step.kind === "try"
						? [step.steps, step.catch]
						: [];
			for (const [side, inner] of sides.entries()) {
				const found = walk(inner, `${path}.${side}.`, depth + 1);
				if (found) return found;
			}
		}
		return null;
	};
	return walk(steps, "", 1);
}

export function parseScript(source: string, tables: ScriptTables): ScriptParse {
	const bindings: ScriptBinding[] = [];
	const statements: ScriptStatement[] = [];
	if (source.length > SCRIPT_SOURCE_MAX) {
		const message = `longer than ${SCRIPT_SOURCE_MAX} characters`;
		return { issues: [{ start: 0, end: source.length, message }], bindings, statements };
	}
	const pieces = scanScript(source);
	const issues: ScriptIssue[] = [];
	const places: ScriptPlace[] = [];
	let at = 0;
	const tooLong = `longer than ${STEP_TEXT_MAX} characters`;

	const fail = (start: number, end: number, message: string): never => {
		throw new Refused({ start, end, message });
	};
	const textOf = (piece: ScriptPiece) => source.slice(piece.start, piece.end);
	const sameLine = (before: ScriptPiece, after: ScriptPiece) => !source.slice(before.end, after.start).includes("\n");
	const next = (kind: ScriptPiece["kind"]): ScriptPiece | undefined =>
		pieces[at]?.kind === kind ? pieces[at] : undefined;
	const expect = (kind: "open" | "close", after: ScriptPiece, what: string): ScriptPiece => {
		const piece = next(kind);
		if (!piece) fail(after.start, after.end, what);
		at++;
		return piece as ScriptPiece;
	};

	/** A statement's code, refusing a comment cut into it. */
	const codeAfter = (lead: ScriptPiece): ScriptPiece | null => {
		const piece = next("code");
		if (!piece || !sameLine(lead, piece)) return null;
		at++;
		const comment = pieces[at];
		if (comment?.kind === "comment" && pieces[at + 1]?.joins) {
			fail(comment.start, comment.end, "a comment here would be lost; put it on its own line");
		}
		return piece;
	};

	const lift = (
		tokens: readonly ConsoleToken[],
		from: number,
		to: number,
		offset: number,
		code: string,
		place: { step: string; param: string },
		at: Position,
	): StepArg => {
		const first = tokens[from] as ConsoleToken;
		const last = tokens[to - 1] as ConsoleToken;
		const start = offset + first.start;
		const end = offset + last.end;
		if (to - from === 1 && first.kind === "string") {
			if (!first.closed) fail(start, end, "missing closing quote");
			const read = at.reads === "plain" ? { text: first.value ?? "" } : readText(first.text, start);
			if (read.text.length > STEP_TEXT_MAX) fail(start, end, tooLong);
			places.push({ ...place, start, end, ...("chars" in read ? { chars: read.chars } : {}) });
			if (at.reads === "value" && fills(read.text)) return { kind: "text", text: read.text };
			if (at.reads !== "plain" || !at.held) return { kind: "literal", value: read.text };
			const id = idFor(read.text, at.held);
			if (id === null) fail(start, end, `two ${at.what}s are named ${read.text}; write its id`);
			return { kind: "literal", value: id as string };
		}
		places.push({ ...place, start, end });
		const number = (value: number): StepArg =>
			Number.isFinite(value) ? { kind: "literal", value } : fail(start, end, "a number too large");
		if (to - from === 1 && first.kind === "number") return number(Number(first.text));
		if (to - from === 1 && first.kind === "keyword" && first.text !== "null") {
			return { kind: "literal", value: first.text === "true" };
		}
		if (to - from === 2 && first.kind === "op" && first.text === "-" && last.kind === "number") {
			return number(-Number(last.text));
		}
		const text = code.slice(first.start, last.end);
		const parsed = parseConsoleExpression(text);
		const [issue] = parsed.issues;
		if (issue) fail(start + issue.start, start + Math.max(issue.end, issue.start + 1), issue.message);
		const written = canonicalExpression(text);
		if (written.length > STEP_TEXT_MAX) fail(start, end, tooLong);
		return { kind: "expression", text: written };
	};

	const inParens = (piece: ScriptPiece, what: string): { tokens: ConsoleToken[]; code: string } => {
		const code = textOf(piece);
		const tokens = lexConsole(code);
		if (!isPunct(tokens[0], "(") || closing(tokens, 0) !== tokens.length - 1) {
			fail(piece.start, piece.end, what);
		}
		if (tokens.length === 2) fail(piece.start, piece.end, what);
		return { tokens, code };
	};

	const doing = (
		action: AutomationActionKind,
		tokens: readonly ConsoleToken[],
		piece: ScriptPiece,
		code: string,
		path: string,
	): FunctionStep => {
		const row = AUTOMATION_ACTIONS[action];
		const ranges = splitTop(tokens, 4, tokens.length - 1);
		if (ranges.length > row.params.length) {
			fail(
				piece.start,
				piece.end,
				`${row.call.entity}.${row.call.method} takes at most ${row.params.length} values`,
			);
		}
		const absent = ([from, to]: [number, number]) =>
			to - from === 1 && tokens[from]?.kind === "keyword" && tokens[from]?.text === "null";
		if (action !== "run_function") {
			const args: Record<string, StepArg> = {};
			for (const [index, range] of ranges.entries()) {
				const param = row.params[index] as AutomationActionParam;
				if (absent(range)) continue;
				const place = { step: path, param: param.name };
				args[param.name] = lift(
					tokens,
					range[0],
					range[1],
					piece.start,
					code,
					place,
					positionOf(param, tables),
				);
			}
			return { kind: "do", action, args };
		}
		const [target, record] = ranges;
		const name = target ? (tokens[target[0]] as ConsoleToken) : undefined;
		if (!target || !name || target[1] - target[0] !== 1 || name.kind !== "string" || !name.closed) {
			return fail(piece.start, piece.end, "name the function to run, in quotes");
		}
		const written = name.value ?? "";
		const id = idFor(written, tables.functions);
		if (id === null)
			fail(piece.start + name.start, piece.start + name.end, `two functions are named ${written}; write its id`);
		const callee = tables.functions.find((entry) => entry.id === id);
		if (!callee) fail(piece.start + name.start, piece.start + name.end, `no function is named ${written}`);
		const values: Record<string, StepArg> = {};
		if (record && !absent(record)) {
			const [from, to] = record;
			if (!isPunct(tokens[from], "{") || closing(tokens, from) !== to - 1) {
				fail(
					piece.start + (tokens[from] as ConsoleToken).start,
					piece.end,
					"its values are written {name: value}",
				);
			}
			for (const [start, end] of splitTop(tokens, from + 1, to - 1)) {
				const key = tokens[start] as ConsoleToken;
				const keyed = (key.kind === "ident" || key.kind === "string") && isPunct(tokens[start + 1], ":");
				const param = key.kind === "string" ? (key.value ?? "") : key.text;
				if (!keyed || !PARAM_NAME_RE.test(param) || end - start < 3) {
					fail(
						piece.start + key.start,
						piece.start + (tokens[end - 1] as ConsoleToken).end,
						"write a value as name: value",
					);
				}
				if (Object.hasOwn(values, param)) {
					fail(piece.start + key.start, piece.start + key.end, `${param} is given twice`);
				}
				if (Object.keys(values).length >= FUNCTION_PARAMS_MAX) {
					fail(piece.start + key.start, piece.start + key.end, `more than ${FUNCTION_PARAMS_MAX} values`);
				}
				const declared = callee?.params.find((held) => held.name === param);
				if (callee && !declared) fail(piece.start + key.start, piece.start + key.end, `it takes no ${param}`);
				const device = declared?.type === "device";
				const at = device ? plugs(tables) : VALUE;
				values[param] = lift(tokens, start + 2, end, piece.start, code, { step: path, param }, at);
			}
		}
		// Declared order, then the rest by name.
		const order = [...(callee?.params ?? []).map((held) => held.name), ...Object.keys(values).sort()];
		const sorted = Object.fromEntries(
			order.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key] as StepArg]),
		);
		return { kind: "call", function: id as string, ...(Object.keys(sorted).length > 0 ? { values: sorted } : {}) };
	};

	const plain = (piece: ScriptPiece, path: string): FunctionStep => {
		at++;
		const comment = pieces[at];
		if (comment?.kind === "comment" && pieces[at + 1]?.joins) {
			fail(comment.start, comment.end, "a comment here would be lost; put it on its own line");
		}
		const code = textOf(piece);
		const tokens = lexConsole(code);
		const [first, second, third, fourth] = tokens;
		const called = (from: number): AutomationActionKind | null => {
			const [entity, dot, method, paren] = tokens.slice(from, from + 4);
			if (entity?.kind !== "ident" || !isPunct(dot, ".") || method?.kind !== "ident" || !isPunct(paren, "(")) {
				return null;
			}
			return closing(tokens, from + 3) === tokens.length - 1 ? doingAction(entity.text, method.text) : null;
		};
		if (first?.kind === "ident" && second?.kind === "op" && second.text === "=") {
			if (!PARAM_NAME_RE.test(first.text)) {
				fail(piece.start + first.start, piece.start + first.end, "a name is lowercase letters, digits and _");
			}
			if (tokens.length === 2) fail(piece.start, piece.end, "a value is missing");
			if (called(2)) fail(piece.start, piece.end, "this action gives nothing to keep");
			places.push({ step: path, param: "name", start: piece.start + first.start, end: piece.start + first.end });
			const value = lift(tokens, 2, tokens.length, piece.start, code, { step: path, param: "value" }, VALUE);
			bindings.push({ name: first.text, start: piece.end, end: source.length, value });
			return { kind: "let", name: first.text, value };
		}
		const action = first && third && fourth ? called(0) : null;
		if (!action) return fail(piece.start, piece.end, "it does nothing: keep it under a name, or call an action");
		return doing(action, tokens, piece, code, path);
	};

	const condition = (word: ScriptPiece, path: string): string => {
		const piece = codeAfter(word) ?? fail(word.start, word.end, "a condition is missing: if (condition) {");
		const { tokens, code } = inParens(piece, "write the condition in ( )");
		const first = tokens[1] as ConsoleToken;
		const last = tokens[tokens.length - 2] as ConsoleToken;
		const text = code.slice(first.start, last.end);
		const [issue] = parseConsoleExpression(text).issues;
		const start = piece.start + first.start;
		if (issue) fail(start + issue.start, start + Math.max(issue.end, issue.start + 1), issue.message);
		const written = canonicalExpression(text);
		if (written.length > STEP_TEXT_MAX) fail(start, piece.start + last.end, tooLong);
		places.push({ step: path, param: "when", start, end: piece.start + last.end });
		return written;
	};

	const braced = (after: ScriptPiece, path: string, side: number, binds?: string): FunctionStep[] => {
		const open = expect("open", after, "a { is missing");
		const steps = block(`${path}.${side}`);
		const close = pieces[at];
		const closed = close?.kind === "close";
		if (binds) bindings.push({ name: binds, start: open.start, end: closed ? close.end : source.length });
		if (!closed) fail(after.start, after.end, "its } is missing");
		at++;
		return steps;
	};

	const branch = (word: ScriptPiece, path: string): FunctionStep => {
		const when = condition(word, path);
		const steps = braced(word, path, 0);
		const other = next("word");
		let otherwise: FunctionStep[] = [];
		if (other && textOf(other) === "else") {
			at++;
			const again = next("word");
			if (again && textOf(again) === "if") {
				at++;
				otherwise = [branch(again, `${path}.1.0`)];
				statements.push({ step: `${path}.1.0`, start: again.start, end: (pieces[at - 1] as ScriptPiece).end });
			} else otherwise = braced(other, path, 1);
		}
		return {
			kind: "if",
			when,
			...(steps.length > 0 ? { steps } : {}),
			...(otherwise.length > 0 ? { else: otherwise } : {}),
		};
	};

	const worded = (word: ScriptPiece, path: string): FunctionStep => {
		at++;
		const name = textOf(word);
		switch (name) {
			case "if":
				return branch(word, path);
			case "try": {
				const steps = braced(word, path, 0);
				const caught = next("word");
				if (!caught || textOf(caught) !== "catch")
					return fail(word.start, word.end, "a try needs its catch (e) { }");
				at++;
				const binding = codeAfter(caught);
				if (!binding || textOf(binding).replace(/\s/g, "") !== "(e)") {
					fail(caught.start, binding?.end ?? caught.end, "write catch (e)");
				}
				return { kind: "try", steps, catch: braced(caught, path, 1, "e") };
			}
			case "exit": {
				const extra = codeAfter(word);
				if (extra) fail(extra.start, extra.end, "exit stands alone");
				return { kind: "exit" };
			}
			case "throw": {
				const said = codeAfter(word);
				if (!said) return { kind: "throw" };
				const tokens = lexConsole(textOf(said));
				const [only] = tokens;
				if (tokens.length !== 1 || only?.kind !== "string" || !only.closed) {
					return fail(said.start, said.end, "throw takes a text in quotes");
				}
				const read = readText(only.text, said.start + only.start);
				if (read.text.length > STEP_TEXT_MAX) fail(said.start, said.end, tooLong);
				places.push({ step: path, param: "text", start: said.start, end: said.end, chars: read.chars });
				return { kind: "throw", text: read.text };
			}
			case "wait": {
				const piece = codeAfter(word) ?? fail(word.start, word.end, "write wait(minutes)");
				const { tokens, code } = inParens(piece, "write wait(minutes)");
				const place = { step: path, param: "minutes" };
				return { kind: "wait", minutes: lift(tokens, 1, tokens.length - 1, piece.start, code, place, VALUE) };
			}
			case "else":
				return fail(word.start, word.end, "an else follows an if's }");
			case "catch":
				return fail(word.start, word.end, "a catch follows a try's }");
			default:
				return fail(word.start, word.end, `${name} is not in the language yet`);
		}
	};

	const noted = (comment: ScriptPiece): string => {
		const line = textOf(comment).slice(2);
		return line.startsWith(" ") ? line.slice(1) : line;
	};

	/** Comment lines that follow one another are one note. */
	const note = (path: string): FunctionStep => {
		const first = pieces[at] as ScriptPiece;
		const lines: string[] = [];
		let last = first;
		while (pieces[at]?.kind === "comment") {
			const piece = pieces[at] as ScriptPiece;
			const between = source.slice(last.end, piece.start);
			if (piece !== first && (between.split("\n").length !== 2 || between.trim() !== "")) break;
			lines.push(noted(piece));
			last = piece;
			at++;
		}
		const text = lines.join("\n");
		if (text.length > STEP_TEXT_MAX) fail(first.start, last.end, tooLong);
		statements.push({ step: path, start: first.start, end: last.end });
		return { kind: "note", text };
	};

	function block(prefix: string): FunctionStep[] {
		const steps: FunctionStep[] = [];
		const path = () => (prefix === "" ? String(steps.length) : `${prefix}.${steps.length}`);
		while (at < pieces.length) {
			const piece = pieces[at] as ScriptPiece;
			if (piece.kind === "close") break;
			const began = at;
			try {
				if (piece.kind === "comment") {
					steps.push(note(path()));
					continue;
				}
				if (piece.kind === "open") fail(piece.start, piece.end, "a { opens nothing here");
				const own = path();
				const placed = places.length;
				const step = piece.kind === "word" ? worded(piece, own) : plain(piece, own);
				const last = pieces[at - 1] as ScriptPiece;
				const trailing = pieces[at];
				const simple = step.kind !== "if" && step.kind !== "try";
				// A comment after a statement is a note before it.
				if (simple && trailing?.kind === "comment" && sameLine(last, trailing)) {
					at++;
					statements.push({ step: own, start: trailing.start, end: trailing.end });
					steps.push({ kind: "note", text: noted(trailing) });
					// Its places move with it.
					for (const place of places.slice(placed)) place.step = path() + place.step.slice(own.length);
				}
				statements.push({ step: path(), start: piece.start, end: last.end });
				steps.push(step);
			} catch (error) {
				if (!(error instanceof Refused)) throw error;
				if (issues.length < ISSUES_MAX) issues.push(error.issue);
				// Carry on at the next line, past a block the refused line opened.
				const line = source.indexOf("\n", error.issue.start);
				const resume = line < 0 ? source.length : line;
				let depth = 0;
				while (at < pieces.length && ((pieces[at] as ScriptPiece).start < resume || depth > 0)) {
					const kind = (pieces[at] as ScriptPiece).kind;
					if (kind === "open") depth++;
					else if (kind === "close" && depth > 0) depth--;
					else if (kind === "close") break;
					at++;
				}
				// The rest of a statement a comment cut.
				while (pieces[at]?.joins) at++;
				if (at === began) at++;
			}
		}
		return steps;
	}

	const steps = block("");
	while (at < pieces.length) {
		const stray = pieces[at] as ScriptPiece;
		if (issues.length < ISSUES_MAX) {
			issues.push({ start: stray.start, end: stray.end, message: "a } closes nothing here" });
		}
		at++;
		block("");
	}
	if (issues.length > 0) return { issues, bindings, statements: [] };
	const refused = (step: string, message: string): ScriptParse => {
		const where = statements.find((held) => held.step === step);
		const issue = { start: where?.start ?? 0, end: where?.end ?? source.length, message };
		return { issues: [issue], bindings, statements: [] };
	};
	const over = overBounds(steps);
	if (over) return refused(over.step, over.message);
	const bad = steps.findIndex((step) => !FunctionStepSchema.safeParse(step).success);
	if (bad >= 0) return refused(String(bad), "a step here cannot be kept");
	statements.sort((left, right) => left.start - right.start);
	bindings.sort((left, right) => left.start - right.start);
	return { steps, places, bindings, statements };
}

export function placeIssue(
	read: { places: readonly ScriptPlace[]; statements: readonly ScriptStatement[] },
	issue: { step: string; param?: string; start?: number; end?: number },
): { start: number; end: number } | null {
	const place = read.places.find((held) => held.step === issue.step && held.param === issue.param);
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
