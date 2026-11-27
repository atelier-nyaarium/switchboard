import { describe, expect, it } from "vitest";
import { AUTOMATION_ACTIONS } from "../shared/schemasAutomation.js";
import { FUNCTION_STEPS_MAX, FunctionSchema, STEP_ARGS_MAX } from "../shared/schemasFunction.js";

const on = {
	kind: "do",
	action: "device_set",
	args: { device: { kind: "literal", value: "plug" }, verb: { kind: "literal", value: "on" } },
};

describe("a function record", () => {
	it("takes named values and steps whose arguments are literals or expressions, and refuses what it cannot hold", () => {
		const held = {
			name: "Warm up",
			params: [{ name: "room", type: "device" }],
			steps: [on, { kind: "do", action: "device_set", args: { device: { kind: "expression", text: "room" } } }],
		};

		expect(FunctionSchema.safeParse(held).success).toBe(true);
		expect(
			[
				{ ...held, params: [...held.params, { name: "room", type: "text" }] },
				{ ...held, params: [{ name: "Room", type: "device" }] },
				{ ...held, steps: [] },
				{ ...held, steps: Array(FUNCTION_STEPS_MAX + 1).fill(on) },
				{ ...held, steps: [{ kind: "wait", minutes: 1 }] },
				{ ...held, as: "result" },
				{
					...held,
					steps: [
						{
							...on,
							args: Object.fromEntries(
								Array.from({ length: STEP_ARGS_MAX + 1 }, (_, at) => [`v${at}`, on.args.verb]),
							),
						},
					],
				},
			].map((body) => FunctionSchema.safeParse(body).success),
		).toEqual([false, false, false, false, false, false, false]);
	});

	it("holds the widest action a step can name", () => {
		const widest = Math.max(
			...Object.entries(AUTOMATION_ACTIONS)
				.filter(([kind]) => kind !== "run_function")
				.map(([, row]) => row.params.length),
		);

		expect(STEP_ARGS_MAX).toBeGreaterThanOrEqual(widest);
	});

	it("holds an optional result name by the parameter rule", () => {
		const body = {
			name: "Warm up",
			params: [],
			steps: [{ ...on, as: "result" }],
		};

		expect([
			FunctionSchema.safeParse(body).success,
			FunctionSchema.safeParse({ ...body, steps: [{ ...on, as: "Result" }] }).success,
			FunctionSchema.safeParse({ ...body, steps: [{ ...on, as: "a".repeat(33) }] }).success,
		]).toEqual([true, false, false]);
	});
});
