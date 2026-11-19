import { describe, expect, it } from "vitest";
import { FUNCTION_STEPS_MAX, FunctionSchema } from "../shared/schemasFunction.js";

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
			].map((body) => FunctionSchema.safeParse(body).success),
		).toEqual([false, false, false, false, false, false]);
	});
});
