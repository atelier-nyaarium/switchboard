import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AUTOMATION_TRIGGER_GIVES,
	type FitAnswer,
	type FunctionReads,
	fitOf,
	functionReads,
	type GivenType,
	triggerGiven,
} from "../shared/automation-fit.js";
import { AUTOMATION_TRIGGERS, type AutomationTriggerKind, type FunctionArg } from "../shared/schemasAutomation.js";
import { type FunctionParam, FunctionSchema } from "../shared/schemasFunction.js";

const VECTORS = path.join(import.meta.dirname, "..", "..", "tests", "fixtures", "automation-fit", "vectors.json");

interface Case {
	name: string;
	given: { kind: AutomationTriggerKind; fieldType?: GivenType; eventFields?: string[] };
	params: FunctionParam[];
	reads: FunctionReads;
	args: Record<string, FunctionArg>;
	expect: FitAnswer;
}

const { cases } = JSON.parse(fs.readFileSync(VECTORS, "utf8")) as { cases: Case[] };

describe("fit", () => {
	it.each(cases)("$name", (vector) => {
		const { kind, ...context } = vector.given;

		expect(fitOf(triggerGiven(kind, context), vector, vector.args)).toEqual(vector.expect);
	});

	it("reads the trigger names a function's expressions and text placeholders use, and the event's fields by name", () => {
		const fn = FunctionSchema.parse({
			name: "Tell",
			params: [{ name: "room", type: "device" }],
			steps: [
				{
					kind: "action",
					action: "tell_assistant",
					args: {
						when: { kind: "literal", value: "now" },
						message: {
							kind: "literal",
							value: 'It is {event.reason} on {source} in {room} by {event["by"]}, \\{time\\}',
						},
					},
				},
				{
					kind: "action",
					action: "device_set",
					args: {
						device: { kind: "expression", text: "room" },
						verb: { kind: "expression", text: 'round(value) > threshold ? "on" : sensors.list' },
					},
				},
			],
		});

		expect(functionReads(fn)).toEqual({
			names: ["event", "source", "threshold", "value"],
			eventFields: ["by", "reason"],
		});
	});

	it("gives a type for every name each trigger offers a placeholder", () => {
		const names = (kind: AutomationTriggerKind) => AUTOMATION_TRIGGERS[kind].names.map((held) => held.name);

		for (const kind of Object.keys(AUTOMATION_TRIGGERS) as AutomationTriggerKind[]) {
			expect([kind, AUTOMATION_TRIGGER_GIVES[kind].map((held) => held.name)]).toEqual([kind, names(kind)]);
		}
	});
});
