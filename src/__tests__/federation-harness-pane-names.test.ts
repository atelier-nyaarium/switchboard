import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { takenReason } from "../gateway/routines/reservation.js";
import { type Routine, routineSessionName } from "../shared/schemasRoutine.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

describe("a host session's name, one pane on every host spawn point", () => {
	let h: FederationHarness;

	const create = async (spawn: string, sessionName: string) => {
		const { result } = await h.phone.value({
			kind: "create_session",
			target: h.target(spawn),
			sessionName,
			harness: "claude",
		});
		expect(result).toMatchObject({ created: true });
	};

	beforeAll(async () => {
		h = await startFederationHarness({ host: { hostSpawns: ["windows"] } });
		await h.phone.value({
			kind: "runbook_put",
			runbook: { id: "book", name: "Book", body: "do the thing", parameters: [], revision: 1 },
		});
	}, 30_000);
	afterAll(async () => {
		if (h) await h.close();
	});

	it("refuses a phone's wake of a row whose name another host spawn point holds, waking nothing", async () => {
		await create("host", "shared-wake");
		const wakes = h.host.wakes.length;

		const { result } = await h.phone.value({
			kind: "wake",
			target: h.target("windows.shared-wake"),
			harness: "claude",
		});

		expect(result).toMatchObject({ kind: "refusal" });
		expect(h.host.wakes).toHaveLength(wakes);
	});

	const routineOf = (id: string): Routine => ({
		id,
		name: id,
		weekdays: [1],
		weekInterval: 1,
		startDate: "2026-09-07",
		time: "09:00",
		zone: "America/Los_Angeles",
		runbookId: "book",
		approvedRevision: 1,
		values: {},
		target: { spawn: "host", cli: "claude" },
		linkedEntries: [],
		forgetAfterDays: 7,
		enabled: true,
		revision: 1,
		since: 0,
	});

	it("refuses to save a routine whose name another host spawn point holds", async () => {
		const routine = routineOf("saved");
		await create("windows", routineSessionName(routine.id));

		const { result } = await h.phone.value({ kind: "routine_put", routine });

		expect(result).toMatchObject({ stored: false, reason: takenReason(routine) });
	});

	it("stops a routine for review when its name is taken on another host spawn point after it was saved", async () => {
		const routine = routineOf("elsewhere");
		const saved = await h.phone.value({ kind: "routine_put", routine });
		await create("windows", routineSessionName(routine.id));
		const creates = h.host.ops.filter((op) => op.kind === "createSession").length;

		await h.phone.value({ kind: "routine_run", routineId: routine.id });
		const review = await h.waitFor(async () => {
			const { result } = await h.phone.value({ kind: "routine_list" });
			const held = (result as { routines: Array<{ routine: Routine; reviewReason?: string }> }).routines.find(
				(row) => row.routine.id === routine.id,
			);
			return held?.reviewReason;
		}, "the review");

		expect(saved.result).toMatchObject({ stored: true });
		expect(review).toBe(takenReason(routine));
		expect(h.host.ops.filter((op) => op.kind === "createSession")).toHaveLength(creates);
	});
});
