import { parseConsoleExpression } from "./live-console-grammar.js";
import { caseKey } from "./schemasAssistantRules.js";
import type { IssueCause } from "./schemasAutomationSave.js";

/** Exact event field member. */
export function choiceFieldOf(subject: string): string | null {
	const { node, issues } = parseConsoleExpression(subject);
	if (!node || issues.length > 0 || node.grouped || node.kind !== "member" || !node.closed) return null;
	const { target } = node;
	return target.kind === "ident" && target.name === "event" && !target.grouped ? node.name : null;
}

export type SwitchCause = Extract<IssueCause, "empty_case" | "repeated_value" | "vanished">;

export interface SwitchIssue {
	cause: SwitchCause;
	case: number;
	/** Chip index, except empty. */
	chip?: number;
	value?: string;
}

/** Text choices are unrestricted. */
const offeredBy = (choices: readonly string[] | null): ((key: string) => boolean) => {
	if (choices === null) return () => true;
	const offered = new Set(choices.map(caseKey));
	return (key) => offered.has(key);
};

/** Causes, never levels; see docs/fields.md. */
export function switchIssues(
	step: { cases: readonly { values: readonly string[] }[] },
	choices: readonly string[] | null,
): SwitchIssue[] {
	const offered = offeredBy(choices);
	const seen = new Set<string>();
	const issues: SwitchIssue[] = [];
	step.cases.forEach((held, at) => {
		if (held.values.length === 0) issues.push({ cause: "empty_case", case: at });
		held.values.forEach((value, chip) => {
			const key = caseKey(value);
			if (seen.has(key)) issues.push({ cause: "repeated_value", case: at, chip, value });
			else if (!offered(key)) issues.push({ cause: "vanished", case: at, chip, value });
			seen.add(key);
		});
	});
	return issues;
}

/** Vanished values take default. */
export function caseTaken(
	cases: readonly { values: readonly string[] }[],
	shown: string,
	choices: readonly string[] | null,
): number {
	const key = caseKey(shown);
	if (!offeredBy(choices)(key)) return cases.length;
	const found = cases.findIndex((held) => held.values.some((value) => caseKey(value) === key));
	return found < 0 ? cases.length : found;
}
