import { describe, expect, it } from "vitest";
import { canTransition, isTerminal, OCCURRENCE_STATES } from "../shared/routine-occurrence.js";

describe("what an occurrence may become", () => {
	it("lets a due occurrence wait, prepare, need review or miss", () => {
		expect(canTransition("due", "waiting_idle")).toBe(true);
		expect(canTransition("due", "prepared")).toBe(true);
		expect(canTransition("due", "needs_review")).toBe(true);
		expect(canTransition("due", "missed")).toBe(true);
		// Never straight to dispatched: preparation is what earns that.
		expect(canTransition("due", "dispatched")).toBe(false);
	});

	it("dispatches only from prepared, or from missed when the owner asks again", () => {
		expect(canTransition("prepared", "dispatched")).toBe(true);
		expect(canTransition("missed", "dispatched")).toBe(true);
		expect(canTransition("waiting_idle", "dispatched")).toBe(false);
	});

	it("holds every terminal state closed", () => {
		for (const state of ["dispatched", "dismissed", "needs_review"] as const) {
			expect(isTerminal(state)).toBe(true);
			for (const to of OCCURRENCE_STATES) expect(canTransition(state, to)).toBe(false);
		}
	});

	it("never lets an occurrence go back to due", () => {
		for (const from of OCCURRENCE_STATES) expect(canTransition(from, "due")).toBe(false);
	});
});
