// A routine's whole life on a clock this file sets by hand. Every assertion is what a session
// received or what the phone was shown; store bookkeeping is nobody's business here.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nudgeFor } from "../gateway/routines/execution.js";
import type { Occurrence } from "../gateway/routines/occurrences.js";
import { GRACE_MS } from "../gateway/routines/runner.js";
import type { Routine, RoutineState } from "../shared/schemasRoutine.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

/** Mondays at 09:00 UTC. */
const FIRST = Date.parse("2026-09-14T09:00:00Z");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TEAM = "host.routine-triage";

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

/** Only what `nudgeFor` reads, which is the scheduled instant. */
const occurrenceAt = (scheduledAt: number): Occurrence => ({
	routineId: routine.id,
	scheduledAt,
	deadlineAt: scheduledAt + GRACE_MS,
	state: "dispatched",
	version: 1,
});

describe("federation harness: a routine's schedule on a hand-set clock", () => {
	let h: FederationHarness;
	const sessions: FakeSession[] = [];
	let reserved: FakeSession | undefined;
	let creations = 0;
	/**
	 * Real time, moved to wherever the scenario says. It has to flow rather than stand still: a timer
	 * the runner arms fires against a real clock, and a frozen one would never reach its own instant.
	 * It starts a few seconds before the first slot, wide enough that the routine is saved before the
	 * slot passes, since a routine is never handed a run from before it existed.
	 */
	let offset = FIRST - 3_000 - Date.now();
	const now = (): number => Date.now() + offset;
	/** Minted per launch. A reconnecting plugin presents the one its record still holds. */
	let token: string | undefined;

	const attach = (): FakeSession => {
		reserved = attachFakeSession(h.gateway, {
			team: TEAM,
			conversationId: `conv-routine-${creations}`,
			sessionToken: token,
		});
		sessions.push(reserved);
		return reserved;
	};

	beforeAll(async () => {
		h = await startFederationHarness({
			now,
			wakeTimeoutMs: 300,
			host: {
				onCreateSession: (op) => {
					if (op.target.sessionName !== "routine-triage") return;
					// A reserve reattaches a session that is already up. Only a real launch brings a
					// plugin with it, and a second one here would take the nudges out of view.
					if (reserved) return;
					creations += 1;
					token = op.sessionToken;
					attach();
				},
			},
		});
	}, 30_000);

	afterAll(async () => {
		for (const attached of sessions) attached.close();
		if (h) await h.close();
	});

	/** Time passed and the gateway looks again. Nothing swept in between, which is the honest gap. */
	const at = async (instant: number): Promise<void> => {
		offset = instant - Date.now();
		await h.gateway.faults.sweepRoutines();
	};

	const rows = async (): Promise<RoutineState[]> => {
		const listed = await h.phone.value({ kind: "routine_list" });
		return (listed.result as { routines: RoutineState[] }).routines;
	};
	const shown = async (): Promise<RoutineState | undefined> =>
		(await rows()).find((row) => row.routine.id === routine.id);

	const nudges = (scheduledAt: number): number =>
		reserved?.inbound.filter((frame) => frame.body === nudgeFor(routine, occurrenceAt(scheduledAt))).length ?? 0;

	it("fires when its own timer reaches the instant, with nothing else prodding it", async () => {
		const stored = await h.phone.value({
			kind: "runbook_put",
			runbook: {
				id: "triage",
				name: "Triage",
				body: "Read the overnight failures on {{branch}}.",
				parameters: [{ name: "branch", label: "Branch", kind: "text" }],
				revision: 1,
			},
		});
		expect(stored.result).toMatchObject({ stored: true });
		expect((await h.phone.value({ kind: "routine_put", routine })).result).toMatchObject({ stored: true });

		// No sweep is asked for here. Saving rearms, and the timer it armed asks the host for the
		// session, which nothing else in this test could have done.
		await h.waitFor(async () => creations === 1 || undefined, "the session its own timer asked for");

		// A session being launched is not one that can be nudged yet, so the run lands on the look after.
		await at(FIRST + 60_000);
		await h.waitFor(async () => nudges(FIRST) === 1 || undefined, "the first nudge");
		expect((await shown())?.lastRanAt).toBe(FIRST);
	});

	it("hands the session back the words it was issued, and nobody else's", async () => {
		const mine = await reserved?.post("/routine/session", { occurrenceId: String(FIRST) });
		expect(await mine?.json()).toMatchObject({
			kind: "instructions",
			routineName: "Morning triage",
			text: "Read the overnight failures on main.",
		});

		const other = await reserved?.post("/routine/session", { occurrenceId: "1" });
		expect(await other?.json()).toEqual({ kind: "unknown_occurrence" });

		// Reading is what the owner is shown, since a session that woke and did something else is not
		// the same as one that never picked the routine up.
		expect((await shown())?.lastReadAt).toBeGreaterThanOrEqual(FIRST);
	});

	it("waits while its session is busy rather than firing into it", async () => {
		h.host.reportWorking(TEAM, true);
		await at(FIRST + WEEK_MS + 60_000);

		expect(nudges(FIRST + WEEK_MS)).toBe(0);
		// Still inside its window, so the owner is told nothing yet.
		expect((await shown())?.missed).toBeUndefined();
	});

	it("gives up at twelve hours, and says which cause it was waiting on", async () => {
		await at(FIRST + WEEK_MS + GRACE_MS + 60_000);

		const row = await shown();
		expect(row?.missed).toMatchObject({ scheduledAt: FIRST + WEEK_MS, reason: "session_busy", runnable: false });
		expect(nudges(FIRST + WEEK_MS)).toBe(0);
	});

	it("reads its routines back from disk after a restart", async () => {
		const before = await shown();
		await h.restartGateway();
		// The plugin reconnects to the new process on the token its record still holds.
		attach();

		const after = await shown();
		expect(after?.routine).toEqual(before?.routine);
		expect(after?.missed).toEqual(before?.missed);
		// Answering a run issued before the restart means the snapshot came back too.
		const answer = await reserved?.post("/routine/session", { occurrenceId: String(FIRST) });
		expect(await answer?.json()).toMatchObject({ kind: "instructions" });
	});

	it("catches up on a gap it slept through, and folds it into one panel", async () => {
		h.host.reportWorking(TEAM, false);
		// Two more Mondays go by with nothing sweeping, and then it looks again.
		await at(FIRST + 3 * WEEK_MS + 60_000);

		const row = await shown();
		// One panel for the whole gap, naming the latest slot past its window rather than one per
		// Monday. The Monday still inside its window is not a miss at all: it runs.
		expect(row?.missed).toMatchObject({ scheduledAt: FIRST + 2 * WEEK_MS, reason: "gateway_down" });
		await h.waitFor(async () => nudges(FIRST + 3 * WEEK_MS) === 1 || undefined, "the caught-up nudge");
	});

	it("runs a missed occurrence once when the owner asks, and a following sweep adds no second", async () => {
		// Turned off while a run was already waiting, which is the one miss the owner can still run.
		const slot = FIRST + 4 * WEEK_MS;
		h.host.reportWorking(TEAM, true);
		await at(slot + 60_000);
		const off = await h.phone.value({ kind: "routine_enable", routineId: routine.id, enabled: false });
		expect(off.result).toMatchObject({ stored: true });
		await h.gateway.faults.sweepRoutines();

		const missed = (await shown())?.missed;
		expect(missed).toMatchObject({ scheduledAt: slot, reason: "disabled", runnable: true });

		const on = await h.phone.value({ kind: "routine_enable", routineId: routine.id, enabled: true });
		expect(on.result).toMatchObject({ stored: true });
		h.host.reportWorking(TEAM, false);
		// Started together, since the point is that the owner's run and an automatic one cannot both
		// deliver. One loop owns the occurrence, so whichever reaches it second finds it dispatched.
		const [ran] = await Promise.all([
			h.phone.value({
				kind: "routine_run_now",
				routineId: routine.id,
				occurrenceId: missed?.occurrenceId as string,
			}),
			h.gateway.faults.sweepRoutines(),
		]);
		expect(ran.result).toMatchObject({ applied: true });
		await h.waitFor(async () => nudges(slot) === 1 || undefined, "the nudge the owner asked for");

		await h.gateway.faults.sweepRoutines();
		expect(nudges(slot)).toBe(1);
		// Settled, so the panel falls back to the older miss it never answered, named exactly.
		expect((await shown())?.missed?.scheduledAt).toBe(FIRST + 2 * WEEK_MS);
	});

	it("stops rather than running words the owner has not read, and says so on the phone", async () => {
		const moved = await h.phone.value({
			kind: "runbook_put",
			runbook: {
				id: "triage",
				name: "Triage",
				body: "Read the overnight failures on {{branch}}, then page me.",
				parameters: [{ name: "branch", label: "Branch", kind: "text" }],
				revision: 2,
			},
			baseRevision: 1,
		});
		expect(moved.result).toMatchObject({ stored: true, revision: 2 });

		const slot = FIRST + 5 * WEEK_MS;
		await at(slot + 60_000);

		expect((await shown())?.reviewAt).toBe(slot);
		expect(nudges(slot)).toBe(0);
	});

	it("keeps answering the words a run was issued with, a revision later", async () => {
		// What a compaction leaves: the session remembers nothing and asks again. Its runbook moved
		// two weeks after this run was issued, and that move may not rewrite what was asked of it.
		const answer = await reserved?.post("/routine/session", {
			occurrenceId: String(FIRST + 3 * WEEK_MS),
		});
		expect(await answer?.json()).toMatchObject({ text: "Read the overnight failures on main." });
	});

	it("settles a dismissal once, so a second phone tapping it changes nothing", async () => {
		// The owner approves the new words, which clears the review and lets it schedule again. The
		// held record is what a save rebases on; the one this file declares is several revisions old.
		const held = (await shown())?.routine as Routine;
		const approved = await h.phone.value({
			kind: "routine_put",
			routine: { ...held, approvedRevision: 2 },
			baseRevision: held.revision,
		});
		expect(approved.result).toMatchObject({ stored: true });
		const slot = FIRST + 6 * WEEK_MS;
		h.host.reportWorking(TEAM, true);
		await at(slot + GRACE_MS + 60_000);

		const missed = (await shown())?.missed;
		expect(missed?.scheduledAt).toBe(slot);

		// Another of the owner's phones, which read the same panel and still holds it.
		const other = h.phoneFor(h.set);
		const alsoShown = (
			(await other.value({ kind: "routine_list" })).result as { routines: RoutineState[] }
		).routines.find((row) => row.routine.id === routine.id);
		expect(alsoShown?.missed?.occurrenceId).toBe(missed?.occurrenceId);

		const first = await h.phone.value({
			kind: "routine_dismiss",
			routineId: routine.id,
			occurrenceId: missed?.occurrenceId as string,
		});
		expect(first.result).toMatchObject({ applied: true });

		// The other phone taps the panel it is still holding, which is now settled.
		const second = await other.value({
			kind: "routine_dismiss",
			routineId: routine.id,
			occurrenceId: alsoShown?.missed?.occurrenceId as string,
		});
		expect(second.result).toMatchObject({ applied: false });
		// Named exactly, since "not that slot" would also pass on a panel that never showed it.
		expect((await shown())?.missed?.scheduledAt).toBe(FIRST + 2 * WEEK_MS);
	});

	it("makes its session again when the owner forgets it, rather than stopping forever", async () => {
		h.host.reportWorking(TEAM, false);
		const before = creations;
		// Forget is a delivery op, not a value one, and it lands as a result row in the inbox.
		const opId = "forget-triage";
		expect((await h.phone.deliver(TEAM, { kind: "forget", target: TEAM }, opId)).outcome).toBe("accepted");
		await h.waitFor(
			async () => h.gateway.faults.sessionRecord(TEAM) === undefined || undefined,
			"the session record gone",
		);
		// Forgetting takes the session's process with it, so there is nothing left to reattach to.
		reserved?.close();
		reserved = undefined;

		const slot = FIRST + 7 * WEEK_MS;
		await at(slot + 60_000);

		await h.waitFor(async () => (creations > before ? creations : undefined), "the session made again");
		// Made rather than reattached, so this run lands on the look after, as the first one did.
		await at(slot + 120_000);
		await h.waitFor(async () => nudges(slot) === 1 || undefined, "the nudge in the new session");
	});
});
