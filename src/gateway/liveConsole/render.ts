import type { ConsoleIssue } from "../../shared/live-console-grammar.js";
import {
	CONSOLE_INSTANT_CEILING,
	CONSOLE_INSTANT_FLOOR,
	CONSOLE_INSTANT_KEYS,
} from "../../shared/schemasLiveConsole.js";
import { neutralizeMarkup, oneLine } from "../../shared/system-reminder.js";
import { EntityRef } from "./evaluate.js";
import { describeEntity, entityText } from "./registry.js";

export const CONSOLE_TEXT_BYTES = 16 * 1024;
export const CONSOLE_TEXT_BYTES_MAX = 64_000;
export const CONSOLE_ITEMS_DEFAULT = 50;
const NESTED_ITEMS = 5;
const DEPTH_MAX = 3;
const TEXT_MAX = 200;
const INSTANT_KEYS: ReadonlySet<string> = new Set(CONSOLE_INSTANT_KEYS);

export interface RenderOptions {
	now: number;
	/** Top-level items shown. */
	limit?: number;
	maxBytes?: number;
}

export interface Rendered {
	text: string;
	cut?: { shown: number; total: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isInstant = (value: number, key: string | undefined) =>
	key !== undefined &&
	INSTANT_KEYS.has(key) &&
	Number.isInteger(value) &&
	value > CONSOLE_INSTANT_FLOOR &&
	value <= CONSOLE_INSTANT_CEILING;

function ageText(at: number, now: number): string {
	const ago = Math.abs(Math.round((now - at) / 1000));
	const span =
		ago < 45
			? `${ago} s`
			: ago < 2_700
				? `${Math.round(ago / 60)} min`
				: ago < 129_600
					? `${Math.round(ago / 3_600)} h`
					: `${Math.round(ago / 86_400)} days`;
	const when = new Date(at).toISOString().replace("T", " ").slice(0, 19);
	return `${now >= at ? `${span} ago` : `in ${span}`} (${when}Z)`;
}

export function numberText(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function scalarText(value: unknown, key: string | undefined, now: number): string {
	if (value === null || value === undefined) return "none";
	if (typeof value === "number") return isInstant(value, key) ? ageText(value, now) : numberText(value);
	if (typeof value === "boolean") return value ? "yes" : "no";
	const text = neutralizeMarkup(oneLine(String(value)));
	return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}… (${text.length} chars)` : text;
}

const isBlock = (value: unknown) =>
	(Array.isArray(value) && value.length > 0) || (isRecord(value) && Object.keys(value).length > 0);

function block(value: unknown, depth: number, now: number, indent: string): string[] {
	if (Array.isArray(value)) {
		if (depth >= DEPTH_MAX) return [`${indent}[${value.length} items]`];
		const shown = value.slice(0, NESTED_ITEMS);
		const lines = shown.flatMap((item) => itemLines(item, depth, now, indent));
		if (value.length > shown.length) lines.push(`${indent}… ${value.length - shown.length} more`);
		return lines;
	}
	if (isRecord(value)) {
		if (depth >= DEPTH_MAX) return [`${indent}{${Object.keys(value).length} fields}`];
		return Object.entries(value).flatMap(([key, field]) => {
			const label = neutralizeMarkup(oneLine(key));
			return isBlock(field)
				? [`${indent}${label}:`, ...block(field, depth + 1, now, `${indent}  `)]
				: [
						`${indent}${label}: ${Array.isArray(field) ? "[]" : isRecord(field) ? "{}" : scalarText(field, key, now)}`,
					];
		});
	}
	return [`${indent}${scalarText(value, undefined, now)}`];
}

function itemLines(item: unknown, depth: number, now: number, indent: string): string[] {
	if (!isBlock(item)) return [`${indent}- ${scalarText(item, undefined, now)}`];
	const [head, ...rest] = block(item, depth + 1, now, `${indent}  `);
	return [`${indent}- ${(head ?? "").trimStart()}`, ...rest];
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Reserved for cut notices. */
const FOOTER_BYTES = 128;

/** Keep complete lines only. */
function fitLines(lines: readonly string[], budget: number): { kept: string[]; used: number; cut: boolean } {
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		const size = bytes(line) + 1;
		if (used + size > budget) return { kept, used, cut: true };
		kept.push(line);
		used += size;
	}
	return { kept, used, cut: false };
}

export function renderConsoleValue(value: unknown, options: RenderOptions): Rendered {
	const now = options.now;
	const maxBytes = Math.min(options.maxBytes ?? CONSOLE_TEXT_BYTES, CONSOLE_TEXT_BYTES_MAX);
	const budget = maxBytes - FOOTER_BYTES;
	if (value instanceof EntityRef) return { text: entityText(describeEntity(value.entity)).join("\n") };
	if (!Array.isArray(value)) {
		const fitted = fitLines(block(value, 0, now, ""), budget);
		return {
			text: [...fitted.kept, ...(fitted.cut ? [`… cut at ${maxBytes} bytes; narrow the expression`] : [])].join(
				"\n",
			),
		};
	}
	if (value.length === 0) return { text: "(empty list)" };
	const limit = options.limit ?? CONSOLE_ITEMS_DEFAULT;
	const lines: string[] = [];
	let used = 0;
	let shown = 0;
	for (const item of value) {
		if (shown >= limit) break;
		const fitted = fitLines(itemLines(item, 0, now, ""), budget - used);
		if (fitted.cut && shown > 0) break;
		lines.push(...fitted.kept);
		used += fitted.used;
		shown++;
		if (fitted.cut) {
			lines.push(`… item cut at ${maxBytes} bytes; narrow the expression`);
			break;
		}
	}
	if (shown === value.length) return { text: lines.join("\n") };
	lines.push(`… ${value.length - shown} more of ${value.length}; add .skip(${shown})`);
	return { text: lines.join("\n"), cut: { shown, total: value.length } };
}

export function renderConsoleIssue(source: string, issue: ConsoleIssue): string {
	// Preserve source offsets.
	const line = source.replace(/\s/g, " ");
	const shown = neutralizeMarkup(line);
	// Escaped openers shift columns.
	const column = (at: number) => shown.length - neutralizeMarkup(line.slice(Math.min(at, line.length))).length;
	const start = column(issue.start);
	const width = Math.max(1, column(issue.end) - start);
	return [
		`error ${issue.code}: ${neutralizeMarkup(oneLine(issue.message))}`,
		`  ${shown}`,
		`  ${" ".repeat(start)}${"^".repeat(width)}`,
	].join("\n");
}
