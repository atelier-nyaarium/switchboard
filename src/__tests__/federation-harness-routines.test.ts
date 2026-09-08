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

	it("carries a routine from the phone to the gateway's store and back", async () => {
		const saved = await h.phone.value({ kind: "routine_put", routine });
		expect(saved.result).toMatchObject({ stored: true, revision: 1 });

		const listed = await h.phone.value({ kind: "routine_list" });
		expect(listed.result).toMatchObject({ routines: [{ routine: { id: "r1", name: "Morning triage" } }] });

		const off = await h.phone.value({ kind: "routine_enable", routineId: "r1", enabled: false });
		expect(off.result).toMatchObject({ stored: true, revision: 2 });

		const gone = await h.phone.value({ kind: "routine_delete", routineId: "r1" });
		expect(gone.result).toEqual({ deleted: true });
	});

	it("refuses a schedule the gateway cannot read, naming what it could not", async () => {
		const refused = await h.phone.value({
			kind: "routine_put",
			routine: { ...routine, id: "bad", zone: "Mars/Olympus" },
		});
		expect(refused.result).toMatchObject({ stored: false });
	});

	it("answers the occurrence operations without a runner, rather than throwing", async () => {
		for (const kind of ["routine_run_now", "routine_dismiss"] as const) {
			const { result } = await h.phone.value({ kind, routineId: "r1", occurrenceId: "o1" });
			expect(result, kind).toMatchObject({ applied: false });
		}

		// Still answering afterwards, which a thrown handler taking the socket down would not.
		const listed = await h.phone.value({ kind: "runbook_list" });
		expect(listed.result).toMatchObject({ runbooks: [] });
	});
});
