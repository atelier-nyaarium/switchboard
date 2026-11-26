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
import { holesOver } from "../gateway/liveConsole/holes.js";
import { type ConsoleEntity, createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import { unknown } from "../shared/expressions.js";
import { lexConsole } from "../shared/live-console-grammar.js";
import type { AutomationTrigger } from "../shared/schemasAutomation.js";
import { ConsoleOpSchema } from "../shared/schemasConsoleOp.js";
import { ConsoleOpResultSchema } from "../shared/schemasConsoleResults.js";
import { FunctionSchema, type FunctionStep, FunctionStepSchema, type StepArg } from "../shared/schemasFunction.js";
import { ConsoleScriptParseResultSchema, ConsoleScriptPrintResultSchema } from "../shared/schemasScript.js";
import { scanHoles } from "../shared/text-holes.js";

const LAMP = "aa:bb:cc:dd:ee:01";
const FAN = "aa:bb:cc:dd:ee:02";
const OTHER_FAN = "aa:bb:cc:dd:ee:03";
const ODD = "aa:bb:cc:dd:ee:04";

/** Lamp, same-named fans, every naming case. */
const tables: ScriptTables = {
	switches: [
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
/** A text whose holes fill. */
const filled = (text: string): StepArg => ({ kind: "text", text });
const turn = (device: StepArg, verb = "on"): FunctionStep => ({
	kind: "do",
	action: "device_set",
	args: { device, verb: lit(verb) },
});
const tell = (message?: string): FunctionStep => ({
	kind: "do",
	action: "tell_assistant",
	args: { when: lit("now"), ...(message === undefined ? {} : { message: lit(message) }) },
});

const print = (steps: FunctionStep[]) => printScript(steps, tables).text;
const read = (source: string) => parseScript(source, tables);
const stepsOf = (source: string) => read(source).steps;
const spansOf = (source: string) => (read(source).issues ?? []).map((issue) => source.slice(issue.start, issue.end));

const CANONICAL: Record<string, FunctionStep[]> = {
	"every statement": [
		{ kind: "note", text: "Warm the room, then say so." },
		{ kind: "let", name: "label", value: filled("Room {device}") },
		{
			kind: "if",
			when: 'value < threshold and sensors.value("Hall", "humidity") > 60',
			steps: [turn(lit(LAMP)), { kind: "wait", minutes: lit(5) }],
			else: [
				{
					kind: "if",
					when: "value > 30",
					steps: [{ kind: "throw", text: "Too hot: {value}" }],
					else: [{ kind: "exit" }],
				},
			],
		},
		{
			kind: "try",
			steps: [
				{ kind: "do", action: "ifttt_trigger", args: { event: lit("lamp_on"), value1: lit("{device}") } },
				{ kind: "call", function: "fn-blink", values: { lamp: lit(LAMP), message: expr("label") } },
			],
			catch: [tell("It failed: {e}")],
		},
	],
	"values of each kind": [
		{ kind: "let", name: "count", value: lit(3) },
		{ kind: "let", name: "low", value: lit(-0.5) },
		{ kind: "let", name: "armed", value: lit(true) },
		{ kind: "let", name: "twice", value: expr("count * 2") },
		{ kind: "wait", minutes: expr("twice + 1") },
		{ kind: "throw" },
	],
	"a value left out, in the middle and at the end": [
		{ kind: "do", action: "ifttt_trigger", args: { event: lit("go"), value2: lit("second") } },
		tell(),
		{ kind: "call", function: "fn-own" },
	],
	"names that two hold, written by id": [turn(lit(FAN), "toggle"), { kind: "call", function: "fn-a" }],
	"a plug by a value, and one no longer held": [turn(expr("lamp"), "off"), turn(lit("aa:bb:cc:dd:ee:99"))],
	"a plug whose name holds a backslash, braces and quotes": [
		turn(lit(ODD)),
		{ kind: "call", function: "fn-blink", values: { lamp: lit(ODD), message: filled("kept \\\\ {value}") } },
	],
	"a value that reads null, beside one left out": [
		{ kind: "do", action: "ifttt_trigger", args: { event: lit("go"), value1: expr("(null)"), value3: lit("x") } },
		{ kind: "let", name: "nothing", value: expr("null") },
		{ kind: "call", function: "fn-blink", values: { message: expr("null") } },
	],
	"a text with quotes, a line break, a tab and escaped braces": [tell('He said "hi"\n\tnow \\{kept\\} \\\\ {value}')],
	"notes: several lines, an empty line, a leading space, and two in a row": [
		{ kind: "note", text: "first\n\n indented" },
		{ kind: "note", text: "second" },
		{ kind: "note", text: "" },
		{ kind: "exit" },
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
				{ kind: "note", text: "beside the rest" },
			],
		},
		{ kind: "parallel", steps: [] },
		{ kind: "exit" },
	],
	"an else that is not a lone if, and sides left empty": [
		{
			kind: "if",
			when: "armed",
			else: [{ kind: "if", when: "cold", steps: [{ kind: "exit" }] }, { kind: "exit" }],
		},
		{ kind: "if", when: "armed" },
		{ kind: "try", steps: [], catch: [] },
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
				"\texit",
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
			expect([parsed.statements, parsed.bindings]).toEqual([printed.statements, printed.bindings]);
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
			const reach = (held: { bindings: { name: string; start: number; end: number }[] }) =>
				held.bindings.map(({ name, start, end }) => [name, start, end]);
			expect({ seed, spans: [canonical.statements, reach(canonical)] }).toEqual({
				seed,
				spans: [first.statements, reach(first)],
			});
			expect({ seed, spans: [again.statements, again.bindings] }).toEqual({
				seed,
				spans: [second.statements, second.bindings],
			});
			expect(canonical.steps.every((step) => FunctionStepSchema.safeParse(step).success)).toBe(true);
			// The first round changes no text's meaning: each run and each hole reads as it did.
			expect({ seed, texts: meaningOf(canonical.steps) }).toEqual({ seed, texts: meaningOf(loose) });
		}
	});

	it("spans each step by its path, and offers a kept name after its line and e inside its catch", () => {
		const source = 'x = 1\nif (a) {\n\texit\n} else if (b) {\n\ty = x\n}\ntry {\n} catch (e) {\n\tthrow "{e}"\n}';
		const parsed = read(source);
		const cut = (span: { start: number; end: number }) => source.slice(span.start, span.end);

		expect((parsed.statements ?? []).map((held) => [held.step, cut(held).split("\n")[0]])).toEqual([
			["0", "x = 1"],
			["1", "if (a) {"],
			["1.0.0", "exit"],
			["1.1.0", "if (b) {"],
			["1.1.0.0.0", "y = x"],
			["2", "try {"],
			["2.1.0", 'throw "{e}"'],
		]);
		expect(parsed.bindings.map((held) => [held.name, cut(held).trim().split("\n")[0]])).toEqual([
			["x", "if (a) {"],
			["y", "}"],
			["e", "{"],
		]);
	});

	it("keeps a value's place under its step when a trailing comment becomes a note before it", () => {
		const source = 'exit\nassistant.tell("now", "{nowhere}") // why';
		const parsed = read(source);
		if (!parsed.steps) throw new Error("it parses");
		const hole = placeIssue(parsed, { step: "2", param: "message", start: 1, end: 8 });

		expect(parsed.steps.map((step) => step.kind)).toEqual(["exit", "note", "do"]);
		expect(hole && source.slice(hole.start, hole.end)).toBe("nowhere");
	});

	it("refuses a body past a function's bounds at the first step over, and a value too long", () => {
		const many = Array.from({ length: 9 }, (_, index) => `x${index} = ${index}`).join("\n");
		const deep = "if (a) {\nif (a) {\nif (a) {\nif (a) {\nexit\n}\n}\n}\n}";
		const wide = Array.from(
			{ length: 5 },
			() => `if (a) {\n${Array.from({ length: 7 }, () => "exit").join("\n")}\n}`,
		).join("\n");
		const long = `x = "${"a".repeat(1001)}"`;

		expect(spansOf(many)).toEqual(["x8 = 8"]);
		expect(spansOf(deep)).toEqual(["exit"]);
		expect(read(wide).issues).toMatchObject([{ start: wide.lastIndexOf("if (a) {") }]);
		expect(spansOf(long)).toEqual([long.slice(4)]);
		expect(spansOf("x = 9".padEnd(700, "9"))).toEqual(["9".repeat(696)]);
	});

	it("writes two spellings of one meaning one way, and what it reads back is stable", () => {
		const loose: FunctionStep[] = [
			{ kind: "let", name: "a", value: expr("  count +\n 1 ") },
			{ kind: "let", name: "b", value: lit("plain {braces} \\ x") },
			{ kind: "let", name: "c", value: lit("on") },
			tell("lone \\ backslash"),
			{ kind: "if", when: " armed ", steps: [], else: [] },
			{ kind: "note", text: "one\r\ntwo" },
		];
		const canonical = stepsOf(print(loose)) as FunctionStep[];

		expect(canonical).toEqual([
			{ kind: "let", name: "a", value: expr("count +  1") },
			// A literal is as written, so it prints escaped and reads back as a text that fills nothing.
			{ kind: "let", name: "b", value: filled("plain \\{braces\\} \\\\ x") },
			{ kind: "let", name: "c", value: lit("on") },
			tell("lone \\\\ backslash"),
			{ kind: "if", when: "armed" },
			{ kind: "note", text: "one\ntwo" },
		]);
		expect(stepsOf(print(canonical))).toEqual(canonical);
	});

	it("keeps an expression an expression, though it is one literal or names a plug", () => {
		const held: FunctionStep[] = [
			{ kind: "let", name: "a", value: expr("5") },
			{ kind: "let", name: "b", value: expr('"plain {braces}"') },
			{ kind: "let", name: "c", value: expr("-2") },
			{ kind: "let", name: "d", value: expr("null") },
			{ kind: "wait", minutes: expr('"5"') },
			turn(expr('"Desk lamp"')),
			{ kind: "do", action: "tell_assistant", args: { when: lit("now"), message: expr("5") } },
			{ kind: "do", action: "ifttt_trigger", args: { event: lit("go"), value1: expr("null"), value3: lit("x") } },
		];
		const settled = stepsOf(print(held)) as FunctionStep[];

		expect(print(held).split("\n")).toEqual([
			"a = (5)",
			'b = ("plain {braces}")',
			"c = (-2)",
			"d = null",
			'wait(("5"))',
			'devices.set(("Desk lamp"), "on")',
			'assistant.tell("now", (5))',
			'ifttt.trigger("go", (null), null, "x")',
		]);
		expect(
			settled.flatMap((step) => Object.values("args" in step ? step.args : {}).map((arg) => arg.kind)),
		).toEqual(["expression", "literal", "literal", "expression", "literal", "expression", "literal"]);
		expect(stepsOf(print(settled))).toEqual(settled);
	});

	it("writes a string that is no text as it is, and a text's own escapes only in a text", () => {
		const odd = print([turn(lit(ODD)), tell("a \\{b\\} {value}")]).split("\n");

		expect(odd).toEqual([
			'devices.set("Odd \\\\ {name} \\"x\\"", "on")',
			'assistant.tell("now", "a \\{b\\} {value}")',
		]);
		expect(stepsOf('ifttt.trigger("a\\\\b", "c\\\\d \\{e\\}")')).toEqual([
			{ kind: "do", action: "ifttt_trigger", args: { event: lit("a\\b"), value1: lit("c\\\\d \\{e\\}") } },
		]);
		expect(
			stepsOf('x = "a {b}"\ny = "plain"\nfunctions.run("Blink", {message: "\\{kept\\}", lamp: "Desk lamp"})'),
		).toEqual([
			{ kind: "let", name: "x", value: filled("a {b}") },
			{ kind: "let", name: "y", value: lit("plain") },
			{ kind: "call", function: "fn-blink", values: { lamp: lit(LAMP), message: filled("\\{kept\\}") } },
		]);
	});

	it("reads only what would not read back: a value past its cap as text, a filled text an action holds, a value a function does not take", () => {
		const grown = tell("a\\b".repeat(333));
		const inAction: FunctionStep = {
			kind: "do",
			action: "tell_assistant",
			args: { when: lit("now"), message: filled("{x}") },
		};
		const stray: FunctionStep = { kind: "call", function: "fn-a", values: { nope: lit(1) } };
		const long = Array.from({ length: 30 }, (): FunctionStep => tell("x".repeat(999)));

		expect([grown, inAction, stray].map((step) => printScript([step], tables).readOnly !== undefined)).toEqual([
			true,
			true,
			true,
		]);
		expect(printScript(long, tables)).toMatchObject({ text: "", statements: [], bindings: [] });
		expect(printScript(long, tables).readOnly).toBeDefined();
		expect(spansOf('functions.run("Twin", {nope: 1})\nfunctions.run("fn-a", {nope: 1})')).toEqual([
			'"Twin"',
			"nope",
		]);
	});

	it("keeps a hole's expression as written, through its strings' own escapes and a carriage return", () => {
		const hole = tell('{"a\\nb"} and {x == "}"}');
		const crlf: FunctionStep = { kind: "if", when: '"a\r\nb" == "a\\nb"', steps: [{ kind: "exit" }] };
		const back = stepsOf(print([hole, crlf])) as FunctionStep[];
		const strings = (source: string) =>
			lexConsole(source)
				.filter((token) => token.kind === "string")
				.map((token) => token.value);

		expect(back[0]).toEqual(hole);
		expect(back[1]?.kind === "if" && strings(back[1].when)).toEqual(["a\r\nb", "a\nb"]);
	});

	it("places an offset on the whole escape it names, and holds one past the value to the value", () => {
		const source = 'x = "\\n{nowhere}"';
		const parsed = read(source);
		if (!parsed.steps) throw new Error("it parses");
		const cut = (start: number, end: number) => {
			const at = placeIssue(parsed, { step: "0", param: "value", start, end });
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
		const source = "// abc\r\n// def\r\nx = (1 +\r\n  bogus.thing)\r\nexit\r\n";
		const parsed = read(source);
		if (!parsed.steps) throw new Error("it parses");
		const where = placeIssue(parsed, { step: "1", param: "value", start: 8, end: 13 });

		expect(parsed.steps).toEqual([
			{ kind: "note", text: "abc\ndef" },
			{ kind: "let", name: "x", value: expr("(1 +    bogus.thing)") },
			{ kind: "exit" },
		]);
		expect(where && source.slice(where.start, where.end)).toBe("bogus");
		expect(stepsOf(print(parsed.steps))).toEqual(parsed.steps);
	});

	it("reads a plug or a function by its name, and either quote", () => {
		expect(stepsOf("devices.set('Desk lamp', \"off\")\nfunctions.run(\"Blink\", {lamp: 'Desk lamp'})")).toEqual([
			turn(lit(LAMP), "off"),
			{ kind: "call", function: "fn-blink", values: { lamp: lit(LAMP) } },
		]);
		expect(stepsOf(`devices.set("${OTHER_FAN}", "on")`)).toEqual([turn(lit(OTHER_FAN))]);
	});

	it("turns a comment after a statement into a note before it, and one line after another into one note", () => {
		expect(stepsOf("// a\n// b\n\n// c\nexit // done\nif (armed) { // why\n\texit\n}")).toEqual([
			{ kind: "note", text: "a\nb" },
			{ kind: "note", text: "c" },
			{ kind: "note", text: "done" },
			{ kind: "exit" },
			{ kind: "if", when: "armed", steps: [{ kind: "note", text: "why" }, { kind: "exit" }] },
		]);
	});

	it("refuses what it cannot keep, with the span it means, and carries on to the next line", () => {
		expect(spansOf('devices.set("Fan", "on")\nfunctions.run("Twin")\nfunctions.run("Nobody")\nexit')).toEqual([
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
		expect(spansOf("if armed {\n}\nelse {\n}\ntry {\n}\nawait x")).toEqual(["armed", "else", "try", "await"]);
		expect(spansOf("if (armed) {\n\texit")).toEqual(["if"]);
		expect(spansOf("}\nexit")).toEqual(["}"]);
		expect(spansOf('f(a, // one\n b)\nifttt.trigger("a", "b", "c", "d", "e")\nthrow 5\nwait()')).toEqual([
			"// one",
			'ifttt.trigger("a", "b", "c", "d", "e")',
			"5",
			"()",
		]);
		expect(spansOf("x = (1 +")).toHaveLength(1);
	});

	it("reads only a step a script cannot write, and a call to a function not held", () => {
		const kept = { kind: "do", action: "device_set", as: "result", args: { device: lit(LAMP), verb: lit("on") } };
		const unknown = { kind: "do", action: "launch_rocket", args: {} };
		const gone = { kind: "call", function: "fn-gone" };

		expect(
			[kept, unknown, gone].map((step) => printScript([step as FunctionStep], tables).readOnly !== undefined),
		).toEqual([true, true, true]);
		expect(printScript([unknown as FunctionStep, { kind: "exit" }], tables).text.split("\n")[1]).toBe("exit");
	});

	it("reads only a stored name the language took, and quotes such a name where a call gives it", () => {
		const taken = ["wait", "all", "and", "true"].map((name) =>
			printScript([{ kind: "let", name, value: lit(1) }], tables),
		);
		const given: FunctionStep = { kind: "call", function: "fn-old", values: { and: lit(1), wait: lit(2) } };

		expect(taken.map((printed) => printed.readOnly !== undefined)).toEqual([true, true, true, true]);
		expect(print([given])).toBe('functions.run("Old names", {"and": 1, wait: 2})');
		expect(stepsOf(print([given]))).toEqual([given]);
	});

	it("places a save's refusal in the script, through a text's escapes", () => {
		const source = 'exit\nassistant.tell("now", "a\\"b {nowhere}")';
		const parsed = read(source);
		if (!parsed.steps) throw new Error("it parses");
		// The text is `a"b {nowhere}`: the name sits at 5 to 12.
		const hole = placeIssue(parsed, { step: "1", param: "message", start: 5, end: 12 });
		const whole = placeIssue(parsed, { step: "1", param: "when" });
		const statement = placeIssue(parsed, { step: "0" });

		expect([hole, whole, statement].map((span) => span && source.slice(span.start, span.end))).toEqual([
			"nowhere",
			'"now"',
			"exit",
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
	"{open",
];
const EXPRESSIONS = [
	"count + 1",
	"value > 3 and armed",
	'sensors.value("Hall", "x // y")',
	"[1, 2]",
	"{a: 1}.a",
	'"text {value}"',
	"'single'",
	"5",
	"-2",
	"true",
	"null",
	"(null)",
	"count\n+ 1",
	'"two\nlines"',
	"!armed or count == 2",
	"items[0]",
	"  spaced  ",
];
const NAMES = ["count", "label", "armed", "x1", "items"];
const VERBS = ["on", "off", "toggle"];

function drawn(seed: number): FunctionStep[] {
	const draw = drawer(seed);
	const text = () => Array.from({ length: draw.int(6) }, () => draw.pick(PIECES)).join("");
	const value = (): StepArg =>
		draw.pick<() => StepArg>([
			() => lit(text()),
			() => lit(draw.int(2000) / 8 - 100),
			() => lit(draw.chance(0.5)),
			() => expr(draw.pick(EXPRESSIONS)),
		])();
	const device = (): StepArg => draw.pick([lit(LAMP), lit(FAN), lit(ODD), lit("aa:bb:cc:dd:ee:99"), expr("room")]);
	let left = 24;
	const list = (depth: number, most: number): FunctionStep[] =>
		Array.from({ length: draw.int(most + 1) }, () => step(depth)).filter((held) => held !== null);
	const step = (depth: number): FunctionStep | null => {
		if (left-- <= 0) return null;
		const nested = depth < 3;
		return draw.pick<() => FunctionStep>([
			() => ({ kind: "note", text: text() }),
			() => ({ kind: "let", name: draw.pick(NAMES), value: value() }),
			() => ({ kind: "exit" }),
			() => (draw.chance(0.3) ? { kind: "throw" } : { kind: "throw", text: text() }),
			() => ({ kind: "wait", minutes: draw.pick([lit(5), lit(0.25), expr("count * 2")]) }),
			() => turn(device(), draw.pick(VERBS)),
			() => (draw.chance(0.4) ? tell() : tell(text())),
			() => ({
				kind: "do",
				action: "ifttt_trigger",
				args: {
					event: draw.pick([lit("go"), lit(text() || "e"), expr("label")]),
					...(draw.chance(0.5) ? { value1: value() } : {}),
					...(draw.chance(0.3) ? { value3: value() } : {}),
				},
			}),
			() => ({
				kind: "call",
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
					? { kind: "if", when: draw.pick(EXPRESSIONS), steps: list(depth + 1, 3), else: list(depth + 1, 2) }
					: { kind: "exit" },
			() => (nested ? { kind: "try", steps: list(depth + 1, 3), catch: list(depth + 1, 2) } : { kind: "exit" }),
			() => (nested ? { kind: "parallel", steps: list(depth + 1, 3) } : { kind: "exit" }),
		])();
	};
	return list(1, 7);
}

/** What each text says: its runs as they fill, its holes as written. */
function meaningOf(steps: readonly FunctionStep[]): unknown[] {
	const said = (text: string) =>
		scanHoles(text).map((part) => (part.kind === "text" ? ["run", part.text] : ["hole", part.source, part.closed]));
	const value = (arg: StepArg): unknown => {
		if (arg.kind === "expression") return ["expression"];
		if (arg.kind === "text") return said(arg.text);
		// A literal is one run, as written.
		return typeof arg.value === "string" && arg.value !== ""
			? [["run", arg.value]]
			: typeof arg.value === "string"
				? []
				: arg.value;
	};
	return steps.flatMap((step): unknown[] => {
		switch (step.kind) {
			case "do":
				// An action's literal string is its text.
				return Object.values(step.args).map((arg) =>
					arg.kind === "literal" && typeof arg.value === "string" ? said(arg.value) : value(arg),
				);
			case "throw":
				return step.text === undefined ? [] : [said(step.text)];
			case "let":
				return [value(step.value)];
			case "call":
				return Object.values(step.values ?? {}).map(value);
			case "if":
				return [...meaningOf(step.steps ?? []), ...meaningOf(step.else ?? [])];
			case "try":
				return [...meaningOf(step.steps), ...meaningOf(step.catch)];
			case "parallel":
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
		dataDir: dir,
		newIncarnation: () => `a${++n}`,
		now: () => 1_000,
		input: () => ({ type: { type: "number", integral: false }, value: unknown("not heard") }),
		offers: () => ({ numbers: [], switches: [{ device: LAMP, name: "Desk lamp" }] }),
		previewEvent: async () => ({ events: [] }) as never,
		scriptVocabulary: () => REGISTRY.projection("script"),
		automations: {
			isHome: () => true,
			eventIssue: () => null,
			eventFields: () => ["reason"],
			entropy: (size) => crypto.randomBytes(size),
			holes: () => holesOver(REGISTRY),
			actions: {
				ready: () => true,
				switchName: (device) => (device === LAMP ? "Desk lamp" : null),
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
		{ kind: "let", name: "humid", value: expr('sensors.value("Hall", "humidity")') },
		{ kind: "let", name: "damp", value: expr("humid > 60 and value < threshold") },
		{ kind: "let", name: "first", value: expr("sensors.list[0].name") },
		{
			kind: "try",
			steps: [turn(lit(LAMP))],
			catch: [{ kind: "let", name: "why", value: expr("e.message") }, tell("{why}")],
		},
		{ kind: "let", name: "humid", value: lit("gone") },
		{ kind: "let", name: "odd", value: expr("damp[0]") },
		{ kind: "let", name: "joined", value: expr('first + " here"') },
		{ kind: "let", name: "said", value: filled("{humid} now") },
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
			["value", "Number", 0, end],
			["device", "Text", 0, end],
			["measure", "Text", 0, end],
			["threshold", "Number", 0, end],
			["room", "Device", 0, end],
			["humid", "Number", at('"humidity")'), at('humid = "gone"')],
			["damp", "Truth", at("< threshold"), end],
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
			{ kind: "call", function: "fn-old" },
			{ kind: "call", function: "fn-new", values: { lamp: lit(LAMP) } },
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
			text: 'exit\nassistant.tell("now", "{nowhere}")',
			place: { step: "1", param: "message", start: 1, end: 8 },
		});

		expect(broken.steps).toBeUndefined();
		expect(broken.issues).toHaveLength(1);
		expect(broken.statements).toEqual([]);
		expect(broken.names.map((held) => held.name)).toEqual(["value", "device", "measure", "threshold", "kept"]);
		expect(
			parse({ text: "x = event.reason", trigger: { kind: "event", source: "github", conditions: [] } }),
		).toMatchObject({
			names: [{ name: "event", type: "Event" }, { name: "source" }, { name: "x", type: "Text" }],
			types: [
				{ name: "Error" },
				{ name: "Event", members: [{ name: "id" }, { name: "title" }, { name: "url" }, { name: "reason" }] },
			],
		});
		expect(placed.placed).toEqual({ start: 29, end: 36 });
		expect(parse({ text: "exit", place: { step: "4" } }).placed).toBeUndefined();
	});

	it("answers what a save would refuse of the steps, where it sits in the text", () => {
		const { parse } = stage();
		const cutOf = (text: string) =>
			(parse({ text }).issues ?? []).map((issue) => [text.slice(issue.start, issue.end)]);

		expect(cutOf('exit\nassistant.tell("now", "a\\"b {nowhere}")')).toEqual([["nowhere"]]);
		expect(cutOf('x = 1\nif (devices.set("Desk lamp", "on")) {\n}').flat()).toEqual(["devices.set"]);
		expect(cutOf('devices.set("aa:bb:cc:dd:ee:99", "on")').flat()).toEqual(['"aa:bb:cc:dd:ee:99"']);
		expect(cutOf('devices.set("Desk lamp", "sideways")').flat()).toEqual(['"sideways"']);
		expect(cutOf("exit\nsensors = 1").flat()).toEqual(["sensors"]);
		expect(parse({ text: 'devices.set("Desk lamp", "sideways")' }).steps).toHaveLength(1);
		expect(cutOf('devices.set("Desk lamp", "on")\nwait(5)')).toEqual([]);
	});

	it("says a printed step it cannot write back reads only, and still spans each step", () => {
		const { print } = stage();
		const printed = print({
			steps: [{ kind: "do", action: "device_set", as: "result", args: {} }, { kind: "exit" }],
		});

		expect(printed.readOnly).toBeDefined();
		expect(printed.statements.map((held) => held.step)).toEqual(["0", "1"]);
	});
});
