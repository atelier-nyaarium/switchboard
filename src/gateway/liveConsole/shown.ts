import { oneLine } from "../../shared/system-reminder.js";

export function numberText(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function shownText(value: unknown): string | null {
	if (value === null || value === undefined) return "none";
	if (typeof value === "string") return oneLine(value);
	if (typeof value === "number") return numberText(value);
	if (typeof value === "boolean") return value ? "yes" : "no";
	return isRecord(value) && typeof value.shown === "string" ? value.shown : null;
}
