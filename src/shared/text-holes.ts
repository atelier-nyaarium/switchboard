import { lexConsoleText } from "./live-console-grammar.js";

export const hasHoles = (text: string): boolean => lexConsoleText(text).some((part) => part.kind === "hole");

/** What a hole that could not be read prints. */
export const HOLE_FAILED = "{?}";

/** The text with every hole marked unread. */
export const unreadText = (text: string): string =>
	lexConsoleText(text)
		.map((part) => (part.kind === "hole" ? HOLE_FAILED : part.value))
		.join("");

export const unescapedText = (text: string): string =>
	lexConsoleText(text)
		.map((part) => (part.kind === "hole" ? text.slice(part.start, part.end) : part.value))
		.join("");
