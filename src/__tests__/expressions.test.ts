import { describe, expect, it } from "vitest";
import {
	type BandSide,
	checkExpression,
	conforms,
	type ExpressionNode,
	type ExprType,
	evaluate,
	type FieldRef,
	known,
	refKey,
	unknown,
	type Value,
} from "../shared/expressions.js";

const adv: FieldRef = { source: "input", key: "adv" };
const temperature: FieldRef = { source: "device", device: "ce:1c:44:06:3c:5d", key: "temperature" };

const types = (map: Record<string, ExprType>) => (ref: FieldRef) => map[refKey(ref)] ?? null;
const inputs = (map: Record<string, Value>) => (ref: FieldRef) => map[refKey(ref)] ?? unknown("no reading");
const num = (value: string): ExpressionNode => ({ kind: "literal", type: "number", value });

/** The H5110's temperature: 24-bit sign-magnitude, error bit in byte 5. */
const h5110Temperature: ExpressionNode[] = [
	{ kind: "field", ref: adv },
	{ kind: "take", input: 0, offset: 2, length: 3, signed: false, endian: "big" },
	num("8388607"),
	{ kind: "arith", op: "and", left: 1, right: 2 },
	num("1000"),
	{ kind: "arith", op: "intdiv", left: 3, right: 4 },
	num("10"),
	{ kind: "arith", op: "div", left: 5, right: 6 },
	num("8388608"),
	{ kind: "arith", op: "and", left: 1, right: 8 },
	num("0"),
	{ kind: "compare", op: "ne", left: 9, right: 10 },
	{ kind: "arith", op: "sub", left: 10, right: 7 },
	{ kind: "take", input: 0, offset: 5, length: 1, signed: false, endian: "big" },
	num("128"),
	{ kind: "arith", op: "and", left: 13, right: 14 },
	{ kind: "compare", op: "ne", left: 15, right: 10 },
	{ kind: "unknown", reason: "error" },
	{
		kind: "choose",
		branches: [
			{ when: 16, result: 17 },
			{ when: 11, result: 12 },
		],
		otherwise: 7,
	},
];

const bytesType = types({ "input:adv": { type: "bytes" } });

describe("expressions", () => {
	it("decodes the H5110's frames with take and arithmetic, and reads its error bit as unknown", () => {
		expect(checkExpression(h5110Temperature, bytesType)).toMatchObject({ ok: true, type: { type: "number" } });
		const read = (hex: string) => evaluate(h5110Temperature, inputs({ "input:adv": known(hex) })).value;

		expect(read("010103bac864")).toEqual({ known: true, value: expect.closeTo(24.4, 6) });
		expect(read("010180d16c5a")).toEqual({ known: true, value: expect.closeTo(-5.3, 6) });
		expect(read("010103bac8e4")).toEqual(unknown("error"));
		expect(read("0101")).toEqual(unknown("short frame"));
	});

	it("infers a Choice from text branches and evaluates it", () => {
		const hot: ExpressionNode[] = [
			{ kind: "field", ref: temperature },
			num("30"),
			{ kind: "compare", op: "gt", left: 0, right: 1 },
			{ kind: "literal", type: "text", value: "Hot!" },
			{ kind: "literal", type: "text", value: "OK" },
			{ kind: "choose", branches: [{ when: 2, result: 3 }], otherwise: 4 },
		];
		const typed = types({ [refKey(temperature)]: { type: "number", integral: false } });
		const read = (value: Value) => evaluate(hot, inputs({ [refKey(temperature)]: value })).value;

		expect(checkExpression(hot, typed)).toMatchObject({
			ok: true,
			type: { type: "choice", members: ["Hot!", "OK"] },
		});
		expect(read(known(31))).toEqual(known("Hot!"));
		expect(read(known(29.5))).toEqual(known("OK"));
		expect(read(unknown("stale"))).toEqual(unknown("stale"));
	});

	it("refuses at save what cannot evaluate", () => {
		const typed = types({
			[refKey(temperature)]: { type: "number", integral: false },
			"input:adv": { type: "bytes" },
		});
		const refusal = (nodes: ExpressionNode[]) => {
			const check = checkExpression(nodes, typed);
			return check.ok ? null : check.issue.code;
		};
		const field: ExpressionNode = { kind: "field", ref: temperature };

		expect(refusal([field, { kind: "compare", op: "gt", left: 0, right: 2 }, num("1")])).toBe("invalid_ref");
		expect(refusal([num("9007199254740993")])).toBe("too_big");
		expect(
			refusal([
				field,
				{ kind: "literal", type: "text", value: "x" },
				{ kind: "compare", op: "lt", left: 0, right: 1 },
			]),
		).toBe("invalid_type");
		expect(refusal([field, num("2"), { kind: "arith", op: "mod", left: 0, right: 1 }])).toBe("invalid_type");
		expect(refusal([field, { kind: "band", input: 0, low: 28, high: 18, deadZone: 1 }])).toBe("invalid_value");
		expect(refusal([field, { kind: "band", input: 0, low: 18, high: 20, deadZone: 1 }])).toBe("invalid_value");
		expect(refusal([{ kind: "field", ref: { source: "computed", id: "missing" } }])).toBe("invalid_ref");
		expect(refusal([num("1e3")])).toBe("invalid_value");
	});

	it("leaves a band's side only past its dead zone", () => {
		const nodes: ExpressionNode[] = [
			{ kind: "field", ref: temperature },
			{ kind: "band", input: 0, low: 18, high: 28, deadZone: 1 },
		];
		let sides: Record<number, BandSide> = {};
		const step = (value: number) => {
			const run = evaluate(nodes, inputs({ [refKey(temperature)]: known(value) }), sides);
			sides = run.sides;
			return run.value.known ? run.value.value : null;
		};

		expect([20, 17.5, 18.5, 19.1, 28.5, 27.5, 26.9].map(step)).toEqual([
			"ok",
			"low",
			"low",
			"ok",
			"high",
			"high",
			"ok",
		]);
		step(17);
		expect(evaluate(nodes, inputs({}), sides).value.known).toBe(false);
		// Unknown readings keep side.
		expect(step(18.5)).toBe("low");
	});

	it("reads signed and little-endian bytes, and does whole-number arithmetic", () => {
		const frame = known("ff7f0280");
		const read = (nodes: ExpressionNode[]) => evaluate(nodes, inputs({ "input:adv": frame })).value;
		const bytes: ExpressionNode = { kind: "field", ref: adv };

		expect(read([bytes, { kind: "take", input: 0, offset: 0, length: 2, signed: true, endian: "big" }])).toEqual(
			known(-129),
		);
		expect(read([bytes, { kind: "take", input: 0, offset: 2, length: 2, signed: true, endian: "little" }])).toEqual(
			known(-32766),
		);
		expect(read([num("-7"), num("2"), { kind: "arith", op: "mod", left: 0, right: 1 }])).toEqual(known(-1));
		expect(read([num("-7"), num("2"), { kind: "arith", op: "intdiv", left: 0, right: 1 }])).toEqual(known(-3));
		expect(read([num("3"), num("4"), { kind: "arith", op: "shift", left: 0, right: 1 }])).toEqual(known(48));
		expect(read([num("48"), num("-4"), { kind: "arith", op: "shift", left: 0, right: 1 }])).toEqual(known(3));
	});

	it("answers a result past the whole-number range as unknown, never throwing", () => {
		const read = (nodes: ExpressionNode[]) => evaluate(nodes, inputs({})).value;
		const shifted = read([num("3"), num("2000"), { kind: "arith", op: "shift", left: 0, right: 1 }]);
		expect(shifted.known).toBe(false);
		const past = read([num("9007199254740991"), num("1"), { kind: "arith", op: "add", left: 0, right: 1 }]);
		expect(past.known).toBe(false);
		const fraction = read([num("7.5"), num("2"), { kind: "arith", op: "intdiv", left: 0, right: 1 }]);
		expect(fraction.known).toBe(false);
	});

	it("reads a known value off its declared type as unknown", () => {
		expect(conforms({ type: "unknown" }, known("false")).known).toBe(false);
		expect(conforms({ type: "bytes" }, known("gg")).known).toBe(false);
		expect(conforms({ type: "bytes" }, known("0a1b")).known).toBe(true);
		expect(conforms({ type: "number", integral: true }, known(1.5)).known).toBe(false);
		expect(conforms({ type: "choice", members: ["low"] }, known("high")).known).toBe(false);
	});

	it("short-circuits past an unknown, and answers division by zero as unknown", () => {
		const nodes = (kind: "all" | "any", first: string): ExpressionNode[] => [
			{ kind: "literal", type: "boolean", value: first },
			{ kind: "field", ref: { source: "computed", id: "gone" } },
			{ kind, args: [0, 1] },
		];
		const run = (list: ExpressionNode[]) => evaluate(list, inputs({})).value;

		expect(run(nodes("any", "true"))).toEqual(known(true));
		expect(run(nodes("all", "false"))).toEqual(known(false));
		expect(run(nodes("all", "true")).known).toBe(false);
		expect(run([num("1"), num("0"), { kind: "arith", op: "div", left: 0, right: 1 }])).toEqual(
			unknown("division by zero"),
		);
	});
});
