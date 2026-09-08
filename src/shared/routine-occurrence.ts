// Which transitions exist, and what each one is called. Pure, so the runner cannot invent one.

/**
 * `dispatched`, `missed` and `dismissed` are terminal. `needs_review` is terminal for the occurrence
 * and cleared only by re-saving the routine, which supersedes it.
 */
export const OCCURRENCE_STATES = [
	"due",
	"waiting_idle",
	"prepared",
	"dispatched",
	"missed",
	"dismissed",
	"needs_review",
] as const;

export type OccurrenceState = (typeof OCCURRENCE_STATES)[number];

/** Every move the runner may make, named by where it comes from. */
const ALLOWED: Readonly<Record<OccurrenceState, readonly OccurrenceState[]>> = {
	due: ["waiting_idle", "prepared", "needs_review", "missed"],
	waiting_idle: ["prepared", "missed"],
	prepared: ["dispatched", "missed"],
	// Run now carries a fresh authorization, and Dismiss closes the panel.
	missed: ["dispatched", "dismissed"],
	dispatched: [],
	dismissed: [],
	needs_review: [],
};

export function canTransition(from: OccurrenceState, to: OccurrenceState): boolean {
	return ALLOWED[from].includes(to);
}

export function isTerminal(state: OccurrenceState): boolean {
	return ALLOWED[state].length === 0;
}

/** Why an occurrence never ran. A deadline is shared by all of these; a story is not. */
export const MISS_REASONS = ["gateway_down", "session_busy", "host_unreachable", "disabled", "not_delivered"] as const;

export type MissReason = (typeof MISS_REASONS)[number];
