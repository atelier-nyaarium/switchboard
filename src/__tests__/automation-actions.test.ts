import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { holeTextsOf } from "../gateway/computed/automationText.js";
import {
	ACTION_WORD_RE,
	AUTOMATION_ACTIONS,
	AUTOMATION_SERVES,
	type AutomationActionKind,
	type AutomationActionParam,
	type AutomationActionRow,
	AutomationActionSchema,
	ConsoleAutomationListResultSchema,
} from "../shared/schemasAutomation.js";
import { PHONE_CAPABILITIES } from "../shared/schemasPhoneCapabilities.js";

const kinds = Object.keys(AUTOMATION_ACTIONS) as AutomationActionKind[];
const paramsOf = (kind: AutomationActionKind): readonly AutomationActionParam[] => AUTOMATION_ACTIONS[kind].params;

/** The longest value each parameter takes. */
const filled = (param: AutomationActionParam): unknown => {
	if (param.kind === "choice") return param.options?.[0]?.value ?? "";
	if (param.kind === "switch") return "aa:bb:cc:dd:ee:01";
	if (param.kind === "function") return "warm-up";
	if (param.kind === "values") return { room: "aa:bb:cc:dd:ee:01", degrees: 21 };
	return "x".repeat(param.max ?? 1);
};
const sample = (kind: AutomationActionKind, over: Record<string, unknown> = {}) => ({
	kind,
	...Object.fromEntries(paramsOf(kind).map((param) => [param.name, filled(param)])),
	...over,
});
const takes = (action: unknown) => AutomationActionSchema.safeParse(action).success;

describe("the action catalogue", () => {
	it.each(kinds)("names exactly the parameters %s is stored with, drawn or declared undrawn", (kind) => {
		const member = AutomationActionSchema.options.find((option) => option.shape.kind.value === kind);
		const stored = Object.keys(member?.shape ?? {}).filter((key) => key !== "kind");
		const row: AutomationActionRow = AUTOMATION_ACTIONS[kind];

		expect([...paramsOf(kind).map((param) => param.name), ...(row.undrawn ?? [])].sort()).toEqual(stored.sort());
		expect(takes(sample(kind))).toBe(true);
	});

	it.each(kinds)("bounds %s as its schema does: a length, a choice, a word, and what may be left out", (kind) => {
		for (const param of paramsOf(kind)) {
			const without = Object.fromEntries(Object.entries(sample(kind)).filter(([key]) => key !== param.name));
			expect([param.name, takes(without)]).toEqual([param.name, param.optional === true]);
			if (param.max !== undefined) {
				expect([param.name, takes(sample(kind, { [param.name]: "x".repeat(param.max + 1) }))]).toEqual([
					param.name,
					false,
				]);
			}
			if (param.kind === "choice") {
				const each = (param.options ?? []).map((option) => takes(sample(kind, { [param.name]: option.value })));
				expect([param.name, ...each, takes(sample(kind, { [param.name]: "neither" }))]).toEqual([
					param.name,
					...each.map(() => true),
					false,
				]);
			}
			if (param.kind === "word") {
				expect([param.name, takes(sample(kind, { [param.name]: "two words" }))]).toEqual([param.name, false]);
				expect(ACTION_WORD_RE.test("door_open-2")).toBe(true);
			}
		}
	});

	it("finds an action's texts by its row, and serves every row whole", () => {
		const actions = [
			{ kind: "device_set" as const, device: "aa", verb: "on" as const },
			{ kind: "tell_assistant" as const, when: "now" as const, message: "It is {value}" },
			{ kind: "ifttt_trigger" as const, event: "door", value2: "two" },
		];
		const listed = ConsoleAutomationListResultSchema.parse({
			automations: [],
			serves: { ...AUTOMATION_SERVES, numbers: [], switches: [] },
		});

		expect(holeTextsOf(actions)).toEqual([
			{ action: 1, param: "message", text: "It is {value}" },
			{ action: 2, param: "value2", text: "two" },
		]);
		expect(listed.serves?.actions.map((row) => [row.kind, row.params.map((param) => param.name)])).toEqual(
			kinds.map((kind) => [kind, paramsOf(kind).map((param) => param.name)]),
		);
	});

	it("pins the catalogue the phone's protocol fixture decodes", () => {
		const file = path.resolve(
			import.meta.dirname,
			"../../tests/fixtures/protocol/automation-list-result-serves.json",
		);
		const listed = ConsoleAutomationListResultSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));

		expect(listed.serves?.actions).toEqual(JSON.parse(JSON.stringify(AUTOMATION_SERVES.actions)));
		expect(listed.serves?.triggers).toEqual([...AUTOMATION_SERVES.triggers]);
	});

	it("stores no IFTTT action the live request would refuse", () => {
		const live = PHONE_CAPABILITIES.ifttt_trigger.request;
		const { kind: _kind, ...longest } = sample("ifttt_trigger");

		expect(live.safeParse(longest).success).toBe(true);
	});
});
