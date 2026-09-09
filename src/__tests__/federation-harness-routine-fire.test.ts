import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nudgeFor } from "../gateway/routines/execution.js";
import type { Occurrence } from "../gateway/routines/occurrences.js";
import type { Routine } from "../shared/schemasRoutine.js";
import { composeSessionName } from "../shared/session-id.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

/** A Monday, an hour before the routine's time. */
const TAKEN_AT = Date.parse("2026-09-14T08:00:00Z");
const SLOT = Date.parse("2026-09-14T09:00:00Z");

describe("federation harness: a routine firing on its own", () => {
	let h: FederationHarness;
	const sessions: FakeSession[] = [];
	let clock = TAKEN_AT;

	beforeAll(async () => {
		h = await startFederationHarness({ wakeTimeoutMs: 300, now: () => clock });
	}, 30_000);
	afterAll(async () => {
		for (const attached of sessions) attached.close();
		if (h) await h.close();
	});

	const routine: Routine = {
		id: "triage",
		name: "Morning triage",
		weekdays: [1],
		weekInterval: 1,
		startDate: "2026-09-14",
		time: "09:00",
		zone: "UTC",
		runbookId: "triage",
		approvedRevision: 1,
		values: { branch: "main" },
		target: { spawn: "host" },
		linkedEntries: [],
		enabled: true,
		revision: 1,
		since: 0,
	};

	/** Only what `nudgeFor` reads. */
	const occurrenceAt = (scheduledAt: number): Occurrence => ({
		routineId: "triage",
		scheduledAt,
		deadlineAt: scheduledAt,
		state: "dispatched",
		version: 1,
	});

	it("reserves its own session, nudges it, and never nudges the same slot twice", async () => {
		await h.phone.value({
			kind: "runbook_put",
			runbook: {
				id: "triage",
				name: "Triage",
				body: "Read the overnight failures on {{branch}}.",
				parameters: [{ name: "branch", label: "Branch", kind: "text" }],
				revision: 1,
			},
		});
		const saved = await h.phone.value({ kind: "routine_put", routine });
		expect(saved.result).toMatchObject({ stored: true });

		// The session comes up because the routine asked for it.
		let reserved: FakeSession | undefined;
		h.host.handlers.onCreateSession = (op) => {
			if (op.target.sessionName !== "routine-triage" || reserved) return;
			reserved = attachFakeSession(h.gateway, {
				team: composeSessionName(op.target.name, op.target.sessionName),
				conversationId: "conv-routine-triage",
				sessionToken: op.sessionToken,
			});
			sessions.push(reserved);
		};

		clock = SLOT + 60_000;
		await h.gateway.faults.sweepRoutines();

		const nudge = nudgeFor(routine, occurrenceAt(SLOT));
		// Its own session, not one borrowed.
		expect(reserved).toBeDefined();
		await h.waitFor(
			async () => reserved?.inbound.find((frame) => frame.body === nudge),
			"the routine's nudge in its own session",
		);

		const listed = await h.phone.value({ kind: "routine_list" });
		expect(listed.result).toMatchObject({ routines: [{ lastRanAt: SLOT }] });

		clock = SLOT + 120_000;
		await h.gateway.faults.sweepRoutines();
		expect(reserved?.inbound.filter((frame) => frame.body === nudge)).toHaveLength(1);

		// Next week reaches the same session.
		const nextWeek = SLOT + 7 * 24 * 60 * 60 * 1000;
		clock = nextWeek + 60_000;
		await h.gateway.faults.sweepRoutines();
		const second = nudgeFor(routine, { ...occurrenceAt(SLOT), scheduledAt: nextWeek });
		await h.waitFor(
			async () => reserved?.inbound.find((frame) => frame.body === second),
			"next week's nudge in the same session",
		);

		await h.phone.value({ kind: "routine_delete", routineId: "triage" });
	});

	it("refuses a routine whose runbook moved, and leaves the occurrence for the owner to see", async () => {
		// A later Monday, taken an hour before its slot.
		const slot = SLOT + 21 * 24 * 60 * 60 * 1000;
		clock = slot - 60 * 60 * 1000;
		await h.phone.value({
			kind: "runbook_put",
			runbook: {
				id: "moved",
				name: "Moved",
				body: "Do the first thing.",
				parameters: [],
				revision: 1,
			},
		});
		await h.phone.value({
			kind: "routine_put",
			routine: { ...routine, id: "drifts", runbookId: "moved", values: {} },
		});
		const moved = await h.phone.value({
			kind: "runbook_put",
			runbook: { id: "moved", name: "Moved", body: "Do a different thing.", parameters: [], revision: 2 },
			baseRevision: 1,
		});
		expect(moved.result).toMatchObject({ stored: true, revision: 2 });

		clock = slot + 60_000;
		await h.gateway.faults.sweepRoutines();

		const listed = await h.phone.value({ kind: "routine_list" });
		const rows = (listed.result as { routines: Array<{ routine: { id: string } } & Record<string, unknown>> })
			.routines;
		const drifts = rows.find((row) => row.routine.id === "drifts");
		expect(drifts).toMatchObject({ reviewAt: slot });
		expect(drifts?.lastRanAt).toBeUndefined();
	});
});
