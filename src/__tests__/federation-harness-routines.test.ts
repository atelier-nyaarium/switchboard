import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

/** The wire exists before the runner does, so every routine op must refuse rather than crash. */
describe("federation harness: routine operations without a runner", () => {
	let h: FederationHarness;
	beforeAll(async () => {
		h = await startFederationHarness();
	}, 30_000);
	afterAll(async () => {
		if (h) await h.close();
	});

	const routine = {
		id: "r1",
		name: "Morning triage",
		weekdays: [1],
		weekInterval: 1,
		startDate: "2026-09-07",
		time: "09:00",
		zone: "America/Los_Angeles",
		runbookId: "triage",
		approvedRevision: 1,
		values: {},
		target: { spawn: "host" },
		enabled: true,
		revision: 1,
	};

	it("refuses each one, and the gateway keeps serving", async () => {
		const ops = [
			{ kind: "routine_list" as const },
			{ kind: "routine_put" as const, routine },
			{ kind: "routine_delete" as const, routineId: "r1" },
			{ kind: "routine_enable" as const, routineId: "r1", enabled: false },
			{ kind: "routine_run_now" as const, routineId: "r1", occurrenceId: "o1" },
			{ kind: "routine_dismiss" as const, routineId: "r1", occurrenceId: "o1" },
		];
		for (const op of ops) {
			const { result } = await h.phone.value(op);
			expect(result, op.kind).toMatchObject({ kind: "refusal" });
		}

		// Still answering afterwards, which a thrown handler taking the socket down would not.
		const listed = await h.phone.value({ kind: "runbook_list" });
		expect(listed.result).toMatchObject({ runbooks: [] });
	});
});
