import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConsoleError } from "../gateway/liveConsole/builtins.js";
import { withDoing } from "../gateway/liveConsole/doing.js";
import {
	type ConsoleResult,
	type ConsoleStatementResult,
	DOING_REFUSED,
	evaluateConsole,
} from "../gateway/liveConsole/evaluate.js";
import { fillHoles, holeIssue } from "../gateway/liveConsole/holes.js";
import { type ConsoleEntity, createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import { renderConsoleIssue, renderConsoleValue } from "../gateway/liveConsole/render.js";
import {
	CONSOLE_SOURCE_MAX,
	isConsoleVariableName,
	parseConsole,
	parseConsoleExpression,
} from "../shared/live-console-grammar.js";
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

	it("binds or below and below a comparison, and reads the right side only when the left does not decide", async () => {
		expect(parseConsole("a or b and c == d").statements[0]?.node).toMatchObject({
			kind: "binary",
			op: "or",
			right: { kind: "binary", op: "and", right: { kind: "binary", op: "==" } },
		});
		expect(await run("false and 1 / 0 == 1")).toMatchObject({ ok: true, value: false });
		expect(await run("true or 1 / 0 == 1")).toMatchObject({ ok: true, value: true });
		expect(await run("1 < 2 and 2 < 3")).toMatchObject({ ok: true, value: true });
		expect(await run("true and 5")).toMatchObject({ ok: false, issue: { code: "wrong_type", start: 9, end: 10 } });
		expect(await run("1 or true")).toMatchObject({ ok: false, issue: { code: "wrong_type", start: 0, end: 1 } });
		expect(["and", "or", "andrew"].map(isConsoleVariableName)).toEqual([false, false, true]);
		// A record keeps a member or a key spelled as one.
		expect(await run('{and: 1, "or": 2}.and + {or: 2}.or')).toMatchObject({ ok: true, value: 3 });
	});

	it("parses one expression and refuses a save or a second statement", () => {
		expect(parseConsoleExpression("a + 1")).toMatchObject({ node: { kind: "binary", op: "+" }, issues: [] });
		expect(parseConsoleExpression("a = 1").issues[0]).toMatchObject({ code: "unexpected", start: 2, end: 3 });
		expect(parseConsoleExpression("a; b").issues[0]).toMatchObject({ code: "unexpected", start: 1, end: 2 });
		expect(parseConsoleExpression("x".repeat(CONSOLE_SOURCE_MAX + 1))).toMatchObject({
			node: null,
			issues: [{ code: "too_big" }],
		});
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
		const saved = { cold: { value: held, type: "Sensor" }, n: { value: 4 } };
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

describe("doing members", () => {
	const devices: ConsoleEntity = {
		name: "devices",
		description: "Devices.",
		audiences: ["host", "owner"],
		members: { list: { kind: "property", description: "Every device.", type: "List<Device>", get: () => [] } },
	};
	const plain = createConsoleRegistry([sensors, devices]);
	const doing = createConsoleRegistry(withDoing([sensors, devices]));

	it("are served to a script alone, one per action, and leave the other audiences' vocabulary as it was", () => {
		const written = doing
			.projection("script")
			.entities.flatMap((entity) =>
				entity.members
					.filter((member) => member.kind === "doing")
					.map(
						(member) =>
							`${entity.name}.${member.name}(${member.params.map((param) => `${param.name}${param.optional ? "?" : ""}`).join(", ")})`,
					),
			);

		expect(written.sort()).toEqual([
			"assistant.tell(when, message?)",
			"devices.set(device, verb)",
			"functions.run(function, values?)",
			"ifttt.trigger(event, value1?, value2?, value3?)",
		]);
		expect([doing.hash("owner"), doing.hash("host")]).toEqual([plain.hash("owner"), plain.hash("host")]);
		expect([doing.get("assistant", "host"), doing.has("assistant")]).toEqual([null, true]);
		expect(doing.get("devices", "script")?.name).toBe("devices");
	});

	it("are refused by the evaluator, called or named, and by a hole's save check with the call's span", async () => {
		const ask = async (source: string) => single(await evaluateConsole(source, doing, "host"));

		expect(await ask('devices.set("Lamp", "on")')).toMatchObject({ ok: false, issue: { code: "doing" } });
		expect(await ask("devices.set")).toMatchObject({ ok: false, issue: { code: "doing" } });
		expect(await ask('assistant.tell("now")')).toMatchObject({ ok: false, issue: { code: "unknown_name" } });
		expect(holeIssue('Now {devices.set("Lamp", "on")}', [], doing)).toEqual({
			start: 5,
			end: 30,
			message: DOING_REFUSED,
		});
		expect(holeIssue("{devices.list.count()}", [], doing)).toBeNull();
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

	it("refuses at save a hole that is open, does not parse, holds two statements, names nothing here, prints no value or reads a slow member, with its span", () => {
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
		// The first in the text, whichever kind it is.
		expect(at("It is {temperature} and {value +} now")).toBe("temperature");
		expect(at("It is {value +} and {temperature} now")).toBe("");
		// A hole that does not parse is not judged for what it names.
		expect(holeIssue("It is {temperature +} now", ["value"], scope)).toMatchObject({ start: 20, end: 20 });
		expect(at("It is {shout(value)} now")).toBe("shout");
		expect(at("It is {radio.listen()} now")).toBe("radio.listen()");
		expect(at("It is {} now")).toBe("{}");
		expect(at("It is {sensors} now")).toBe("sensors");
		expect(at("It is {sensors + 1} now")).toBe("sensors");
		expect(at("It is {round()} now")).toBe("round()");
		expect(at("It is {round(value, 1, 2)} now")).toBe("round(value, 1, 2)");
		expect(at("It is {sensors.read} now")).toBe("sensors.read");
		expect(at("It is {sensors.nothing} now")).toBe("sensors.nothing");
		expect(at("It is {value.round(1)} now")).toBe("value.round");
		expect(at("It is {if(true, radio, 0).listen()} now")).toBe("if(true, radio, 0).listen");
	});

	it("reads a name that is also an entity's as the held name, at the save as at the fire", async () => {
		const shadowing = { sensors: { value: "mine", shown: "Mine" } };

		expect(holeIssue("It is {sensors} now", ["sensors"], scope)).toBeNull();
		expect(await fillHoles("{sensors} {sensors.list.count()}", shadowing, scope)).toEqual({
			text: "Mine {?}",
			failed: 1,
		});
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

describe("a string with holes", () => {
	const value = async (source: string) => {
		const answer = await run(source);
		return answer.ok && "value" in answer ? answer.value : answer;
	};
	const issueOf = async (source: string) => {
		const answer = await evaluateConsole(source, registry, "host");
		return answer.ok ? null : [answer.issue.code, source.slice(answer.issue.start, answer.issue.end)];
	};

	it("reads each hole as an expression where it stands, its own strings unescaped and nested", async () => {
		expect(await value('"x{1 + 2}y"')).toBe("x3y");
		expect(await value('"{sensors.read("Freezer").name} is {if(true, "on", \'off\')}"')).toBe("Freezer is on");
		expect(await value('"a{"b{1 + 1}c"}d"')).toBe("ab2cd");
		expect(await value('"{ {k: "v"}.k }" + \'{[1, 2].count()}\'')).toBe("v2");
		expect(await value('"a{1}" == "a1"')).toBe(true);
	});

	it("reads the braces and the backslash escaped in any string, and keeps a backslash before anything else", async () => {
		expect(await value('"\\{kept\\} \\\\ \\q \\n|\\t|\\r|\\"|\\\'"')).toBe("{kept} \\ \\q \n|\t|\r|\"|'");
		expect(await value("'a } b'")).toBe("a } b");
	});

	it("fails the whole string where a hole fails, and refuses one it cannot print", async () => {
		expect(await issueOf('"is {nowhere} now"')).toEqual(["unknown_name", "nowhere"]);
		expect(await issueOf('"is {sensors.list} now"')).toEqual(["wrong_type", "sensors.list"]);
		expect(await issueOf('"is {sensors} now"')).toEqual(["is_entity", "sensors"]);
	});

	it("refuses a hole that is empty, open or holds two expressions, and a key that holds one, each with its span", () => {
		const at = (source: string) => {
			const [issue] = parseConsole(source).issues;
			return issue && source.slice(issue.start, issue.end);
		};

		expect(at('"a {} b"')).toBe("{}");
		expect(at('"a {1; 2} b"')).toBe("{1; 2}");
		expect(at('"a {x = 1} b"')).toBe("{x = 1}");
		expect(at('"a {1 2} b"')).toBe("2");
		expect(parseConsole('"a {1 + } b"').issues[0]).toMatchObject({ start: 8, end: 8 });
		expect(at('"a {b')).toBe('"a {b');
		expect(at('{"k{1}": 2}')).toBe('"k{1}"');
		expect(at('{"k\\{1\\}": 2}')).toBeUndefined();
	});

	it("ends a quoted string at its line, and raises one issue for one open bracket", () => {
		expect(parseConsole('"abc\n1 + 1').issues[0]).toMatchObject({ start: 0, end: 4 });
		expect(parseConsole("round(1 +").issues).toHaveLength(1);
		expect(parseConsole("[1, (2").issues).toHaveLength(1);
	});

	it("holds a parenthesized expression's span to its brackets, and marks it grouped", () => {
		const { node } = parseConsoleExpression("(1 + 2) * (3)");
		if (node?.kind !== "binary") throw new Error("it is a product");

		expect([node.start, node.end, node.grouped]).toEqual([0, 13, undefined]);
		expect([node.left.start, node.left.end, node.left.grouped]).toEqual([0, 7, true]);
		expect([node.right.start, node.right.end, node.right.grouped]).toEqual([10, 13, true]);
	});

	it("refuses nesting past its depth, brackets or strings, without running out of stack", () => {
		const deep = `${"(".repeat(900)}1${")".repeat(900)}`;
		const nested = Array.from({ length: 12 }, (_, at) => (at % 2 === 0 ? '"{' : "'{")).join("");

		expect(parseConsole(deep).issues[0]).toMatchObject({ code: "too_big" });
		expect(parseConsole(`${"(".repeat(40)}1${")".repeat(40)}`).issues).toEqual([]);
		expect(parseConsole(nested).issues.length).toBeGreaterThan(0);
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
