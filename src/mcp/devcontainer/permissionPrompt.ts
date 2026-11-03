import { createHash, randomBytes } from "node:crypto";
import { paneRegion } from "../../shared/agent-screen.js";

////////////////////////////////
//  Interfaces & Types

export interface PromptOption {
	digit: number;
	label: string;
}

/** A permission dialog holding the pane. */
export interface PermissionPrompt {
	/** Ignores width, cursor and countdown. Repeats with the same text. */
	contentId: string;
	title: string;
	body: string[];
	question: string;
	options: PromptOption[];
	/** Digit under the cursor. */
	cursor: number;
	/** Auto-deny countdown running. */
	autoDeny: boolean;
}

////////////////////////////////
//  Functions & Helpers

// Explicit class: the Windows build emits U+00A0.
const SPACE = "[ \\t\\u00a0]";
const FOOTER_RE = new RegExp(`^${SPACE}*Esc to cancel`, "u");
const OPTION_RE = new RegExp(`^${SPACE}*(?:([❯>])${SPACE}*)?(\\d+)\\.${SPACE}+(.*)$`, "u");
const DASHED_RE = /╌{3,}/u;
const WARNING_RE = new RegExp(`^${SPACE}*⚠`, "u");
const COUNTDOWN_RE = /\b\d+:\d{2}\b/u;
const GUTTER_RE = new RegExp(`^${SPACE}?(?:│${SPACE}?)?`, "u");
const SQUASH_RE = new RegExp(`${SPACE}+`, "gu");
const MAX_BODY_ROWS = 60;
const MAX_ROW_CHARS = 240;

/**
 * The permission dialog below the composer's rule, or null.
 *
 * Needs a first option of Yes and a No option, since an answer presses them.
 */
export function permissionPrompt(screen: string): PermissionPrompt | null {
	const rows = paneRegion(screen, "toolbar").map((row) => row.trimEnd());
	const footer = lastFilled(rows, rows.length);
	if (footer < 0 || !FOOTER_RE.test(rows[footer])) return null;
	const first = menuStart(rows, footer);
	if (first < 0) return null;
	const menu = readMenu(rows.slice(first, footer));
	if (!menu?.options[0].label.startsWith("Yes") || noOption(menu.options) === null) return null;
	const ask = lastFilled(rows, first);
	if (ask < 0 || !rows[ask].endsWith("?")) return null;
	const top = rows.findIndex((row) => row.trim() !== "");
	if (top < 0 || top >= ask) return null;

	const head = rows.slice(top + 1, ask);
	const dashes = head.flatMap((row, i) => (DASHED_RE.test(row) ? [i] : []));
	const warning = head.findIndex((row) => WARNING_RE.test(row));
	const stable = warning < 0 ? head : head.slice(0, warning);
	const raw = dashes.length >= 2 ? head.slice(dashes[0] + 1, dashes[1]) : stable;
	const title = rows[top].trim().slice(0, MAX_ROW_CHARS);
	const question = rows[ask].trim();
	return {
		contentId: contentIdOf([rows[top], ...stable.filter((row) => !DASHED_RE.test(row)), question]),
		title,
		body: displayRows(raw),
		question,
		options: menu.options,
		cursor: menu.cursor,
		autoDeny: warning >= 0 && head.slice(warning).some((row) => COUNTDOWN_RE.test(row)),
	};
}

/** A prompt with its occurrence id. */
export interface SeenPrompt extends PermissionPrompt {
	id: string;
}

/** Reads `screen` and stamps the occurrence for pane `key`. */
export function seePrompt(occurrences: PromptOccurrences, key: string, screen: string): SeenPrompt | null {
	const prompt = permissionPrompt(screen);
	const id = occurrences.see(key, prompt?.contentId ?? null);
	return prompt && id ? { ...prompt, id } : null;
}

/** Digit of the No option. */
export function noOption(options: PromptOption[]): number | null {
	const no = options.find((option) => option.label === "No" || option.label.startsWith("No,"));
	return no ? no.digit : null;
}

function lastFilled(rows: string[], before: number): number {
	for (let i = before - 1; i >= 0; i--) if (rows[i].trim() !== "") return i;
	return -1;
}

/** Bottom-up, so a numbered list in the body is never the menu. */
function menuStart(rows: string[], footer: number): number {
	for (let i = footer - 1; i >= 0; i--) {
		const option = OPTION_RE.exec(rows[i]);
		if (option?.[2] === "1") return i;
		if (!option && rows[i].trim().endsWith("?")) return -1;
	}
	return -1;
}

function readMenu(rows: string[]): { options: PromptOption[]; cursor: number } | null {
	const options: PromptOption[] = [];
	let cursor = 0;
	for (const row of rows) {
		const option = OPTION_RE.exec(row);
		if (option) {
			const digit = Number(option[2]);
			if (digit !== options.length + 1) return null;
			if (option[1]) {
				if (cursor) return null;
				cursor = digit;
			}
			options.push({ digit, label: option[3].trim() });
		} else if (row.trim() && options.length) {
			options[options.length - 1].label += ` ${row.trim()}`;
		}
	}
	return options.length >= 2 && cursor ? { options, cursor } : null;
}

function displayRows(rows: string[]): string[] {
	const shown = rows.map((row) => row.replace(GUTTER_RE, "").slice(0, MAX_ROW_CHARS));
	while (shown.length && !shown[0].trim()) shown.shift();
	while (shown.length && !shown[shown.length - 1].trim()) shown.pop();
	return shown.slice(0, MAX_BODY_ROWS);
}

/** Whitespace dropped, so a rewrap keeps the id. */
function contentIdOf(rows: string[]): string {
	const text = rows.map((row) => row.replace(SQUASH_RE, "")).join("");
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Stamps a prompt's content id with its occurrence, so the same text asked again is a new prompt.
 *
 * A pane's occurrence moves whenever what it shows changes, prompt or none. The epoch is minted per
 * process, so an id never repeats across a restart.
 */
export class PromptOccurrences {
	private readonly held = new Map<string, { content: string | null; n: number }>();

	constructor(private readonly epoch: string = randomBytes(4).toString("hex")) {}

	/** The id of what pane `key` shows now. */
	see(key: string, contentId: string | null): string | null {
		const at = this.held.get(key) ?? { content: null, n: 0 };
		if (at.content !== contentId) this.held.set(key, { content: contentId, n: at.n + 1 });
		const n = this.held.get(key)?.n ?? 0;
		return contentId === null ? null : `${contentId}.${this.epoch}.${n}`;
	}
}
