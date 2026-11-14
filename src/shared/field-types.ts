export const RULE_TESTS = ["is", "is_not", "contains"] as const;
export type RuleTest = (typeof RULE_TESTS)[number];

export const TEST_LABELS = { is: "is", is_not: "is not", contains: "contains" } as const satisfies Record<
	RuleTest,
	string
>;

export const FIELD_KINDS = ["enumeration", "text", "number", "bytes"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface FieldTypeRow {
	label: string;
	tests: readonly RuleTest[];
}

/** Bytes untested; numeric thresholds. */
export const FIELD_TYPES = {
	enumeration: { label: "Choice", tests: ["is", "is_not"] },
	text: { label: "Text", tests: ["is", "is_not", "contains"] },
	number: { label: "Number", tests: [] },
	bytes: { label: "Bytes", tests: [] },
} as const satisfies Record<FieldKind, FieldTypeRow>;

export const UNITS = [
	{ unit: "C", suffix: " °C" },
	{ unit: "F", suffix: " °F" },
	{ unit: "%", suffix: "%" },
] as const;
export type UnitCode = (typeof UNITS)[number]["unit"];

/** Shown = stored * scale + offset. */
export const UNIT_DISPLAYS = [{ unit: "C", display: "F", scale: 1.8, offset: 32 }] as const;

export const BYTES_PER_ROW = 8;
export const BYTES_MAX = 64;

export const CONVERTED_DECIMALS = 2;

/** Display targets excluded. */
export const UNIT_CODES: readonly string[] = UNITS.map((row) => row.unit).filter(
	(unit) => !UNIT_DISPLAYS.some((row) => row.display === unit),
);

export function suffixOf(unit: string): string {
	return UNITS.find((row) => row.unit === unit)?.suffix ?? ` ${unit}`;
}

/** Decimal grammar: minus only, no exponent, hex, or whitespace. */
const DECIMAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** Matches `FieldRules.kt` grammar. */
export function parseDecimal(text: string): number | null {
	if (!DECIMAL_RE.test(text)) return null;
	const value = Number(text);
	if (!Number.isFinite(value)) return null;
	return Object.is(value, -0) ? 0 : value;
}

export function inRange(value: number, decimals: number): boolean {
	return Number.isFinite(value) && Math.abs(value) * 10 ** decimals <= Number.MAX_SAFE_INTEGER;
}

/** Half-up aligns runtimes. */
export function roundTo(value: number, decimals: number): number {
	const scale = 10 ** decimals;
	const rounded = Math.round(value * scale) / scale;
	return Object.is(rounded, -0) ? 0 : rounded;
}

/** Avoids `toFixed` drift. */
export function formatDecimal(value: number, decimals: number): string {
	const scale = 10 ** decimals;
	const scaled = Math.round(value * scale);
	const negative = scaled < 0;
	const digits = String(Math.abs(scaled)).padStart(decimals + 1, "0");
	const whole = digits.slice(0, digits.length - decimals);
	const fraction = decimals > 0 ? `.${digits.slice(digits.length - decimals)}` : "";
	return `${negative ? "-" : ""}${whole}${fraction}`;
}

function displayOf(unit: string, display: string) {
	return UNIT_DISPLAYS.find((row) => row.unit === unit && row.display === display);
}

/** Unconfigured units stay unchanged. */
export function toDisplay(value: number, unit: string, display: string): { value: number; unit: string } {
	const row = displayOf(unit, display);
	return row ? { value: value * row.scale + row.offset, unit: display } : { value, unit };
}

/** Round to converted precision. */
export function fromDisplay(value: number, unit: string, display: string): number {
	const row = displayOf(unit, display);
	return row ? roundTo((value - row.offset) / row.scale, CONVERTED_DECIMALS) : value;
}
