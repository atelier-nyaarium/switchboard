function reasonIn(value: unknown): string | null {
	if (value === null || typeof value !== "object") return null;
	const answer = value as { ok?: unknown; error?: unknown; errorKind?: unknown };
	if (typeof answer.error === "string" && answer.error.length > 0) return answer.error;
	if (answer.ok !== false) return null;
	return typeof answer.errorKind === "string" ? answer.errorKind : "refused";
}

/** A Router answer carries the transport failure at the top and the tool's refusal under `result`. */
function refusalOf(answer: unknown): string | null {
	const top = reasonIn(answer);
	if (top) return top;
	const nested = (answer as { result?: unknown } | null)?.result;
	return nested === undefined ? null : reasonIn(nested);
}

/** Watch discarded work. */
export function fireAndForget(label: string, work: Promise<unknown>, onFailure?: () => void): void {
	void work.then(
		(result) => {
			const refused = refusalOf(result);
			if (!refused) return;
			console.warn(`[${label}] failed: ${refused}`);
			onFailure?.();
		},
		(error) => {
			console.warn(`[${label}] failed: ${error instanceof Error ? error.message : String(error)}`);
			onFailure?.();
		},
	);
}
