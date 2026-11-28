import { lexConsoleText } from "./live-console-grammar.js";

export const hasPlaceholders = (text: string): boolean =>
	lexConsoleText(text).some((part) => part.kind === "placeholder");

/** What a placeholder that could not be read prints. */
export const PLACEHOLDER_FAILED = "{?}";

/** The text with every placeholder marked unread. */
export const unreadText = (text: string): string =>
	lexConsoleText(text)
		.map((part) => (part.kind === "placeholder" ? PLACEHOLDER_FAILED : part.value))
		.join("");

export const unescapedText = (text: string): string =>
	lexConsoleText(text)
		.map((part) => (part.kind === "placeholder" ? text.slice(part.start, part.end) : part.value))
		.join("");
