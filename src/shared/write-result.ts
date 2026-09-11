export type WriteResultLike =
	| { kind: "ok" }
	| { kind: "conflict" }
	| { kind: "durability_failure" }
	| { kind: "durability_uncertain" }
	| { kind: "quarantined" };

export type WriteOutcome = "accepted" | "conflict" | "durability_failure" | "durability_uncertain";

export interface FoldedWrite {
	/** In memory; not proof the line landed. */
	applied: boolean;
	outcome: WriteOutcome;
}

/** The line is on disk. What follows may be irreversible. */
export function landed(result: { kind: string }): boolean {
	return result.kind === "ok";
}

/** The write took effect here, perhaps durably. What follows must be retryable. */
export function appliedOrUncertain(result: { kind: string }): boolean {
	return result.kind === "ok" || result.kind === "durability_uncertain";
}

// Preserve applied writes; quarantine is uncertain.
export function foldWriteResult(result: WriteResultLike): FoldedWrite {
	switch (result.kind) {
		case "ok":
			return { applied: true, outcome: "accepted" };
		case "durability_uncertain":
			return { applied: true, outcome: "durability_uncertain" };
		case "conflict":
			return { applied: false, outcome: "conflict" };
		case "durability_failure":
			return { applied: false, outcome: "durability_failure" };
		case "quarantined":
			return { applied: false, outcome: "durability_uncertain" };
		default:
			return assertNever(result);
	}
}

function assertNever(value: never): never {
	throw new Error(`unhandled write result ${JSON.stringify(value)}`);
}
