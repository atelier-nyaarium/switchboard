import {
	BYTES_MAX,
	BYTES_PER_ROW,
	formatDecimal,
	inRange,
	parseDecimal,
	roundTo,
	suffixOf,
	toDisplay,
} from "./field-types.js";
import { type AssistantFieldSpec, trimRuleValue } from "./schemasAssistantRules.js";
import { ASSISTANT_RULE_VALUE_MAX } from "./wire-vocabulary.js";

export type FieldValue = string | number;

export const FIELD_ISSUE_CODES = ["invalid_type", "invalid_value", "too_small", "too_big"] as const;

export interface FieldIssue {
	path: string[];
	message: string;
	code: (typeof FIELD_ISSUE_CODES)[number];
}

export type FieldParse = { ok: true; value: FieldValue } | { ok: false; issue: FieldIssue };

const HEX_RE = /^(?:[0-9a-f]{2})*$/;

const issue = (spec: AssistantFieldSpec, code: FieldIssue["code"], message: string): FieldParse => ({
	ok: false,
	issue: { path: [spec.field], message, code },
});

export function parseFieldValue(spec: AssistantFieldSpec, raw: unknown): FieldParse {
	switch (spec.kind) {
		case "text": {
			if (typeof raw !== "string") return issue(spec, "invalid_type", `${spec.label} takes text`);
			const value = trimRuleValue(raw);
			if (value.length > ASSISTANT_RULE_VALUE_MAX) return issue(spec, "too_big", `${spec.label} is too long`);
			return { ok: true, value };
		}
		case "enumeration": {
			if (typeof raw !== "string") return issue(spec, "invalid_type", `${spec.label} takes a choice`);
			if (!spec.options.some((option) => option.value === raw)) {
				return issue(spec, "invalid_value", `"${raw}" is not a ${spec.label} choice`);
			}
			return { ok: true, value: raw };
		}
		case "number": {
			const read = typeof raw === "number" ? (Number.isFinite(raw) ? raw : null) : parseDecimal(String(raw));
			if (read === null) return issue(spec, "invalid_type", `${spec.label} takes a number`);
			const value = spec.decimals === undefined ? read : roundTo(read, spec.decimals);
			if (!inRange(value, spec.decimals ?? 0)) return issue(spec, "too_big", `${spec.label} is out of range`);
			if (spec.min !== undefined && value < spec.min)
				return issue(spec, "too_small", `${spec.label} is below ${spec.min}`);
			if (spec.max !== undefined && value > spec.max)
				return issue(spec, "too_big", `${spec.label} is above ${spec.max}`);
			return { ok: true, value };
		}
		case "bytes": {
			if (typeof raw !== "string" || !HEX_RE.test(raw))
				return issue(spec, "invalid_type", `${spec.label} takes hex bytes`);
			if (raw.length / 2 > (spec.maxLength ?? BYTES_MAX)) {
				return issue(spec, "too_big", `${spec.label} is too long`);
			}
			return { ok: true, value: raw };
		}
	}
}

/** Offset-prefixed hex rows. */
export function bytesText(hex: string): string {
	const rows: string[] = [];
	for (let at = 0; at * 2 < hex.length; at += BYTES_PER_ROW) {
		const row = hex.slice(at * 2, (at + BYTES_PER_ROW) * 2).replace(/(..)(?=.)/g, "$1 ");
		rows.push(`${at}: ${row}`);
	}
	return rows.join(" | ");
}

export function formatFieldValue(spec: AssistantFieldSpec, value: FieldValue, display?: string): string {
	switch (spec.kind) {
		case "number": {
			if (typeof value !== "number") return String(value);
			const shown = spec.unit && display ? toDisplay(value, spec.unit, display) : { value, unit: spec.unit };
			const text = formatDecimal(shown.value, spec.decimals ?? 0);
			return shown.unit ? `${text}${suffixOf(shown.unit)}` : text;
		}
		case "bytes":
			return bytesText(String(value));
		case "enumeration":
			return spec.options.find((option) => option.value === value)?.label ?? String(value);
		case "text":
			return String(value);
	}
}
