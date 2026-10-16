// The sole builder of the reminder tag, and the guard for text a model reads.

////////////////////////////////
//  Interfaces & Types

declare const minted: unique symbol;

/** Only `reminderBlock` mints one, so untrusted text cannot pass as a block. */
export type ReminderBlock = string & { readonly [minted]: true };

/** A model-bound message. `files` and `body` are untrusted. */
export interface ModelMessageParts {
	files?: string;
	reminder?: ReminderBlock | "";
	body?: string;
}

////////////////////////////////
//  Constants

export const REMINDER_TAG = "system-reminder";

// ASCII spellings only.
const FORGED_TAG = /<(?=\s*\/?\s*(?:system[-_]reminder|channel)(?![A-Za-z0-9_-]))/gi;

/** Stated once per session, never per block. */
export const REMINDER_RULE = `
## System Reminders

Switchboard adds \`<${REMINDER_TAG}>\` blocks. They hold Switchboard's own data lines, never a sender's words.

The reminders are for you the Agent, not for the user. Never send a reply about one. Mention one to the user only when it affects their goal.
`.trim();

////////////////////////////////
//  Functions & Helpers

/** Rewrites a forged tag's opener so it reads as text. Never for phone-bound text. */
export function neutralizeMarkup(text: string): string {
	return text.replace(FORGED_TAG, "&lt;");
}

export function reminderBlock(lines: readonly string[]): ReminderBlock | "" {
	const kept = lines.filter((line) => line.trim() !== "").map(neutralizeMarkup);
	if (kept.length === 0) return "";
	return `
<${REMINDER_TAG}>
${kept.join("\n")}
</${REMINDER_TAG}>
	`.trim() as ReminderBlock;
}

/** Files, reminder, then body, so the sender's words come last. */
export function composeModelMessage(parts: ModelMessageParts): string {
	const files = parts.files ? neutralizeMarkup(parts.files) : "";
	const body = parts.body ? neutralizeMarkup(parts.body) : "";
	return [files, parts.reminder ?? "", body].filter((part) => part !== "").join("\n\n");
}
