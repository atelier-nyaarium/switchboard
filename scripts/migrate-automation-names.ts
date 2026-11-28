// One-off: stored automations to the 2.7i names, and their run state reset.
//
//   bun scripts/migrate-automation-names.ts <data dir>           dry run: prints each change
//   bun scripts/migrate-automation-names.ts <data dir> --apply   writes, after a .pre-2.7i copy beside each file
//
// Run with the Gateway stopped.

import fs from "node:fs";
import path from "node:path";
import type { AutomationStoreName } from "../src/gateway/compose/composeAutomations.js";
import { AUTOMATION_KIND, FUNCTION_KIND } from "../src/gateway/computed/automationJudge.js";
import { restore, storedOf } from "../src/gateway/computed/automationState.js";
import { writeFileAtomic } from "../src/shared/atomic-write.js";
import { type ConsoleNode, parseConsoleExpression, parseConsoleText } from "../src/shared/live-console-grammar.js";
import { AUTOMATION_ACTIONS, AutomationSchema } from "../src/shared/schemasAutomation.js";
import { FunctionSchema } from "../src/shared/schemasFunction.js";

type Json = Record<string, unknown>;
type Note = (change: string, where: string) => void;

const RECORDS: AutomationStoreName = "automations";
const STATE: AutomationStoreName = "automation-state";
const BACKUP = ".pre-2.7i";
const STEP_KINDS: Readonly<Record<string, string>> = {
	do: "action",
	let: "variable",
	exit: "return",
	note: "comment",
	call: "run_function",
};
const SIDES = ["steps", "else", "catch", "default"] as const;
/** The crossing's name for its reading. */
const OLD_READING = "value";
const NEW_READING = "reading";

class Refusal extends Error {}

const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const fileOf = (dir: string, name: AutomationStoreName): string => path.join(dir, `${name}.json`);

/** Key order kept. */
function renamed(held: Json, owner: string, [from, to]: [string, string], where: string, note: Note): Json {
	if (!Object.hasOwn(held, from)) return held;
	if (Object.hasOwn(held, to)) throw new Refusal(`${where} holds both ${from} and ${to}`);
	note(`${owner} ${from} -> ${to}`, where);
	return Object.fromEntries(Object.entries(held).map(([key, value]) => [key === from ? to : key, value]));
}

function stepRenamed(raw: unknown, where: string, note: Note): unknown {
	if (!isJson(raw)) return raw;
	let step: Json = { ...raw };
	const kind = step.kind;
	if (typeof kind === "string" && Object.hasOwn(STEP_KINDS, kind)) {
		step.kind = STEP_KINDS[kind];
		note(`step ${kind} -> ${step.kind}`, where);
	}
	if (step.kind === "if") step = renamed(step, "if step", ["when", "condition"], where, note);
	if (step.kind === "run_function") step = renamed(step, "run_function step", ["values", "args"], where, note);
	for (const side of SIDES) {
		const list = step[side];
		if (Array.isArray(list))
			step[side] = list.map((inner, at) => stepRenamed(inner, `${where}.${side}[${at}]`, note));
	}
	if (Array.isArray(step.cases))
		step.cases = step.cases.map((held, at) =>
			isJson(held) && Array.isArray(held.steps)
				? {
						...held,
						steps: held.steps.map((inner, index) =>
							stepRenamed(inner, `${where}.cases[${at}].steps[${index}]`, note),
						),
					}
				: held,
		);
	return step;
}

function automationRenamed(raw: Json, note: Note): Json {
	let body = renamed(raw, "automation", ["keepTryingMin", "retryForMin"], "", note);
	const trigger = body.trigger;
	if (isJson(trigger) && Array.isArray(trigger.conditions))
		body = {
			...body,
			trigger: {
				...trigger,
				conditions: trigger.conditions.map((held, at) =>
					isJson(held)
						? renamed(held, "condition", ["test", "operator"], `trigger.conditions[${at}]`, note)
						: held,
				),
			},
		};
	if (Array.isArray(body.actions))
		body = {
			...body,
			actions: body.actions.map((held, at) =>
				isJson(held) && held.kind === "run_function"
					? renamed(held, "run_function action", ["values", "args"], `actions[${at}]`, note)
					: held,
			),
		};
	return body;
}

function functionRenamed(raw: Json, note: Note): Json {
	if (!Array.isArray(raw.steps)) return raw;
	return { ...raw, steps: raw.steps.map((step, at) => stepRenamed(step, `steps[${at}]`, note)) };
}

////////////////////////////////
//  The crossing's reading

function identSpans(node: ConsoleNode | null, into: ConsoleNode[]): void {
	if (!node) return;
	switch (node.kind) {
		case "ident":
			if (node.name === OLD_READING) into.push(node);
			return;
		case "literal":
			return;
		case "template":
			for (const piece of node.pieces) if (piece.kind === "placeholder") identSpans(piece.node, into);
			return;
		case "member":
			identSpans(node.target, into);
			return;
		case "call":
			identSpans(node.target, into);
			for (const arg of node.args) identSpans(arg, into);
			return;
		case "index":
			identSpans(node.target, into);
			identSpans(node.index, into);
			return;
		case "unary":
			identSpans(node.operand, into);
			return;
		case "binary":
			identSpans(node.left, into);
			identSpans(node.right, into);
			return;
		case "list":
			for (const item of node.items) identSpans(item, into);
			return;
		case "dict":
			for (const entry of node.entries) identSpans(entry.value, into);
			return;
	}
}

/** Root names only; a member or key keeps its name. */
function readingIn(source: string, form: "text" | "expression", where: string, note: Note): string {
	if (!source.includes(OLD_READING)) return source;
	const parsed = form === "text" ? parseConsoleText(source) : parseConsoleExpression(source);
	if (parsed.issues.length > 0) throw new Refusal(`${where} does not parse; rename ${OLD_READING} by hand`);
	const spans: ConsoleNode[] = [];
	identSpans(parsed.node, spans);
	let out = source;
	for (const span of spans.sort((a, b) => b.start - a.start)) {
		if (out.slice(span.start, span.end) !== OLD_READING) throw new Refusal(`${where} names its reading oddly`);
		out = `${out.slice(0, span.start)}${NEW_READING}${out.slice(span.end)}`;
		note(`crossing name ${OLD_READING} -> ${NEW_READING}`, where);
	}
	return out;
}

const textParams = (action: unknown): ReadonlySet<string> =>
	typeof action === "string" && Object.hasOwn(AUTOMATION_ACTIONS, action)
		? new Set(
				AUTOMATION_ACTIONS[action as keyof typeof AUTOMATION_ACTIONS].params
					.filter((param) => param.kind === "text")
					.map((param) => param.name),
			)
		: new Set();

/** A step arg: a text only for an action's text parameter. */
function argReading(raw: unknown, isText: boolean, where: string, note: Note): unknown {
	if (!isJson(raw)) return raw;
	if (raw.kind === "expression" && typeof raw.text === "string")
		return { ...raw, text: readingIn(raw.text, "expression", where, note) };
	if (raw.kind === "literal" && isText && typeof raw.value === "string")
		return { ...raw, value: readingIn(raw.value, "text", where, note) };
	return raw;
}

const EXPRESSION_FIELDS = ["condition", "subject", "task"] as const;

function stepReading(raw: unknown, where: string, note: Note): unknown {
	if (!isJson(raw)) return raw;
	const step: Json = { ...raw };
	for (const field of EXPRESSION_FIELDS)
		if (typeof step[field] === "string")
			step[field] = readingIn(step[field] as string, "expression", `${where}.${field}`, note);
	if (step.kind === "throw" && typeof step.text === "string")
		step.text = readingIn(step.text, "text", `${where}.text`, note);
	if (step.kind === "variable") step.value = argReading(step.value, false, `${where}.value`, note);
	if (step.kind === "wait") step.minutes = argReading(step.minutes, false, `${where}.minutes`, note);
	if ((step.kind === "action" || step.kind === "run_function") && isJson(step.args)) {
		const texts = step.kind === "action" ? textParams(step.action) : new Set<string>();
		step.args = Object.fromEntries(
			Object.entries(step.args).map(([name, arg]) => [
				name,
				argReading(arg, texts.has(name), `${where}.args.${name}`, note),
			]),
		);
	}
	for (const side of SIDES) {
		const list = step[side];
		if (Array.isArray(list))
			step[side] = list.map((inner, at) => stepReading(inner, `${where}.${side}[${at}]`, note));
	}
	if (Array.isArray(step.cases))
		step.cases = step.cases.map((held, at) =>
			isJson(held) && Array.isArray(held.steps)
				? {
						...held,
						steps: held.steps.map((inner, index) =>
							stepReading(inner, `${where}.cases[${at}].steps[${index}]`, note),
						),
					}
				: held,
		);
	return step;
}

/** Every step at every depth. */
function eachStep(steps: unknown, visit: (step: Json) => void): void {
	if (!Array.isArray(steps)) return;
	for (const step of steps) {
		if (!isJson(step)) continue;
		visit(step);
		for (const side of SIDES) eachStep(step[side], visit);
		if (Array.isArray(step.cases)) for (const held of step.cases) if (isJson(held)) eachStep(held.steps, visit);
	}
}

/** A parameter or a variable of that name holds it there. */
function localReading(fn: Json): boolean {
	const params = Array.isArray(fn.params) ? fn.params : [];
	if (params.some((param) => isJson(param) && param.name === OLD_READING)) return true;
	let held = false;
	eachStep(fn.steps, (step) => {
		if (step.as === OLD_READING || (step.kind === "variable" && step.name === OLD_READING)) held = true;
	});
	return held;
}

function functionsRun(fn: Json): string[] {
	const ids: string[] = [];
	eachStep(fn.steps, (step) => {
		if (step.kind === "run_function" && typeof step.function === "string") ids.push(step.function);
	});
	return ids;
}

/** Trigger kinds reaching each function. */
function triggersReaching(rows: readonly Row[]): Map<string, Set<string>> {
	const functions = new Map(rows.filter((row) => row.kind === FUNCTION_KIND).map((row) => [row.id, row.body]));
	const reach = new Map<string, Set<string>>();
	for (const row of rows) {
		if (row.kind !== AUTOMATION_KIND || !isJson(row.body.trigger)) continue;
		const trigger = String(row.body.trigger.kind);
		const actions = Array.isArray(row.body.actions) ? row.body.actions : [];
		const queue = actions.flatMap((action) =>
			isJson(action) && action.kind === "run_function" && typeof action.function === "string"
				? [action.function]
				: [],
		);
		const seen = new Set<string>();
		while (queue.length > 0) {
			const id = queue.shift() as string;
			if (seen.has(id)) continue;
			seen.add(id);
			const kinds = reach.get(id) ?? new Set<string>();
			kinds.add(trigger);
			reach.set(id, kinds);
			const fn = functions.get(id);
			if (fn) queue.push(...functionsRun(fn));
		}
	}
	return reach;
}

function automationReading(body: Json, note: Note): Json {
	if (!isJson(body.trigger) || body.trigger.kind !== "crossing" || !Array.isArray(body.actions)) return body;
	return {
		...body,
		actions: body.actions.map((action, at) => {
			if (!isJson(action)) return action;
			const texts = textParams(action.kind);
			return Object.fromEntries(
				Object.entries(action).map(([key, value]) => [
					key,
					texts.has(key) && typeof value === "string"
						? readingIn(value, "text", `actions[${at}].${key}`, note)
						: value,
				]),
			);
		}),
	};
}

function functionReading(id: string, body: Json, reach: ReadonlySet<string>, note: Note): Json {
	if (!reach.has("crossing") || localReading(body) || !Array.isArray(body.steps)) return body;
	let renames = 0;
	const counted: Note = (change, where) => {
		renames++;
		note(change, where);
	};
	const out = { ...body, steps: body.steps.map((step, at) => stepReading(step, `steps[${at}]`, counted)) };
	// The value trigger still names `value`.
	if (renames > 0 && reach.has("value"))
		throw new Refusal(`${id} runs under a crossing and a value trigger; rename its ${OLD_READING} by hand`);
	return out;
}

////////////////////////////////
//  Store files

interface Row {
	id: string;
	kind: string;
	body: Json;
	[key: string]: unknown;
}

function readJson(file: string): unknown {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function rowsOf(raw: unknown): Row[] {
	if (!Array.isArray(raw)) throw new Refusal(`${RECORDS}.json is not a list`);
	const rows = raw.map((row, at) => {
		if (!isJson(row) || typeof row.id !== "string" || typeof row.kind !== "string" || !isJson(row.body))
			throw new Refusal(`${RECORDS}.json row ${at} is not a record`);
		return row as Row;
	});
	if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Refusal(`${RECORDS}.json holds an id twice`);
	return rows;
}

function schemaIssue(row: Row): string | null {
	const schema = row.kind === AUTOMATION_KIND ? AutomationSchema : row.kind === FUNCTION_KIND ? FunctionSchema : null;
	if (!schema) return null;
	const parsed = schema.safeParse(row.body);
	if (parsed.success) return null;
	const first = parsed.error.issues[0];
	return `${row.id} is not a valid ${row.kind}: ${first?.path.join(".") ?? ""} ${first?.message ?? ""}`;
}

/** Each file copied aside, then replaced. */
function land(writes: readonly { file: string; content: unknown }[]): void {
	for (const { file } of writes)
		if (fs.existsSync(`${file}${BACKUP}`)) throw new Refusal(`${file}${BACKUP} already exists`);
	for (const { file } of writes) {
		const mode = fs.statSync(file).mode & 0o777;
		writeFileAtomic(`${file}${BACKUP}`, (temp) => fs.copyFileSync(file, temp), {
			mode,
			fsyncFile: true,
			fsyncDirectory: true,
		});
	}
	for (const { file, content } of writes) {
		const mode = fs.statSync(file).mode & 0o777;
		writeFileAtomic(file, JSON.stringify(content), { mode, fsyncFile: true, fsyncDirectory: true });
	}
}

const countOf = (value: unknown): number =>
	Array.isArray(value) ? value.length : isJson(value) ? Object.keys(value).length : 0;

////////////////////////////////
//  Main

function migrate(dir: string, apply: boolean): void {
	const totals = new Map<string, number>();
	const writes: { file: string; content: unknown }[] = [];
	const problems: string[] = [];

	const recordsFile = fileOf(dir, RECORDS);
	const rows = rowsOf(readJson(recordsFile));
	const lines = new Map<string, string[]>(rows.map((row) => [row.id, []]));
	const noteFor =
		(id: string): Note =>
		(change, where) => {
			lines.get(id)?.push(`    ${where || "(body)"}: ${change}`);
			totals.set(change, (totals.get(change) ?? 0) + 1);
		};
	const step = (row: Row, rewrite: (body: Json, note: Note) => Json): Row => {
		try {
			return { ...row, body: rewrite(row.body, noteFor(row.id)) };
		} catch (error) {
			if (!(error instanceof Refusal)) throw error;
			problems.push(`${row.id}: ${error.message}`);
			return row;
		}
	};
	const renamedRows = rows.map((row) =>
		row.kind === AUTOMATION_KIND
			? step(row, automationRenamed)
			: row.kind === FUNCTION_KIND
				? step(row, functionRenamed)
				: row,
	);
	const reach = triggersReaching(renamedRows);
	const next = renamedRows.map((row) =>
		row.kind === AUTOMATION_KIND
			? step(row, automationReading)
			: row.kind === FUNCTION_KIND
				? step(row, (body, note) => functionReading(row.id, body, reach.get(row.id) ?? new Set(), note))
				: row,
	);
	let changed = 0;
	for (const row of next) {
		const issue = schemaIssue(row);
		if (issue) problems.push(issue);
		const held = lines.get(row.id) ?? [];
		if (held.length === 0) continue;
		changed++;
		console.log(`  ${row.kind} ${row.id}`);
		for (const line of held) console.log(line);
	}
	console.log(`${RECORDS}.json: ${rows.length} records, ${changed} rewritten`);
	if (changed > 0) writes.push({ file: recordsFile, content: next });

	const stateFile = fileOf(dir, STATE);
	const empty = storedOf(restore(undefined, Date.now()).value);
	if (fs.existsSync(stateFile)) {
		const held = readJson(stateFile);
		if (JSON.stringify(held) === JSON.stringify(empty)) console.log(`${STATE}.json: already empty`);
		else {
			const state = isJson(held) ? held : {};
			const counts = ["fires", "fired", "versions", "functionVersions", "log", "lastRuns", "standing", "slots"]
				.map((key) => `${key} ${countOf(state[key])}`)
				.join(", ");
			const queued = isJson(state.queue) ? countOf(state.queue.events) : 0;
			console.log(`${STATE}.json: reset (${counts}, queued tells ${queued})`);
			writes.push({ file: stateFile, content: empty });
		}
	} else console.log(`${STATE}.json: absent`);

	console.log("");
	for (const [change, count] of [...totals].sort()) console.log(`${change}: ${count}`);
	if (problems.length > 0) {
		console.log("\nrefused, nothing written:");
		for (const problem of problems) console.log(`  ${problem}`);
		process.exit(1);
	}
	if (!apply) {
		console.log(`\ndry run: nothing written; ${writes.length} files would change. Pass --apply to write.`);
		return;
	}
	land(writes);
	console.log(`\nwrote ${writes.length} files; each copied first to <file>${BACKUP}`);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const rest = args.filter((arg) => arg !== "--apply");
if (rest.length !== 1 || rest[0]?.startsWith("--")) {
	console.error("usage: bun scripts/migrate-automation-names.ts <data dir> [--apply]");
	process.exit(2);
}
try {
	migrate(path.resolve(rest[0] as string), apply);
} catch (error) {
	if (!(error instanceof Refusal)) throw error;
	console.error(`refused: ${error.message}`);
	process.exit(1);
}
