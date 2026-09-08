import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOccurrenceStore } from "../gateway/routines/occurrences.js";
import { DurableStore } from "../shared/durable-store.js";
import { canTransition, isTerminal, OCCURRENCE_STATES } from "../shared/routine-occurrence.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

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

	it("keeps a routine's newest miss and newest review however old, and drops the rest", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "routine-occurrence-"));
		roots.push(root);
		const occurrences = createOccurrenceStore({ store: new DurableStore(root, "occurrences") });
		const settle = (at: number, to: "missed" | "needs_review" | "dispatched") => {
			occurrences.open("triage", at, at + 1);
			occurrences.transition("triage", at, { state: "due", version: 1 }, to);
		};
		settle(100, "missed");
		settle(200, "missed");
		settle(300, "needs_review");
		settle(400, "dispatched");

		occurrences.sweep(1000);

		// The panel and the reason it stopped running both outlive the cutoff; what ran does not.
		expect(occurrences.forRoutine("triage").map((row) => [row.scheduledAt, row.state])).toEqual([
			[200, "missed"],
			[300, "needs_review"],
		]);
	});

	it("rejects a stale version and preserves state after a failed durable write", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "routine-occurrence-"));
		roots.push(root);
		const durable = new DurableStore(root, "occurrences");
		const occurrences = createOccurrenceStore({ store: durable });
		const opened = occurrences.open("triage", 100, 200);
		expect(opened?.version).toBe(1);

		const moved = occurrences.transition("triage", 100, { state: "due", version: 1 }, "waiting_idle");
		expect(moved?.version).toBe(2);
		expect(occurrences.transition("triage", 100, { state: "due", version: 1 }, "missed")).toBeNull();

		vi.spyOn(durable, "saveChecked").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		expect(occurrences.transition("triage", 100, { state: "waiting_idle", version: 2 }, "prepared")).toBeNull();
		expect(occurrences.at("triage", 100)?.state).toBe("waiting_idle");
		expect(JSON.parse(fs.readFileSync(path.join(root, "occurrences.json"), "utf8"))[0].state).toBe("waiting_idle");
	});
});
