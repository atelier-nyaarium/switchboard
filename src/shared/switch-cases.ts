// A switch's case values: their one comparison and their issues.

import { parseConsoleExpression } from "./live-console-grammar.js";
import { trimRuleValue } from "./schemasAssistantRules.js";

/** Trimmed, then lower case. */
export const caseKey = (value: string): string => trimRuleValue(value).toLowerCase();

/** The field a subject names as exactly `event.<field>`. */
export function choiceFieldOf(subject: string): string | null {
	const { node, issues } = parseConsoleExpression(subject);
	if (!node || issues.length > 0 || node.grouped || node.kind !== "member" || !node.closed) return null;
	const { target } = node;
	return target.kind === "ident" && target.name === "event" && !target.grouped ? node.name : null;
}

/** `empty`: a case with no values; `twice`: a value given before; `vanished`: not one of its choices. */
export type SwitchIssueWhy = "empty" | "twice" | "vanished";

export interface SwitchIssue {
	level: "error" | "warning";
	why: SwitchIssueWhy;
	case: number;
	/** Its place in the case; absent for `empty`. */
	chip?: number;
	value?: string;
}

/** `choices`: the subject's options, when it names a choice field. */
export function switchIssues(
	step: { cases: readonly { values: readonly string[] }[] },
	choices: readonly string[] | null,
): SwitchIssue[] {
	const offered = choices === null ? null : new Set(choices.map(caseKey));
	const seen = new Set<string>();
	const issues: SwitchIssue[] = [];
	step.cases.forEach((held, at) => {
		if (held.values.length === 0) issues.push({ level: "error", why: "empty", case: at });
		held.values.forEach((value, chip) => {
			const key = caseKey(value);
			if (seen.has(key)) issues.push({ level: "error", why: "twice", case: at, chip, value });
			else if (offered && !offered.has(key)) {
				issues.push({ level: "warning", why: "vanished", case: at, chip, value });
			}
			seen.add(key);
		});
	});
	return issues;
}

/** The default is past the last. */
export function caseTaken(cases: readonly { values: readonly string[] }[], shown: string): number {
	const key = caseKey(shown);
	const found = cases.findIndex((held) => held.values.some((value) => caseKey(value) === key));
	return found < 0 ? cases.length : found;
}
