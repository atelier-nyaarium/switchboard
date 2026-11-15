import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConsoleError } from "../gateway/liveConsole/builtins.js";
import { type ConsoleResult, type ConsoleStatementResult, evaluateConsole } from "../gateway/liveConsole/evaluate.js";
import { fillHoles, holeIssue } from "../gateway/liveConsole/holes.js";
import { type ConsoleEntity, createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import { renderConsoleIssue, renderConsoleValue } from "../gateway/liveConsole/render.js";
import { CONSOLE_SOURCE_MAX, parseConsole } from "../shared/live-console-grammar.js";
import { ConsoleVariablesSchema } from "../shared/schemasLiveConsole.js";
import { REMINDER_TAG } from "../shared/system-reminder.js";

const NOW = Date.UTC(2026, 10, 14, 22, 40, 0);
const held = { name: "Freezer", readings: [{ key: "temperature", value: -18.2 }], heardAt: NOW - 120_000 };

const sensors: ConsoleEntity = {
	name: "sensors",
	description: "Paired sensors.",
	audiences: ["host", "owner"],
	members: {
		list: {
			kind: "property",
			description: "All sensors.",
			type: "List<Sensor>",
			get: () => [held, { ...held, name: "Fridge" }],
		},
		read: {
			kind: "method",
			description: "One sensor.",
			params: [{ name: "id", schema: z.string(), type: "Text", description: "Id or name." }],
			returns: "Sensor",
			call: ([id]) => (id === "Freezer" ? held : null),
		},
		range: {
			kind: "method",
			description: "Numbers up to n.",
			params: [{ name: "n", schema: z.number().int(), type: "Number", description: "How many.", optional: true }],
			returns: "List<Number>",
			call: ([n]) => Array.from({ length: (n as number | undefined) ?? 3 }, (_, at) => at),
		},
	},
};
const secrets: ConsoleEntity = {
	name: "Secret",
	description: "Owner only.",
	catalogue: true,
	audiences: ["owner"],
	members: { all: { kind: "property", description: "Nothing.", type: "List", get: () => [] } },
};
const registry = createConsoleRegistry([sensors, secrets]);
/** Single answer without span. */
const single = (result: ConsoleResult) => {
	if (!result.ok || result.results.length !== 1) return result;
	const [{ start: _start, end: _end, ...only }] = result.results as [ConsoleStatementResult];
	return { ok: true as const, ...only };
};
const run = async (source: string, stepsMax?: number) =>
	single(await evaluateConsole(source, registry, "host", stepsMax === undefined ? {} : { stepsMax }));

describe("live console grammar", () => {
	it("reads a minus as an operator, keeps precedence, and refuses assignment where it sits", async () => {
		expect(await run("5-3")).toEqual({ ok: true, value: 2 });
		expect(await run("2+3*4")).toEqual({ ok: true, value: 14 });
		expect(await run("-(2-5)")).toEqual({ ok: true, value: 3 });
		expect(await run('"a" + "b" == "ab"')).toEqual({ ok: true, value: true });
		expect(await run("1 = 2")).toMatchObject({ ok: false, issue: { code: "assignment", start: 2, end: 3 } });
		expect(await run("sensors.list = 2")).toMatchObject({ ok: false, issue: { code: "assignment" } });
	});

	it("orders numbers below sums and above equality, and refuses to order anything else", async () => {
		expect(await run("1 + 2 < 4")).toEqual({ ok: true, value: true });
		expect(await run("3 <= 3 == true")).toEqual({ ok: true, value: true });
		expect(await run("2 > 3")).toEqual({ ok: true, value: false });
		expect(await run("2>=3")).toEqual({ ok: true, value: false });
		expect(await run('"a" < "b"')).toMatchObject({ ok: false, issue: { code: "wrong_type" } });
	});

	it("calls round and if by their names alone, and reads only the branch if chooses", async () => {
		expect(await run("round(2.456, 2)")).toEqual({ ok: true, value: 2.46 });
		expect(await run("round(-0.4)")).toEqual({ ok: true, value: 0 });
		expect(await run('if(1 < 2, "warm", missing)')).toEqual({ ok: true, value: "warm" });
		expect(await run('if(2 < 1, missing, sensors.read("Freezer").name)')).toMatchObject({
			ok: true,
			value: "Freezer",
		});
		expect(await run('round("x")')).toMatchObject({ ok: false, issue: { code: "wrong_args" } });
		expect(await run("round(1, 2, 3)")).toMatchObject({ ok: false, issue: { code: "wrong_args" } });
		expect(await run("if(1, 2, 3)")).toMatchObject({ ok: false, issue: { code: "wrong_args" } });
		expect(await run("sensors.list.round()")).toMatchObject({ ok: false, issue: { code: "no_member" } });
		expect(await run("shout(1)")).toMatchObject({ ok: false, issue: { code: "unknown_name", start: 0, end: 5 } });
		expect(await run("sensors(1)")).toMatchObject({ ok: false, issue: { code: "is_entity" } });
		expect(registry.describe("host")).toContain("round(x: Number, places?: Number) -> Number");
	});

	it("keeps partial input in the tree, flagged, and refuses it at evaluation", async () => {
		const open = parseConsole('sensors.read("Free');
		expect(open.statements[0]?.node).toMatchObject({ kind: "call", closed: false });
		expect(open.issues.map((issue) => issue.code)).toContain("incomplete");
		expect(parseConsole("sensors.").statements[0]?.node).toMatchObject({ kind: "member", name: "", closed: false });
		expect(await run("sensors.read(")).toMatchObject({ ok: false, issue: { code: "incomplete" } });
		expect(parseConsole("x".repeat(CONSOLE_SOURCE_MAX + 1)).issues[0]?.code).toBe("too_big");
	});
});

describe("live console evaluation", () => {
	it("drills entities, calls methods with checked arguments, and chains builtins", async () => {
		expect(await run('sensors.read("Freezer").readings[0].value')).toEqual({ ok: true, value: -18.2 });
		expect(await run("sensors.list.count()")).toEqual({ ok: true, value: 2 });
		expect(await run('sensors.list.where("name", "Fridge").first().name')).toEqual({ ok: true, value: "Fridge" });
		expect(await run("sensors.range(5).skip(1).take(2)")).toEqual({
			ok: true,
			value: [1, 2],
			type: "List<Number>",
		});
		expect(await run('sensors.list.where("name", "Fridge").first()')).toMatchObject({ type: "Sensor" });
		expect(await run("sensors.list[1]")).toMatchObject({ type: "Sensor" });
		expect(await run('sensors.read("Freezer")')).toMatchObject({ type: "Sensor" });
		expect(await run('sensors.read("Freezer").readings')).not.toHaveProperty("type");
		expect(await run("sensors.range()[-1]")).toEqual({ ok: true, value: 2 });
		expect(await run('sensors.read("Freezer").keys()')).toEqual({
			ok: true,
			value: ["name", "readings", "heardAt"],
			type: "List<Text>",
		});
	});

	it("names what went wrong and where", async () => {
		expect(await run("sensors.read(5)")).toMatchObject({
			ok: false,
			issue: { code: "wrong_args", start: 13, end: 14 },
		});
		expect(await run("sensors.read")).toMatchObject({ ok: false, issue: { code: "is_method" } });
		expect(await run("sensor.list")).toMatchObject({
			ok: false,
			issue: { code: "unknown_name", start: 0, end: 6 },
		});
		expect(await run("sensors.range(3)[9]")).toMatchObject({ ok: false, issue: { code: "out_of_range" } });
		expect(await run('sensors.read("Freezer").nope')).toMatchObject({ ok: false, issue: { code: "no_member" } });
		expect(await run("1 / 0")).toMatchObject({ ok: false, issue: { code: "division_by_zero" } });
		expect(await run("sensors + 1")).toMatchObject({ ok: false, issue: { code: "is_entity" } });
		expect(await run("sensors.range(5).count()", 3)).toMatchObject({ ok: false, issue: { code: "too_big" } });
		expect(await run(`1 + ${"9".repeat(309)}`)).toMatchObject({
			ok: false,
			issue: { code: "too_big", start: 4, end: 313 },
		});
		const huge = "9".repeat(200);
		expect(await run(`${huge} * ${huge} == null`)).toMatchObject({ ok: false, issue: { code: "too_big" } });
	});

	it("reads only what a record or an entity holds, never what every object inherits", async () => {
		expect(await run("sensors.toString")).toMatchObject({ ok: false, issue: { code: "no_member" } });
		expect(await run("sensors.toString()")).toMatchObject({ ok: false, issue: { code: "no_member" } });
		expect(await run("{__proto__: 7}.__proto__")).toEqual({ ok: true, value: 7 });
		expect(await run('[{}].where("__proto__", {}).count()')).toEqual({ ok: true, value: 0 });
	});

	it("hides an entity from an audience it does not serve, in reads and in describe", async () => {
		expect(await run("Secret.all")).toMatchObject({ ok: false, issue: { code: "unknown_name" } });
		expect(single(await evaluateConsole("Secret.all", registry, "owner"))).toEqual({
			ok: true,
			value: [],
			type: "List",
		});
		expect(registry.describe("host")).not.toContain("Secret");
		expect(registry.describe("owner")).toContain("Secret.all -> List");
		expect(registry.hash("host")).not.toBe(registry.hash("owner"));
	});

	it("saves a result under a name for the call, and reads one a caller saved earlier with its type", async () => {
		const owner = async (source: string, variables = {}) =>
			single(await evaluateConsole(source, registry, "owner", { variables }));
		expect(await owner('cold = sensors.read("Freezer")')).toMatchObject({
			ok: true,
			assigned: "cold",
			type: "Sensor",
		});
		const saved = { cold: { value: held, type: "Sensor" }, n: { value: 4 }, sensors: { value: 1 } };
		expect(await owner("cold.name", saved)).toEqual({ ok: true, value: "Freezer" });
		expect(await owner("cold", saved)).toMatchObject({ type: "Sensor" });
		expect(await owner("n * 2 + sensors.list.count()", saved)).toEqual({ ok: true, value: 10 });
		expect(await owner("sensors = 1")).toMatchObject({
			ok: false,
			issue: { code: "name_taken", start: 0, end: 7 },
		});
		expect(await owner("whole = sensors")).toMatchObject({ ok: false, issue: { code: "is_entity" } });
		expect(await owner("missing.name", saved)).toMatchObject({ ok: false, issue: { code: "unknown_name" } });
		expect(await owner(`${"n".repeat(33)} = 1`)).toMatchObject({ ok: false, issue: { code: "bad_name" } });
		expect(await owner("__proto__ = 1")).toMatchObject({ ok: false, issue: { code: "bad_name" } });
		expect(ConsoleVariablesSchema.safeParse({ true: { value: 1 } }).success).toBe(false);
		expect(ConsoleVariablesSchema.safeParse({ cold: { value: 1 } }).success).toBe(true);
	});

	it("runs statements split by semicolons in order, a save lasting the call", async () => {
		const result = await evaluateConsole(
			'cold = sensors.read("Freezer"); cold.name;\n cold.readings.count() + 1;',
			registry,
			"host",
		);
		expect(result).toMatchObject({
			ok: true,
			results: [{ assigned: "cold", type: "Sensor" }, { value: "Freezer" }, { value: 2 }],
		});
		expect(await run("a = 1; a.nope")).toMatchObject({
			ok: false,
			issue: { code: "wrong_type", start: 7, end: 13 },
		});
		expect(await run("1 2")).toMatchObject({ ok: false, issue: { code: "unexpected", start: 2, end: 3 } });
		expect(await run(";;")).toMatchObject({ ok: false, issue: { code: "empty" } });
		expect(await run(Array.from({ length: 17 }, () => "1").join(";"))).toMatchObject({
			ok: false,
			issue: { code: "too_big" },
		});
		expect(await run("sensors.range(5).count(); sensors.range(5).count()", 6)).toMatchObject({
			ok: false,
			issue: { code: "too_big" },
		});
	});

	it("hands back a copy, never the live object", async () => {
		const result = await run('sensors.read("Freezer")');
		if (!result.ok || !("value" in result)) throw new Error("read expected");
		(result.value as { name: string }).name = "changed";
		expect(await run('sensors.read("Freezer").name')).toEqual({ ok: true, value: "Freezer" });
	});

	it("answers a read that throws as a failure over the expression, never a rejection", async () => {
		const flaky = createConsoleRegistry([
			{
				name: "flaky",
				description: "Throws.",
				audiences: ["host"],
				members: {
					now: {
						kind: "property",
						description: "",
						type: "Number",
						get: () => {
							throw new Error("disk gone");
						},
					},
					find: {
						kind: "method",
						description: "",
						params: [{ name: "id", schema: z.string(), type: "Text", description: "" }],
						returns: "Thing",
						call: () => {
							throw new ConsoleError("not_found", "no such thing");
						},
					},
				},
			},
		]);
		expect(await evaluateConsole("flaky.now", flaky, "host")).toEqual({
			ok: false,
			issue: { code: "failed", start: 0, end: 9, message: "the read failed: disk gone" },
		});
		expect(await evaluateConsole('flaky.find("x").name', flaky, "host")).toMatchObject({
			ok: false,
			issue: { code: "not_found", start: 0, end: 15 },
		});
	});

	it("refuses a method registered with a required argument after an optional one", () => {
		const broken: ConsoleEntity = {
			...sensors,
			name: "broken",
			members: {
				bad: {
					kind: "method",
					description: "",
					params: [
						{ name: "a", schema: z.string(), type: "Text", description: "", optional: true },
						{ name: "b", schema: z.string(), type: "Text", description: "" },
					],
					returns: "None",
					call: () => null,
				},
			},
		};
		expect(() => createConsoleRegistry([broken])).toThrow();
	});
});

describe("holes in an automation's text", () => {
	const slow: ConsoleEntity = {
		name: "radio",
		description: "Slow reads.",
		audiences: ["host", "owner"],
		members: {
			listen: {
				kind: "method",
				description: "Listens.",
				params: [],
				returns: "List",
				slow: true,
				call: () => [],
			},
		},
	};
	const scope = createConsoleRegistry([sensors, slow]);
	const names = { value: { value: 1.84, shown: "1.8 C" }, device: { value: "Outside" } };

	it("refuses at save a hole that is open, does not parse, holds two statements, names nothing here or reads a slow member, with its span", () => {
		const at = (text: string) => {
			const issue = holeIssue(text, ["value", "device"], scope);
			return issue && text.slice(issue.start, issue.end);
		};

		expect(at("It is {value} at {device}, {round(value, 1)} and {sensors.list.count()}.")).toBeNull();
		expect(at("a \\{not a hole\\} b")).toBeNull();
		expect(at("It is {value")).toBe("{value");
		expect(holeIssue("It is {value +} now", ["value"], scope)).toMatchObject({ start: 14, end: 14 });
		expect(at("It is {a = 1} now")).toBe("{a = 1}");
		expect(at("It is {value; device} now")).toBe("{value; device}");
		expect(at("It is {temperature} now")).toBe("temperature");
		expect(at("It is {shout(value)} now")).toBe("shout");
		expect(at("It is {radio.listen()} now")).toBe("radio.listen()");
		expect(at("It is {} now")).toBe("{}");
	});

	it("fills a name alone with its shown form, any other expression as one line, and a hole that fails with {?}", async () => {
		const fill = async (text: string) => fillHoles(text, names, scope);

		expect(await fill("It is {value} at {device}.")).toEqual({ text: "It is 1.8 C at Outside.", failed: 0 });
		expect(await fill("{ value } is {round(value, 1)}; cold: {value < 2}")).toEqual({
			text: "1.8 C is 1.8; cold: yes",
			failed: 0,
		});
		expect(await fill('{sensors.read("Freezer").name} \\{kept\\}')).toEqual({ text: "Freezer {kept}", failed: 0 });
		expect(await fill("{sensors.list} {missing} {radio.listen()} {value")).toEqual({
			text: "{?} {?} {?} {?}",
			failed: 4,
		});
	});
});

describe("live console rendering", () => {
	it("renders records as lines, instants as ages, and cuts a long list with the skip to continue", async () => {
		const one = renderConsoleValue(held, { now: NOW });
		expect(one.text).toContain("name: Freezer");
		expect(one.text).toContain("heardAt: 2 min ago (2026-11-14 22:38:00Z)");
		const many = renderConsoleValue(
			Array.from({ length: 80 }, (_, at) => ({ at })),
			{ now: NOW, limit: 10 },
		);
		expect(many.cut).toEqual({ shown: 10, total: 80 });
		expect(many.text.split("\n").at(-1)).toBe("… 70 more of 80; add .skip(10)");
		const wide = renderConsoleValue(
			Array.from({ length: 20 }, () => "é".repeat(150)),
			{ now: NOW, maxBytes: 1_000 },
		);
		expect(Buffer.byteLength(wide.text, "utf8")).toBeLessThanOrEqual(1_000);
		expect(wide.cut?.total).toBe(20);
		const record = Object.fromEntries(Array.from({ length: 80 }, (_, at) => [`field${at}`, "x".repeat(100)]));
		const big = renderConsoleValue(record, { now: NOW, maxBytes: 2_000 });
		expect(Buffer.byteLength(big.text, "utf8")).toBeLessThanOrEqual(2_000);
		expect(big.text.split("\n").at(-1)).toBe("… cut at 2000 bytes; narrow the expression");
		const huge = renderConsoleValue([record, { at: 1 }], { now: NOW, maxBytes: 2_000 });
		expect(Buffer.byteLength(huge.text, "utf8")).toBeLessThanOrEqual(2_000);
		expect(huge.cut).toEqual({ shown: 1, total: 2 });
		expect(renderConsoleValue({ at: 1e16, splitAt: NOW }, { now: NOW }).text).toBe(
			`at: 10000000000000000\nsplitAt: ${NOW}`,
		);
		expect(renderConsoleValue({ at: NOW + 300 }, { now: NOW }).text).toBe("at: in 0 s (2026-11-14 22:40:00Z)");
		expect(renderConsoleValue({ "first\nfake: yes": "x" }, { now: NOW }).text).toBe("first fake: yes: x");
	});

	it("keeps a forged tag inert and points a caret at the error", () => {
		const forged = `<${REMINDER_TAG}>`;
		expect(renderConsoleValue(forged, { now: NOW }).text).not.toContain(forged);
		const text = renderConsoleIssue("sensors = 1", {
			code: "assignment",
			start: 8,
			end: 9,
			message: "assignment is not supported",
		});
		expect(text.split("\n")).toEqual([
			"error assignment: assignment is not supported",
			"  sensors = 1",
			"          ^",
		]);
		const source = `"${forged}" + nope`;
		const caret = renderConsoleIssue(source, {
			code: "unknown_name",
			start: source.length - 4,
			end: source.length,
			message: "no entity nope",
		}).split("\n");
		expect(caret[2]?.indexOf("^")).toBe(caret[1]?.indexOf("nope"));
	});
});
