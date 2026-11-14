import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatDecimal, fromDisplay, inRange, parseDecimal, toDisplay } from "../shared/field-types.js";
import { formatFieldValue, parseFieldValue } from "../shared/field-values.js";
import { type AssistantFieldSpec, parseRuleForFields } from "../shared/schemasAssistantRules.js";

interface Vectors {
	decimal: Array<{ text: string; value: number | null }>;
	format: Array<{ value: number; decimals: number; text: string }>;
	roundTrip: Array<{ typed: number; stored: number; readBack: string }>;
	range: Array<{ value: number; decimals: number; inRange: boolean }>;
	fields: Array<{ spec: AssistantFieldSpec; value: string | number; display?: string; text: string }>;
}

const vectors = JSON.parse(
	fs.readFileSync(path.join(__dirname, "../../tests/fixtures/field-types/vectors.json"), "utf8"),
) as Vectors;

const temperature: AssistantFieldSpec = {
	kind: "number",
	field: "temperature",
	label: "Temperature",
	unit: "C",
	decimals: 1,
	min: -40,
	max: 100,
};

describe("field types", () => {
	it("replays the shared number, conversion and rendering vectors", () => {
		for (const row of vectors.decimal) expect(parseDecimal(row.text), row.text).toBe(row.value);
		for (const row of vectors.format) expect(formatDecimal(row.value, row.decimals)).toBe(row.text);
		for (const row of vectors.roundTrip) {
			expect(fromDisplay(row.typed, "C", "F")).toBe(row.stored);
			expect(formatDecimal(toDisplay(row.stored, "C", "F").value, 1)).toBe(row.readBack);
		}
		for (const row of vectors.range) expect(inRange(row.value, row.decimals), String(row.value)).toBe(row.inRange);
		for (const row of vectors.fields) expect(formatFieldValue(row.spec, row.value, row.display)).toBe(row.text);
	});

	it("parses a value per its type, or names the field it fails on", () => {
		expect(parseFieldValue(temperature, 24.4)).toEqual({ ok: true, value: 24.4 });
		expect(parseFieldValue(temperature, "-5.3")).toEqual({ ok: true, value: -5.3 });
		expect(parseFieldValue(temperature, 24.46)).toEqual({ ok: true, value: 24.5 });
		const tooHot = parseFieldValue(temperature, 120);
		expect(tooHot.ok ? null : tooHot.issue).toMatchObject({ path: ["temperature"], code: "too_big" });
		const huge = parseFieldValue({ kind: "number", field: "count", label: "Count" }, 1e20);
		expect(huge.ok ? null : huge.issue.code).toBe("too_big");
		const word = parseFieldValue(temperature, "warm");
		expect(word.ok ? null : word.issue.code).toBe("invalid_type");
		const bytes: AssistantFieldSpec = { kind: "bytes", field: "adv", label: "Advertisement", maxLength: 2 };
		expect(parseFieldValue(bytes, "0101").ok).toBe(true);
		expect(parseFieldValue(bytes, "010203").ok).toBe(false);
		expect(parseFieldValue(bytes, "0G").ok).toBe(false);
		const frame: AssistantFieldSpec = { kind: "bytes", field: "adv", label: "Advertisement" };
		expect(parseFieldValue(frame, "00".repeat(65)).ok).toBe(false);
	});

	it("refuses a rule over a number or bytes field", () => {
		const rule = {
			id: "r",
			conditions: [{ field: "temperature", test: "is" as const, value: "30" }],
			action: "wake" as const,
			revision: 0,
		};
		expect(parseRuleForFields(rule, [temperature]).ok).toBe(false);
	});
});
