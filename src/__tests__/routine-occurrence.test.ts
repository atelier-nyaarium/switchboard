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

	it("floors the work window when a run files its report, and a second filing cannot widen it", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "routine-occurrence-"));
		roots.push(root);
		const occurrences = createOccurrenceStore({ store: new DurableStore(root, "occurrences") });
		const TWELVE_HOURS = 43_200_000;
		occurrences.open("triage", 100, 100 + TWELVE_HOURS);
		occurrences.transition("triage", 100, { state: "due", version: 1 }, "prepared");
		occurrences.transition("triage", 100, { state: "prepared", version: 2 }, "dispatched", {
			work: "started",
			workUntil: 100 + TWELVE_HOURS,
		});

		const filed = occurrences.noteReport("triage", 100, "apt upgraded, nothing held back", 500, 500 + 1_800_000);
		expect(filed?.workUntil).toBe(500 + 1_800_000);
		expect(filed?.report).toBe("apt upgraded, nothing held back");
		expect(filed?.reportedAt).toBe(500);

		// Correcting the words is fine. Buying another half hour is not, or a session holds its
		// routine's secrets open indefinitely, one report at a time.
		const again = occurrences.noteReport("triage", 100, "also cleaned the cache", 900, 900 + 1_800_000);
		expect(again?.workUntil).toBe(500 + 1_800_000);
		expect(again?.report).toBe("also cleaned the cache");
		expect(again?.reportedAt).toBe(500);
	});

	it("takes no report for a run that was never dispatched", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "routine-occurrence-"));
		roots.push(root);
		const occurrences = createOccurrenceStore({ store: new DurableStore(root, "occurrences") });
		occurrences.open("triage", 100, 200);

		expect(occurrences.noteReport("triage", 100, "spoke early", 150, 160)).toBeNull();
		expect(occurrences.noteReport("triage", 999, "no such run", 150, 160)).toBeNull();
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
