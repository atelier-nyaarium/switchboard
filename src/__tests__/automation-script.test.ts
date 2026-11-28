import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeAutomations } from "../gateway/compose/composeAutomations.js";
import {
	parseScript,
	placeIssue,
	printNumber,
	printScript,
	type ScriptTables,
} from "../gateway/computed/automationScript.js";
import { withDoing } from "../gateway/liveConsole/doing.js";
import { placeholdersOver } from "../gateway/liveConsole/placeholders.js";
import { type ConsoleEntity, createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import { createRestoreRepairs } from "../shared/durable-store.js";
import { unknown } from "../shared/expressions.js";
import { lexConsole, lexConsoleText, parseConsoleText } from "../shared/live-console-grammar.js";
import type { AutomationTrigger } from "../shared/schemasAutomation.js";
import { ConsoleOpSchema } from "../shared/schemasConsoleOp.js";
import { ConsoleOpResultSchema } from "../shared/schemasConsoleResults.js";
import {
	FUNCTION_STEPS_TOTAL_MAX,
	FunctionSchema,
	type FunctionStep,
	FunctionStepSchema,
	type StepArg,
} from "../shared/schemasFunction.js";
import { ConsoleScriptParseResultSchema, ConsoleScriptPrintResultSchema } from "../shared/schemasScript.js";

const LAMP = "aa:bb:cc:dd:ee:01";
const FAN = "aa:bb:cc:dd:ee:02";
const OTHER_FAN = "aa:bb:cc:dd:ee:03";
const ODD = "aa:bb:cc:dd:ee:04";

/** Lamp, same-named fans, every naming case. */
const tables: ScriptTables = {
	devices: [
		{ id: LAMP, name: "Desk lamp" },
		{ id: FAN, name: "Fan" },
		{ id: OTHER_FAN, name: "Fan" },
		{ id: ODD, name: 'Odd \\ {name} "x"' },
	],
	functions: [
		{
			id: "fn-blink",
			name: "Blink",
			params: [
				{ name: "lamp", type: "device" },
				{ name: "message", type: "text" },
			],
		},
		{ id: "fn-a", name: "Twin", params: [] },
		{ id: "fn-b", name: "Twin", params: [] },
		{ id: "fn-own", name: "", params: [] },
		{
			id: "fn-old",
			name: "Old names",
			params: [
				{ name: "and", type: "number" },
				{ name: "wait", type: "number" },
			],
		},
	],
};

const lit = (value: string | number | boolean): StepArg => ({ kind: "literal", value });
const expr = (text: string): StepArg => ({ kind: "expression", text });
/** A template: an expression, written as it stands. */
const quoted = (body: string): StepArg => ({ kind: "expression", text: `"${body}"` });
const turn = (device: StepArg, verb = "on"): FunctionStep => ({
	kind: "action",
	action: "device_set",
	args: { device, verb: lit(verb) },
});
const tell = (message?: string): FunctionStep => ({
	kind: "action",
	action: "tell_assistant",
	args: { when: lit("now"), ...(message === undefined ? {} : { message: lit(message) }) },
});

const print = (steps: FunctionStep[]) => printScript(steps, tables).text;
const read = (source: string) => parseScript(source, tables);
const stepsOf = (source: string) => read(source).steps;
const spansOf = (source: string) => (read(source).issues ?? []).map((issue) => source.slice(issue.start, issue.end));

const CANONICAL: Record<string, FunctionStep[]> = {
	"every statement": [
		{ kind: "comment", text: "Warm the room, then say so." },
		{ kind: "variable", name: "label", value: quoted("Room {device}") },
		{
			kind: "if",
			condition: 'value < threshold and sensors.value("Hall", "humidity") > 60',
			steps: [turn(lit(LAMP)), { kind: "wait", minutes: lit(5) }],
			else: [
				{
					kind: "if",
					condition: "value > 30",
					steps: [{ kind: "throw", text: "Too hot: {value}" }],
					else: [{ kind: "return" }],
				},
			],
		},
		{
			kind: "try",
			steps: [
				{ kind: "action", action: "ifttt_trigger", args: { event: lit("lamp_on"), value1: lit("{device}") } },
				{ kind: "run_function", function: "fn-blink", args: { lamp: lit(LAMP), message: expr("label") } },
			],
			catch: [tell("It failed: {e}")],
		},
	],
	"values of each kind": [
		{ kind: "variable", name: "count", value: lit(3) },
		{ kind: "variable", name: "low", value: lit(-0.5) },
		{ kind: "variable", name: "armed", value: lit(true) },
		{ kind: "variable", name: "twice", value: expr("count * 2") },
		{ kind: "wait", minutes: expr("twice + 1") },
		{ kind: "throw" },
	],
	"a value left out, in the middle and at the end": [
		{ kind: "action", action: "ifttt_trigger", args: { event: lit("go"), value2: lit("second") } },
		tell(),
		{ kind: "run_function", function: "fn-own" },
	],
	"names that two hold, written by id": [turn(lit(FAN), "toggle"), { kind: "run_function", function: "fn-a" }],
	"a plug by a value, and one no longer held": [turn(expr("lamp"), "off"), turn(lit("aa:bb:cc:dd:ee:99"))],
	"a plug whose name holds a backslash, braces and quotes": [
		turn(lit(ODD)),
		{ kind: "run_function", function: "fn-blink", args: { lamp: lit(ODD), message: quoted("kept \\\\ {value}") } },
	],
	"a value that reads null, beside one left out": [
		{
			kind: "action",
			action: "ifttt_trigger",
			args: { event: lit("go"), value1: expr("(null)"), value3: lit("x") },
		},
		{ kind: "variable", name: "nothing", value: expr("null") },
		{ kind: "run_function", function: "fn-blink", args: { message: expr("null") } },
	],
	"a text with quotes, a line break, a tab and escaped braces": [tell('He said "hi"\n\tnow \\{kept\\} \\\\ {value}')],
	"a placeholder whose own strings need no escaping": [
		tell('{if(cold, "brr", \'ok\')} and {sensors.value("Hall", "t")}'),
		{ kind: "throw", text: 'No {"a\\nb" + "\\{"}' },
		{ kind: "variable", name: "said", value: expr('"It is {if(cold, "brr", "ok")}" + "!"') },
	],
	"a constant with braces, a backslash and both quotes": [
		{ kind: "variable", name: "raw", value: lit("as {written} \\ \"here\" 'now'") },
		{ kind: "run_function", function: "fn-blink", args: { message: lit("{kept}") } },
	],
	"notes: several lines, an empty line, a leading space, and two in a row": [
		{ kind: "comment", text: "first\n\n indented" },
		{ kind: "comment", text: "second" },
		{ kind: "comment", text: "" },
		{ kind: "return" },
	],
	"a block of steps side by side, one holding a try": [
		{
			kind: "parallel",
			steps: [
				turn(lit(LAMP)),
				{
					kind: "try",
					steps: [turn(lit(FAN), "off"), { kind: "wait", minutes: lit(1) }],
					catch: [tell("{e.errors}")],
				},
				{ kind: "comment", text: "beside the rest" },
			],
		},
		{ kind: "parallel", steps: [] },
		{ kind: "return" },
	],
	"tasks started, awaited one by one, all together and the first of several": [
		{ kind: "start", as: "slow", steps: [{ kind: "wait", minutes: lit(5) }, turn(lit(LAMP))] },
		{ kind: "start", steps: [tell("{value}")] },
		{ kind: "start", as: "quick", steps: [] },
		{ kind: "await", task: "slow" },
		{ kind: "await", task: "all(slow, quick)", as: "both" },
		{ kind: "await", task: "any(slow, quick)", as: "first" },
		{ kind: "if", condition: "first == quick and both.done and !slow.failed", steps: [tell("{first}")] },
	],
	"an else that is not a lone if, and sides left empty": [
		{
			kind: "if",
			condition: "armed",
			else: [{ kind: "if", condition: "cold", steps: [{ kind: "return" }] }, { kind: "return" }],
		},
		{ kind: "if", condition: "armed" },
		{ kind: "try", steps: [], catch: [] },
	],
	"a switch with its cases, an empty one, and its default": [
		{
			kind: "switch",
			subject: "event.reason",
			cases: [
				{ values: ["mention", 'a "quoted" {brace}'], steps: [tell("Mentioned")] },
				{ values: ["ci_activity"], steps: [] },
				{ values: [], steps: [{ kind: "return" }] },
			],
			default: [{ kind: "switch", subject: "label", cases: [{ values: ["x"], steps: [{ kind: "return" }] }] }],
		},
	],
};

describe("a function's steps as script", () => {
	it("prints the layout the phone shows", () => {
		expect(print(CANONICAL["every statement"] as FunctionStep[])).toBe(
			[
				"// Warm the room, then say so.",
				'label = "Room {device}"',
				'if (value < threshold and sensors.value("Hall", "humidity") > 60) {',
				'\tdevices.set("Desk lamp", "on")',
				"\twait(5)",
				"} else if (value > 30) {",
				'\tthrow "Too hot: {value}"',
				"} else {",
				"\treturn",
				"}",
				"try {",
				'\tifttt.trigger("lamp_on", "{device}")',
				'\tfunctions.run("Blink", {lamp: "Desk lamp", message: label})',
				"} catch (e) {",
				'\tassistant.tell("now", "It failed: {e}")',
				"}",
			].join("\n"),
		);
	});

	for (const [name, steps] of Object.entries(CANONICAL)) {
		it(`reads back what it printed, with each step's span and each name's reach: ${name}`, () => {
			const printed = printScript(steps, tables);
			const parsed = read(printed.text);

			expect(parsed).toMatchObject({ steps });
			expect(printed.readOnly).toBeUndefined();
			expect([parsed.statements, parsed.variables]).toEqual([printed.statements, printed.variables]);
		});
	}

	it("settles any function into one that prints and reads back as itself, over a seeded sweep", () => {
		for (let seed = 1; seed <= 400; seed++) {
			const loose = drawn(seed);
			const first = printScript(loose, tables);
			const canonical = read(first.text);
			if (!canonical.steps)
				throw new Error(`seed ${seed} does not parse: ${JSON.stringify(canonical.issues)}\n${first.text}`);
			const second = printScript(canonical.steps, tables);
			const again = read(second.text);

			expect({ seed, readOnly: first.readOnly }).toEqual({ seed, readOnly: undefined });
			expect({ seed, text: second.text }).toEqual({ seed, text: first.text });
			expect({ seed, steps: again.steps }).toEqual({ seed, steps: canonical.steps });
			// A loose value keeps its own spelling in the first print.
			const reach = (held: { variables: { name: string; start: number; end: number }[] }) =>
				held.variables.map(({ name, start, end }) => [name, start, end]);
			expect({ seed, spans: [canonical.statements, reach(canonical)] }).toEqual({
				seed,
				spans: [first.statements, reach(first)],
			});
			expect({ seed, spans: [again.statements, again.variables] }).toEqual({
				seed,
				spans: [second.statements, second.variables],
			});
			expect(canonical.steps.every((step) => FunctionStepSchema.safeParse(step).success)).toBe(true);
			// Round one keeps each meaning.
			expect({ seed, texts: meaningOf(canonical.steps) }).toEqual({ seed, texts: meaningOf(loose) });
		}
	});

	it("spans each step by its path, and offers a kept name after its line and e inside its catch", () => {
		const source = 'x = 1\nif (a) {\n\treturn\n} else if (b) {\n\ty = x\n}\ntry {\n} catch (e) {\n\tthrow "{e}"\n}';
		const parsed = read(source);
		const cut = (span: { start: number; end: number }) => source.slice(span.start, span.end);

		expect((parsed.statements ?? []).map((held) => [held.step, cut(held).split("\n")[0]])).toEqual([
			["0", "x = 1"],
			["1", "if (a) {"],
			["1.0.0", "return"],
			["1.1.0", "if (b) {"],
			["1.1.0.0.0", "y = x"],
			["2", "try {"],
			["2.1.0", 'throw "{e}"'],
		]);
		expect(parsed.variables.map((held) => [held.name, cut(held).trim().split("\n")[0]])).toEqual([
			["x", "if (a) {"],
			["y", "}"],
			["e", "{"],
		]);
	});

	it("keeps a value's place under its step when a trailing comment becomes a note before it", () => {
		const source = 'return\nassistant.tell("now", "{nowhere}") // why';
		const parsed = read(source);
		if (!parsed.steps) throw new Error("it parses");
		const placeholder = placeIssue(parsed, { step: "2", param: "message", start: 1, end: 8 });

		expect(parsed.steps.map((step) => step.kind)).toEqual(["return", "comment", "action"]);
		expect(placeholder && source.slice(placeholder.start, placeholder.end)).toBe("nowhere");
	});

	it("refuses a body past a function's bounds at the first step over, and a value too long", () => {
		const over = FUNCTION_STEPS_TOTAL_MAX;
		const many = Array.from({ length: over + 1 }, (_, index) => `x${index} = ${index}`).join("\n");
		const wide = Array.from(
			{ length: FUNCTION_STEPS_TOTAL_MAX / 8 + 1 },
			() => `if (a) {\n${Array.from({ length: 7 }, () => "return").join("\n")}\n}`,
		).join("\n");
		const long = `x = "${"a".repeat(1001)}"`;

		expect(spansOf(many)).toEqual([`x${over} = ${over}`]);
		expect(read(wide).issues).toMatchObject([{ start: wide.lastIndexOf("if (a) {") }]);
		expect(spansOf(long)).toEqual([long.slice(4)]);
		expect(spansOf("x = 9".padEnd(700, "9"))).toEqual(["9".repeat(696)]);
	});

	it("writes two spellings of one meaning one way, and what it reads back is stable", () => {
		const loose: FunctionStep[] = [
			{ kind: "variable", name: "a", value: expr("  count +\n 1 ") },
			{ kind: "variable", name: "b", value: lit("plain {braces} \\ x") },
			{ kind: "variable", name: "c", value: lit("on") },
			tell("lone \\ backslash"),
			{ kind: "if", condition: " armed ", steps: [], else: [] },
			{ kind: "comment", text: "one\r\ntwo" },
		];
		const canonical = stepsOf(print(loose)) as FunctionStep[];

		expect(canonical).toEqual([
			{ kind: "variable", name: "a", value: expr("count +  1") },
			// A constant is as written, whatever it holds.
			{ kind: "variable", name: "b", value: lit("plain {braces} \\ x") },
			{ kind: "variable", name: "c", value: lit("on") },
			tell("lone \\\\ backslash"),
			{ kind: "if", condition: "armed" },
			{ kind: "comment", text: "one\ntwo" },
		]);
		expect(stepsOf(print(canonical))).toEqual(canonical);
	});

	it("keeps an expression an expression, though it is one literal or names a plug", () => {
		const held: FunctionStep[] = [
			{ kind: "variable", name: "a", value: expr("5") },
			{ kind: "variable", name: "b", value: expr('"plain \\{braces\\}"') },
			{ kind: "variable", name: "c", value: expr("-2") },
			{ kind: "variable", name: "d", value: expr("null") },
			turn(expr('"Desk lamp"')),
			{ kind: "action", action: "tell_assistant", args: { when: lit("now"), message: expr('"is {a}"') } },
			turn(expr('"Lamp {a}"')),
			{
				kind: "action",
				action: "ifttt_trigger",
				args: { event: lit("go"), value1: expr("null"), value3: lit("x") },
			},
		];
		const settled = stepsOf(print(held)) as FunctionStep[];

		expect(print(held).split("\n")).toEqual([
			"a = (5)",
			'b = ("plain \\{braces\\}")',
			"c = (-2)",
			"d = null",
			'devices.set(("Desk lamp"), "on")',
			'assistant.tell("now", ("is {a}"))',
			'devices.set(("Lamp {a}"), "on")',
			'ifttt.trigger("go", (null), null, "x")',
		]);
		expect(
			settled.flatMap((step) => Object.values("args" in step ? (step.args ?? {}) : {}).map((arg) => arg.kind)),
		).toEqual([
			"expression",
			"literal",
			"literal",
			"expression",
			"expression",
			"literal",
			"literal",
			"expression",
			"literal",
		]);
		expect(stepsOf(print(settled))).toEqual(settled);
	});

	it("writes every quoted string by one rule, and reads each as what its place holds", () => {
		const odd = print([turn(lit(ODD)), tell("a \\{b\\} {value}")]).split("\n");

		expect(odd).toEqual([
			'devices.set("Odd \\\\ \\{name\\} \\"x\\"", "on")',
			'assistant.tell("now", "a \\{b\\} {value}")',
		]);
		expect(stepsOf('ifttt.trigger("a\\\\b", "c\\\\d \\{e\\}")')).toEqual([
			{ kind: "action", action: "ifttt_trigger", args: { event: lit("a\\b"), value1: lit("c\\\\d \\{e\\}") } },
		]);
		expect(
			stepsOf('x = "a {b}"\ny = "plain"\nfunctions.run("Blink", {message: "\\{kept\\}", lamp: "Desk lamp"})'),
		).toEqual([
			{ kind: "variable", name: "x", value: quoted("a {b}") },
			{ kind: "variable", name: "y", value: lit("plain") },
			{ kind: "run_function", function: "fn-blink", args: { lamp: lit(LAMP), message: lit("{kept}") } },
		]);
		// A plug, a word and a function's name take no placeholder.
		expect(spansOf('devices.set("{room}", "on")\nifttt.trigger("go {x}")\nfunctions.run("{f}")')).toEqual([
			'"{room}"',
			'"go {x}"',
			'functions.run("{f}")',
		]);
	});

	it("reads only what would not read back: a value past its cap as text, a text with an open placeholder, a value a function does not take", () => {
		const grown = tell("a\\b".repeat(333));
		const open = tell("It is {value");
		const stray: FunctionStep = { kind: "run_function", function: "fn-a", args: { nope: lit(1) } };
		const long = Array.from({ length: 30 }, (): FunctionStep => tell("x".repeat(999)));
		// One line would close this string and make it mean something.
		const broken: FunctionStep = { kind: "variable", name: "a", value: expr('"abc\n" + 1') };

		// A string holds no line break of either kind, and space is the lexer's alone.
		const returned: FunctionStep = { kind: "if", condition: 'y == "a\rb"', steps: [{ kind: "return" }] };
		const inPlaceholder = tell('x {"a\rb"} y');
		const padded: FunctionStep = { kind: "variable", name: "a", value: expr("\u00a0x\u00a0") };

		expect(
			[grown, open, stray, broken, returned, inPlaceholder, padded].map(
				(step) => printScript([step], tables).readOnly !== undefined,
			),
		).toEqual([true, true, true, true, true, true, true]);
		expect(printScript(long, tables)).toMatchObject({ text: "", statements: [], variables: [] });
		expect(printScript(long, tables).readOnly).toBeDefined();
		expect(spansOf('functions.run("Twin", {nope: 1})\nfunctions.run("fn-a", {nope: 1})')).toEqual([
			'"Twin"',
			"nope",
		]);
	});

	it("keeps a placeholder's expression as written: its strings sit in the script unescaped, and their own escapes stay theirs", () => {
		const placeholder = tell('{"a\\nb"} and {x == "}"} and {if(a, "\\"", \'\\{\')}');
		const printed = print([placeholder]);
		const strings = (source: string) =>
			lexConsole(source)
				.filter((token) => token.kind === "string")
				.map((token) => token.value);

		expect(printed).toBe(
			`assistant.tell("now", "${(placeholder.kind === "action" && placeholder.args.message?.kind === "literal" && placeholder.args.message.value) || ""}")`,
		);
		expect(stepsOf(printed)).toEqual([placeholder]);
		expect(strings('"a\\nb" + "\\{" + "\\q"')).toEqual(["a\nb", "{", "\\q"]);
	});

	it("places an offset on the whole escape it names, and holds one past the value to the value", () => {
		const source = 'throw "\\n{nowhere}"';
		const parsed = read(source);
		if (!parsed.steps) throw new Error("it parses");
		const cut = (start: number, end: number) => {
			const at = placeIssue(parsed, { step: "0", param: "text", start, end });
			return at && source.slice(at.start, at.end);
		};

		expect([cut(0, 1), cut(2, 9), cut(0, 2), cut(5, 9_007_199_254_740_991)]).toEqual([
			"\\n",
			"nowhere",
			"\\n{",
			"here}",
		]);
		// A value with no escapes is held the same way.
		const plain = read("x = (2 + nowhere)");
		const far =
			plain.steps &&
			placeIssue(plain, { step: "0", param: "value", start: 9_007_199_254_740_991, end: 9_007_199_254_740_991 });
		expect(far).toEqual({ start: 17, end: 17 });
	});

	it("reads a text pasted with carriage returns as the same steps, with each span on its own characters", () => {
		const source = "// abc\r\n// def\r\nx = (1 +\r\n  bogus.thing)\r\nreturn\r\n";
		const parsed = read(source);
		if (!parsed.steps) throw new Error("it parses");
		const where = placeIssue(parsed, { step: "1", param: "value", start: 8, end: 13 });

		expect(parsed.steps).toEqual([
			{ kind: "comment", text: "abc\ndef" },
			{ kind: "variable", name: "x", value: expr("(1 +    bogus.thing)") },
			{ kind: "return" },
		]);
		expect(where && source.slice(where.start, where.end)).toBe("bogus");
		expect(stepsOf(print(parsed.steps))).toEqual(parsed.steps);
	});

	it("reads a plug or a function by its name, and either quote", () => {
		expect(stepsOf("devices.set('Desk lamp', \"off\")\nfunctions.run(\"Blink\", {lamp: 'Desk lamp'})")).toEqual([
			turn(lit(LAMP), "off"),
			{ kind: "run_function", function: "fn-blink", args: { lamp: lit(LAMP) } },
		]);
		expect(stepsOf(`devices.set("${OTHER_FAN}", "on")`)).toEqual([turn(lit(OTHER_FAN))]);
	});

	it("turns a comment after a statement into a note before it, and one line after another into one note", () => {
		expect(stepsOf("// a\n// b\n\n// c\nreturn // done\nif (armed) { // why\n\treturn\n}")).toEqual([
			{ kind: "comment", text: "a\nb" },
			{ kind: "comment", text: "c" },
			{ kind: "comment", text: "done" },
			{ kind: "return" },
			{ kind: "if", condition: "armed", steps: [{ kind: "comment", text: "why" }, { kind: "return" }] },
		]);
	});

	it("refuses what it cannot keep, with the span it means, and carries on to the next line", () => {
		expect(spansOf('devices.set("Fan", "on")\nfunctions.run("Twin")\nfunctions.run("Nobody")\nreturn')).toEqual([
			'"Fan"',
			'"Twin"',
			'"Nobody"',
		]);
		expect(spansOf('value > 3\nx = devices.set("Desk lamp", "on")\nUpper = 1\nx = "open')).toEqual([
			"value > 3",
			'x = devices.set("Desk lamp", "on")',
			"Upper",
			'"open',
		]);
		expect(spansOf("if armed {\n}\nelse {\n}\ntry {\n}\nany x")).toEqual(["armed", "else", "try", "any"]);
		expect(spansOf("if (armed) {\n\treturn")).toEqual(["if"]);
		expect(spansOf("}\nreturn")).toEqual(["}"]);
		expect(spansOf('f(a, // one\n b)\nifttt.trigger("a", "b", "c", "d", "e")\nthrow 5\nwait()')).toEqual([
			"// one",
			'ifttt.trigger("a", "b", "c", "d", "e")',
			"5",
			"()",
		]);
		expect(spansOf("x = (1 +")).toHaveLength(1);
	});

	it("keeps one mistake to its line: an open string, an open placeholder, an open bracket, a comment in a bracket", () => {
		expect(spansOf('x = "abc\ny = 1\nreturn')).toEqual(['"abc']);
		expect(spansOf('if (a) {\n\tassistant.tell("now", "{x")\n}\nreturn\nreturn')).toHaveLength(1);
		expect(spansOf('assistant.tell("now", "Hi {name")\nx = 1\nreturn')).toHaveLength(1);
		expect(stepsOf("y = 1\nreturn")).toHaveLength(2);
		expect(spansOf("x = round(1,\ny = 2\nreturn")).toHaveLength(1);
		expect(spansOf("x = [1, // one\n 2]\nreturn")).toEqual(["// one"]);
	});

	it("reads a brace by where it stands: a record in a value, a block after its word, on its line or the next", () => {
		expect(stepsOf("x = {a: 1,\n\tb: [2,\n\t3]}\nif (x.a == 1)\n{\n\treturn\n}\nelse\n{\n\treturn\n}")).toEqual([
			{ kind: "variable", name: "x", value: expr("{a: 1, \tb: [2, \t3]}") },
			{ kind: "if", condition: "x.a == 1", steps: [{ kind: "return" }], else: [{ kind: "return" }] },
		]);
		expect(stepsOf("try {\n}\ncatch (e) {\n}\nparallel { return }")).toEqual([
			{ kind: "try", steps: [], catch: [] },
			{ kind: "parallel", steps: [{ kind: "return" }] },
		]);
		expect(spansOf("{\n\treturn\n}")).toEqual(["{"]);
	});

	it("counts a value's nodes where it is saved, so a long value reads in script as it saves", () => {
		const long = Array.from({ length: 127 }, () => "1").join(" + ");
		const steps: FunctionStep[] = [
			{ kind: "action", action: "tell_assistant", args: { when: lit("now"), message: expr(long) } },
		];

		expect(stepsOf(print(steps))).toEqual(steps);
		expect(printScript(steps, tables).readOnly).toBeUndefined();
	});

	it("places a refusal inside a constant on the characters that wrote it, an escape whole", () => {
		const source = 'ifttt.trigger("a\\{b\\}c")';
		const parsed = read(source);
		if (!parsed.steps) throw new Error("it parses");
		const cut = (start: number, end: number) => {
			const at = placeIssue(parsed, { step: "0", param: "event", start, end });
			return at && source.slice(at.start, at.end);
		};

		expect(parsed.steps).toEqual([{ kind: "action", action: "ifttt_trigger", args: { event: lit("a{b}c") } }]);
		expect([cut(0, 1), cut(1, 4), cut(4, 5)]).toEqual(["a", "\\{b\\}", "c"]);
	});

	it("reads a switch's values as quoted constants and drops an empty default", () => {
		expect(stepsOf("switch (label) {\n\tcase \"a\", 'b' {\n\t\treturn\n\t}\n\tdefault {\n\t}\n}")).toEqual([
			{ kind: "switch", subject: "label", cases: [{ values: ["a", "b"], steps: [{ kind: "return" }] }] },
		]);
		expect(spansOf('switch (label) {\n\tcase "{x}" {\n\t}\n}\nswitch (label) {\n\tcase 1 {\n\t}\n}')).toEqual([
			'"{x}"',
			"1",
		]);
	});

	it("prints a case with no values as `case {` and reads it back as one", () => {
		const empty: FunctionStep = { kind: "switch", subject: "label", cases: [{ values: [], steps: [] }] };

		expect(print([empty])).toBe("switch (label) {\n\tcase {\n\t}\n}");
		expect(stepsOf(print([empty]))).toEqual([empty]);
		expect(spansOf('switch (label) {\n\tcase\n\tcase "a", {\n\t}\n}')).toEqual(["case", "case"]);
	});

	it("refuses a case or a default outside a switch, one after its default, and a line that is neither", () => {
		expect(spansOf('case "a" {\n}\ndefault {\n}\nswitch label {\n}')).toEqual(["case", "default", "label"]);
		expect(spansOf('switch (label) {\n\tdefault {\n\t}\n\tcase "a" {\n\t}\n}\nreturn')).toEqual(["case"]);
		expect(spansOf("switch (label) {\n\treturn\n\tcase {\n\t}\n}\nx = 1")).toEqual(["return"]);
		expect(stepsOf('switch (label) {\n\tcase "a" {\n\t}\n}\nreturn')).toHaveLength(2);
	});

	it("reads a task started on one line as a block of one, and refuses a start or an await of nothing", () => {
		expect(stepsOf('t = start devices.set("Desk lamp", "on")\nfirst = await any(t)')).toEqual([
			{ kind: "start", as: "t", steps: [turn(lit(LAMP))] },
			{ kind: "await", task: "any(t)", as: "first" },
		]);
		expect(spansOf("start\nawait\nT = start {\n}")).toEqual(["start", "await", "T"]);
		expect(stepsOf("timer = start wait(5)\nt = start\n{\n}\nu = start await t")).toEqual([
			{ kind: "start", as: "timer", steps: [{ kind: "wait", minutes: lit(5) }] },
			{ kind: "start", as: "t", steps: [] },
			{ kind: "start", as: "u", steps: [{ kind: "await", task: "t" }] },
		]);
	});

	it("refuses blocks nested past what it follows, without running out of stack", () => {
		const deep = `${"if(a){".repeat(3000)}${"}".repeat(3000)}`;

		expect(read(deep).issues?.length).toBeGreaterThan(0);
	});

	it("reads only a step a script cannot write, and a call to a function not held", () => {
		const kept = {
			kind: "action",
			action: "device_set",
			as: "result",
			args: { device: lit(LAMP), verb: lit("on") },
		};
		const unknown = { kind: "action", action: "launch_rocket", args: {} };
		const gone = { kind: "run_function", function: "fn-gone" };

		expect(
			[kept, unknown, gone].map((step) => printScript([step as FunctionStep], tables).readOnly !== undefined),
		).toEqual([true, true, true]);
		expect(printScript([unknown as FunctionStep, { kind: "return" }], tables).text.split("\n")[1]).toBe("return");
	});

	it("reads only a stored name the language took, and quotes such a name where a call gives it", () => {
		const taken = ["wait", "all", "and", "true", "default"].map((name) =>
			printScript([{ kind: "variable", name, value: lit(1) }], tables),
		);
		const given: FunctionStep = { kind: "run_function", function: "fn-old", args: { and: lit(1), wait: lit(2) } };

		expect(taken.map((printed) => printed.readOnly !== undefined)).toEqual([true, true, true, true, true]);
		expect(print([given])).toBe('functions.run("Old names", {"and": 1, wait: 2})');
		expect(stepsOf(print([given]))).toEqual([given]);
	});

	it("places a save's refusal in the script, through a text's escapes", () => {
		const source = 'return\nassistant.tell("now", "a\\"b {nowhere}")';
		const parsed = read(source);
		if (!parsed.steps) throw new Error("it parses");
		// The text is `a"b {nowhere}`: the name sits at 5 to 12.
		const placeholder = placeIssue(parsed, { step: "1", param: "message", start: 5, end: 12 });
		const whole = placeIssue(parsed, { step: "1", param: "when" });
		const statement = placeIssue(parsed, { step: "0" });

		expect([placeholder, whole, statement].map((span) => span && source.slice(span.start, span.end))).toEqual([
			"nowhere",
			'"now"',
			"return",
		]);
		expect(placeIssue(parsed, { step: "7" })).toBeNull();
	});

	it("writes a number plainly and a text's lone backslash doubled", () => {
		expect([1e21, 1.5e-7, -0, 0.1, -42, 123456.789].map(printNumber)).toEqual([
			"1000000000000000000000",
			"0.00000015",
			"0",
			"0.1",
			"-42",
			"123456.789",
		]);
		expect(stepsOf(print([tell("a\\b \\{c\\} \\\\ \\")]))).toEqual([tell("a\\\\b \\{c\\} \\\\ \\\\")]);
	});
});

/** A seeded draw, so a failure names its seed. */
function drawer(seed: number) {
	let state = seed >>> 0 || 1;
	const next = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
	const int = (below: number) => Math.floor(next() * below);
	const pick = <T>(from: readonly T[]): T => from[int(from.length)] as T;
	return { int, pick, chance: (of: number) => next() < of };
}

const PIECES = [
	"a",
	"B",
	" ",
	'"',
	"'",
	"\\",
	"{",
	"}",
	"\\{",
	"{value}",
	"\n",
	"\t",
	"\r",
	"/",
	"//",
	"#",
	"\u{1F600}",
	",",
	'{"a\\nb"}',
	'{x == "}"}',
	"{'q\\'s' + \"\\\\\"}",
	"{if(a, \"x\", 'y')}",
];
/** A brace opening no placeholder. */
const LOOSE = [...PIECES, "{", "{open"];
const EXPRESSIONS = [
	"count + 1",
	"value > 3 and armed",
	'sensors.value("Hall", "x // y")',
	"[1, 2]",
	"{a: 1}.a",
	'"text {value}"',
	'"it is {if(cold, "brr", "ok")}"',
	"'single'",
	"5",
	"-2",
	"true",
	"null",
	"(null)",
	"count\n+ 1",
	'"two\\nlines"',
	"!armed or count == 2",
	"items[0]",
	"  spaced  ",
];
const NAMES = ["count", "label", "armed", "x1", "items"];
const VERBS = ["on", "off", "toggle"];

function drawn(seed: number): FunctionStep[] {
	const draw = drawer(seed);
	const drawnFrom = (pieces: readonly string[]) =>
		Array.from({ length: draw.int(6) }, () => draw.pick(pieces)).join("");
	/** A text with placeholders read. */
	const text = () => {
		const said = drawnFrom(PIECES);
		return parseConsoleText(said).issues.length === 0 ? said : "";
	};
	const constant = () => drawnFrom(LOOSE);
	/** A kept or given value. */
	const value = (): StepArg =>
		draw.pick<() => StepArg>([
			() => lit(constant()),
			() => lit(draw.int(2000) / 8 - 100),
			() => lit(draw.chance(0.5)),
			() => expr(draw.pick(EXPRESSIONS)),
		])();
	/** An action's text. */
	const said = (): StepArg =>
		draw.pick<() => StepArg>([() => lit(text()), () => lit(draw.int(9)), () => expr(draw.pick(EXPRESSIONS))])();
	const device = (): StepArg => draw.pick([lit(LAMP), lit(FAN), lit(ODD), lit("aa:bb:cc:dd:ee:99"), expr("room")]);
	let left = 24;
	const list = (depth: number, most: number): FunctionStep[] =>
		Array.from({ length: draw.int(most + 1) }, () => step(depth)).filter((held) => held !== null);
	const step = (depth: number): FunctionStep | null => {
		if (left-- <= 0) return null;
		const nested = depth < 3;
		return draw.pick<() => FunctionStep>([
			() => ({ kind: "comment", text: constant() }),
			() => ({ kind: "variable", name: draw.pick(NAMES), value: value() }),
			() => ({ kind: "return" }),
			() => (draw.chance(0.3) ? { kind: "throw" } : { kind: "throw", text: text() }),
			() => ({ kind: "wait", minutes: draw.pick([lit(5), lit(0.25), expr("count * 2")]) }),
			() => turn(device(), draw.pick(VERBS)),
			() => (draw.chance(0.4) ? tell() : tell(text())),
			() => ({
				kind: "action",
				action: "ifttt_trigger",
				args: {
					event: draw.pick([lit("go"), lit(constant() || "e"), expr("label")]),
					...(draw.chance(0.5) ? { value1: said() } : {}),
					...(draw.chance(0.3) ? { value3: said() } : {}),
				},
			}),
			() => ({
				kind: "run_function",
				function: "fn-blink",
				...(draw.chance(0.6)
					? {
							values: {
								...(draw.chance(0.7) ? { lamp: device() } : {}),
								...(draw.chance(0.7) ? { message: value() } : {}),
							},
						}
					: {}),
			}),
			() =>
				nested
					? {
							kind: "if",
							condition: draw.pick(EXPRESSIONS),
							steps: list(depth + 1, 3),
							else: list(depth + 1, 2),
						}
					: { kind: "return" },
			() =>
				nested
					? {
							kind: "switch",
							subject: draw.pick(EXPRESSIONS),
							cases: Array.from({ length: 1 + draw.int(3) }, () => ({
								values: Array.from({ length: draw.int(4) }, constant),
								steps: list(depth + 1, 2),
							})),
							...(draw.chance(0.5) ? { default: list(depth + 1, 2) } : {}),
						}
					: { kind: "return" },
			() => (nested ? { kind: "try", steps: list(depth + 1, 3), catch: list(depth + 1, 2) } : { kind: "return" }),
			() => (nested ? { kind: "parallel", steps: list(depth + 1, 3) } : { kind: "return" }),
			() =>
				nested
					? { kind: "start", ...(draw.chance(0.5) ? { as: "task" } : {}), steps: list(depth + 1, 2) }
					: { kind: "return" },
			() => ({
				kind: "await",
				task: draw.pick(["task", "all(task)", "any(task, task)"]),
				...(draw.chance(0.3) ? { as: "got" } : {}),
			}),
		])();
	};
	return list(1, 7);
}

/** What each value says: a text's runs as they fill and its placeholders as written, a constant as it is. */
function meaningOf(steps: readonly FunctionStep[]): unknown[] {
	/** Runs join where an escape stood, so what a run says is compared whole. */
	const said = (text: string) => {
		const out: unknown[] = [];
		for (const part of lexConsoleText(text)) {
			const last = out.at(-1) as [string, string] | undefined;
			if (part.kind === "placeholder") out.push(["placeholder", text.slice(part.start, part.end), part.closed]);
			else if (last?.[0] === "run") last[1] += part.value;
			else out.push(["run", part.value]);
		}
		return out;
	};
	const value = (arg: StepArg): unknown => (arg.kind === "expression" ? ["expression"] : arg.value);
	const texts = new Set(["message", "value1", "value2", "value3"]);
	return steps.flatMap((step): unknown[] => {
		switch (step.kind) {
			case "action":
				return Object.entries(step.args).map(([name, arg]) =>
					arg.kind === "literal" && typeof arg.value === "string" && texts.has(name)
						? said(arg.value)
						: value(arg),
				);
			case "throw":
				return step.text === undefined ? [] : [said(step.text)];
			case "variable":
				return [value(step.value)];
			case "run_function":
				return Object.values(step.args ?? {}).map(value);
			case "if":
				return [...meaningOf(step.steps ?? []), ...meaningOf(step.else ?? [])];
			case "switch":
				return [
					...step.cases.flatMap((held) => [...held.values, ...meaningOf(held.steps)]),
					...meaningOf(step.default ?? []),
				];
			case "try":
				return [...meaningOf(step.steps), ...meaningOf(step.catch)];
			case "parallel":
			case "start":
				return meaningOf(step.steps);
			default:
				return [];
		}
	});
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const sensors: ConsoleEntity = {
	name: "sensors",
	description: "Paired sensors.",
	audiences: ["host", "owner"],
	members: {
		list: { kind: "property", description: "Every sensor.", type: "List<Sensor>", get: () => [] },
		value: {
			kind: "method",
			description: "One reading.",
			params: [],
			returns: "Number",
			call: () => 0,
		},
	},
};
const sensor: ConsoleEntity = {
	name: "Sensor",
	description: "A paired sensor.",
	catalogue: true,
	audiences: ["host", "owner"],
	members: { name: { kind: "property", description: "Its name.", type: "Text", get: () => "" } },
};
const REGISTRY = createConsoleRegistry(withDoing([sensors, sensor]));
const crossing: AutomationTrigger = {
	kind: "crossing",
	device: "aa:bb:cc:dd:ee:10",
	measure: "temperature",
	direction: "below",
	threshold: 2,
	deadZone: 0,
	coolDownSec: 0,
};

function stage() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-script-"));
	roots.push(dir);
	let n = 0;
	const { console, automations } = composeAutomations({
		repairs: createRestoreRepairs(),
		dataDir: dir,
		newIncarnation: () => `a${++n}`,
		now: () => 1_000,
		input: () => ({ type: { type: "number", integral: false }, value: unknown("not heard") }),
		offers: () => ({ numbers: [], devices: [{ device: LAMP, name: "Desk lamp" }] }),
		previewEvent: async () => ({ events: [] }) as never,
		scriptVocabulary: () => REGISTRY.projection("script"),
		automations: {
			isHome: () => true,
			eventIssue: () => null,
			eventFields: () => ["reason"],
			eventChoices: (_source, field) => (field === "reason" ? ["mention", "assign"] : null),
			entropy: (size) => crypto.randomBytes(size),
			placeholders: () => placeholdersOver(REGISTRY),
			actions: {
				ready: () => true,
				deviceName: (device) => (device === LAMP ? "Desk lamp" : null),
				deviceSet: async () => ({ word: "done" }),
				iftttTrigger: async () => ({ word: "done" }),
			},
		},
	});
	const asked = <K extends "script_print" | "script_parse">(kind: K, request: object) => {
		const op = ConsoleOpSchema.parse({ kind, ...request });
		if (op.kind !== kind) throw new Error("another op");
		return op as Extract<typeof op, { kind: K }>;
	};
	return {
		automations,
		print: (request: object) => {
			const answer = console.scriptPrint(asked("script_print", request));
			ConsoleOpResultSchema.parse(answer);
			return ConsoleScriptPrintResultSchema.parse(answer);
		},
		parse: (request: object) => {
			const answer = console.scriptParse(asked("script_parse", request));
			ConsoleOpResultSchema.parse(answer);
			return ConsoleScriptParseResultSchema.parse(answer);
		},
	};
}

describe("the script's console reads", () => {
	const steps: FunctionStep[] = [
		{ kind: "variable", name: "humid", value: expr('sensors.value("Hall", "humidity")') },
		{ kind: "variable", name: "damp", value: expr("humid > 60 and value < threshold") },
		{ kind: "variable", name: "first", value: expr("sensors.list[0].name") },
		{
			kind: "try",
			steps: [turn(lit(LAMP))],
			catch: [{ kind: "variable", name: "why", value: expr("e.message") }, tell("{why}")],
		},
		{ kind: "variable", name: "humid", value: lit("gone") },
		{ kind: "variable", name: "odd", value: expr("damp[0]") },
		{ kind: "variable", name: "joined", value: expr('first + " here"') },
		{ kind: "variable", name: "said", value: quoted("{humid} now") },
	];

	it("prints a function with each name typed where it is offered, and parses that text back to the same answer", () => {
		const { print, parse } = stage();
		const context = { trigger: crossing, params: [{ name: "room", type: "device" }] };
		const printed = print({ steps, ...context });
		const parsed = parse({ text: printed.text, ...context });
		const at = (line: string) => printed.text.indexOf(line) + line.length;
		const typed = printed.names.map((held) => [held.name, held.type, held.start, held.end]);
		const end = printed.text.length;

		expect(printed.text.split("\n").slice(0, 4)).toEqual([
			'humid = sensors.value("Hall", "humidity")',
			"damp = humid > 60 and value < threshold",
			"first = sensors.list[0].name",
			"try {",
		]);
		expect(typed).toEqual([
			["reading", "Number", 0, end],
			["device", "Text", 0, end],
			["measure", "Text", 0, end],
			["threshold", "Number", 0, end],
			["room", "Device", 0, end],
			["humid", "Number", at('"humidity")'), at('humid = "gone"')],
			["damp", "Boolean", at("< threshold"), end],
			["first", "Text", at("[0].name"), end],
			[
				"e",
				"Error",
				printed.text.indexOf("{", printed.text.indexOf("catch")),
				printed.text.indexOf("}\nhumid") + 1,
			],
			["why", "Text", at("e.message"), end],
			["humid", "Text", at('humid = "gone"'), end],
			["odd", "Unknown", at("damp[0]"), end],
			["joined", "Text", at('first + " here"'), end],
			["said", "Text", at('"{humid} now"'), end],
		]);
		expect(printed.readOnly).toBeUndefined();
		expect(printed.types).toEqual([
			{
				name: "Error",
				members: [
					{ name: "code", type: "Text" },
					{ name: "message", type: "Text" },
					{ name: "errors", type: "List<Error>" },
				],
			},
			{
				name: "Task",
				members: [
					{ name: "done", type: "Boolean" },
					{ name: "failed", type: "Boolean" },
					{ name: "error", type: "Error" },
				],
			},
		]);
		expect(parsed).toEqual({ steps, names: printed.names, types: printed.types, statements: printed.statements });
	});

	it("reads a call by a function the draft holds over the stored one, and a stored one by its name", () => {
		const { print, parse, automations } = stage();
		const stored = automations.save({
			id: "ring",
			body: {
				enabled: true,
				trigger: { kind: "interval", everyMin: 60 },
				actions: [{ kind: "run_function", function: "fn-old" }],
			},
			base: 0,
			function: {
				as: "edit",
				id: "fn-old",
				body: FunctionSchema.parse({ name: "Old name", params: [], steps: [tell()] }),
				base: 0,
			},
			confirmed: true,
		});
		const drafted = [
			{ id: "fn-old", name: "New name", params: [] },
			{ id: "fn-new", name: "Fresh", params: [{ name: "lamp", type: "device" }] },
		];
		const text = 'functions.run("New name")\nfunctions.run("Fresh", {lamp: "Desk lamp"})';
		const calls: FunctionStep[] = [
			{ kind: "run_function", function: "fn-old" },
			{ kind: "run_function", function: "fn-new", args: { lamp: lit(LAMP) } },
		];

		expect(stored).toMatchObject({ stored: true });
		expect(parse({ text, functions: drafted }).steps).toEqual(calls);
		expect(print({ steps: calls, functions: drafted }).text).toBe(text);
		expect(parse({ text: 'functions.run("Old name")' }).steps).toEqual([calls[0]]);
		expect(parse({ text: 'functions.run("Old name")', functions: drafted }).issues).toHaveLength(1);
	});

	it("answers a text's issues with the names read past them, and places a save's refusal", () => {
		const { parse } = stage();
		const broken = parse({ text: 'kept = 1\nwait(\nlater = "x"', trigger: crossing });
		const placed = parse({
			text: 'return\nassistant.tell("now", "{nowhere}")',
			place: { step: "1", param: "message", start: 1, end: 8 },
		});

		expect(broken.steps).toBeUndefined();
		expect(broken.issues).toHaveLength(1);
		expect(broken.statements).toEqual([]);
		expect(broken.names.map((held) => held.name)).toEqual(["reading", "device", "measure", "threshold", "kept"]);
		expect(
			parse({ text: "x = event.reason", trigger: { kind: "event", source: "github", conditions: [] } }),
		).toMatchObject({
			names: [{ name: "event", type: "Event" }, { name: "source" }, { name: "x", type: "Text" }],
			types: [
				{ name: "Error" },
				{ name: "Task" },
				{ name: "Event", members: [{ name: "id" }, { name: "title" }, { name: "url" }, { name: "reason" }] },
			],
		});
		expect(placed.placed).toEqual({ start: 31, end: 38 });
		expect(parse({ text: "return", place: { step: "4" } }).placed).toBeUndefined();
	});

	it("answers every issue of the steps by its level, where it sits in the text", () => {
		const { parse } = stage();
		const cutOf = (text: string) =>
			(parse({ text }).issues ?? []).map((issue) => [text.slice(issue.start, issue.end)]);
		const levelsOf = (text: string) =>
			(parse({ text }).issues ?? []).map((issue) => [text.slice(issue.start, issue.end), issue.level]);

		expect(levelsOf('sensors = 1\nassistant.tell("now", "{nowhere}")\nwait(-1)')).toEqual([
			["sensors", "warning"],
			["nowhere", "error"],
			["-1", "error"],
		]);
		expect(levelsOf("wait(")).toEqual([[expect.any(String), "error"]]);

		expect(cutOf('return\nassistant.tell("now", "a\\"b {nowhere}")')).toEqual([["nowhere"]]);
		expect(cutOf('x = 1\nif (devices.set("Desk lamp", "on")) {\n}').flat()).toEqual(["devices.set"]);
		expect(cutOf('devices.set("aa:bb:cc:dd:ee:99", "on")').flat()).toEqual(['"aa:bb:cc:dd:ee:99"']);
		expect(cutOf('devices.set("Desk lamp", "sideways")').flat()).toEqual(['"sideways"']);
		expect(cutOf("return\nsensors = 1").flat()).toEqual(["sensors"]);
		expect(parse({ text: 'devices.set("Desk lamp", "sideways")' }).steps).toHaveLength(1);
		expect(cutOf('devices.set("Desk lamp", "on")\nwait(5)')).toEqual([]);
	});

	it("places a switch's case issues on their values: a repeat as an error, a lost choice as a warning", () => {
		const { parse } = stage();
		const text = 'switch (event.reason) {\n\tcase "mention", "gone" {\n\t}\n\tcase "MENTION" {\n\t}\n}';
		const levelsOf = (trigger?: AutomationTrigger) =>
			(parse({ text, ...(trigger ? { trigger } : {}) }).issues ?? []).map((issue) => [
				text.slice(issue.start, issue.end),
				issue.level,
			]);

		expect(levelsOf()).toEqual([['"MENTION"', "error"]]);
		expect(levelsOf({ kind: "event", source: "github", conditions: [] })).toEqual([
			['"MENTION"', "error"],
			['"gone"', "warning"],
		]);
		const empty = parse({ text: "switch (event.reason) {\n\tcase {\n\t}\n}" });
		expect([empty.steps?.length, empty.issues?.map((issue) => issue.level)]).toEqual([1, ["error"]]);
	});

	it("says a printed step it cannot write back reads only, and still spans each step", () => {
		const { print } = stage();
		const printed = print({
			steps: [{ kind: "action", action: "device_set", as: "result", args: {} }, { kind: "return" }],
		});

		expect(printed.readOnly).toBeDefined();
		expect(printed.statements.map((held) => held.step)).toEqual(["0", "1"]);
	});

	it("prints a script saved with errors as it was typed and open to edit, which a parse reads as issues", () => {
		const { print, parse } = stage();
		const source = 'try {\n\tdevices.set("Lamp", )\n}';
		const printed = print({ steps: [{ kind: "unparsed", source }] });
		const parsed = parse({ text: printed.text });

		expect(printed).toMatchObject({ text: source, statements: [] });
		expect(printed.readOnly).toBeUndefined();
		expect(parsed.steps).toBeUndefined();
		expect(parsed.issues?.length).toBeGreaterThan(0);
	});
});
