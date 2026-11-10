import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { takenReason } from "../gateway/routines/reservation.js";
import type { HostOp } from "../shared/host-op.js";
import { type Routine, routineSessionName } from "../shared/schemasRoutine.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
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

		const opId = "op-wake-shared";
		const target = h.target("windows.shared-wake");
		await h.phone.deliver("windows.shared-wake", { kind: "wake", target, harness: "claude" }, opId);
		const row = await h.waitFor(
			async () =>
				(await h.phone.inboxRead()).find(
					(held) => held.envelope.kind === "op_result" && held.envelope.opKey.opId === opId,
				),
			"the wake's answer",
		);

		expect(h.phone.open(row)).toMatchObject({ ok: false, error: expect.stringContaining('"host.shared-wake"') });
		expect(h.host.wakes).toHaveLength(wakes);
	});

	const routineOf = (id: string, target: Routine["target"] = { spawn: "host", cli: "claude" }): Routine => ({
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
		target,
		linkedEntries: [],
		forgetAfterDays: 7,
		enabled: true,
		revision: 1,
		since: 0,
	});

	const listed = async (id: string) => {
		const { result } = await h.phone.value({ kind: "routine_list" });
		return (result as { routines: Array<{ routine: Routine; reviewReason?: string }> }).routines.find(
			(row) => row.routine.id === id,
		);
	};
	const opsOn = (id: string) =>
		h.host.frames.flatMap((frame) => {
			const [spawn, session] = String(frame.team ?? "").split(".");
			if (frame.type === "wake" && frame.door === "create" && session === routineSessionName(id))
				return [`create ${spawn}`];
			const op = frame.op as HostOp | undefined;
			if (
				frame.type === "host_op" &&
				op?.kind === "killSession" &&
				op.target.sessionName === routineSessionName(id)
			)
				return [`kill ${op.target.name}`];
			return [];
		});

	it("refuses to save a routine whose name another host spawn point holds", async () => {
		const routine = routineOf("saved");
		await create("windows", routineSessionName(routine.id));

		const { result } = await h.phone.value({ kind: "routine_put", routine });

		expect(result).toMatchObject({ stored: false });
		expect(await listed(routine.id)).toBeUndefined();
	});

	it("names the holder when it refuses to save a routine whose pane another host spawn point holds", async () => {
		const routine = routineOf("named-holder");
		await create("windows", routineSessionName(routine.id));

		const { result } = await h.phone.value({ kind: "routine_put", routine });

		expect(result).toMatchObject({ stored: false, reason: takenReason(routine, "windows.routine-named-holder") });
	});

	it("stops a routine for review when its name is taken on another host spawn point after it was saved", async () => {
		const routine = routineOf("elsewhere");
		const saved = await h.phone.value({ kind: "routine_put", routine });
		await create("windows", routineSessionName(routine.id));
		const before = opsOn(routine.id);

		await h.phone.value({ kind: "routine_run", routineId: routine.id });
		const review = await h.waitFor(async () => (await listed(routine.id))?.reviewReason, "the review");

		expect(saved.result).toMatchObject({ stored: true });
		expect(review).toBe(takenReason(routine, "windows.routine-elsewhere"));
		expect(opsOn(routine.id)).toEqual(before);
	});

	it("retires a routine's own session when the routine moves to another host spawn point", async () => {
		const routine = routineOf("mover", { spawn: "windows", cli: "claude" });
		let own: FakeSession | undefined;
		h.host.handlers.onCreateSession = (create) => {
			own ??= attachFakeSession(h.gateway, {
				team: create.team,
				conversationId: "conv-mover",
				sessionToken: create.sessionToken,
			});
		};
		const first = await h.phone.value({ kind: "routine_put", routine });
		await h.phone.value({ kind: "routine_run", routineId: routine.id });
		await h.waitFor(() => own, "the first reserve's session");
		await own?.ready();
		h.host.handlers.onCreateSession = undefined;
		// Launch over, pane gone.
		own?.close();

		const moved = await h.phone.value({
			kind: "routine_put",
			routine: { ...routine, target: { spawn: "host", cli: "claude" }, revision: 2 },
			baseRevision: (first.result as { revision: number }).revision,
		});
		await h.phone.value({ kind: "routine_run", routineId: routine.id });
		await h.waitFor(() => opsOn(routine.id)[2], "the reserve after the move");

		expect(moved.result).toMatchObject({ stored: true });
		expect(opsOn(routine.id)).toEqual(["create windows", "kill windows", "create host"]);
		expect((await listed(routine.id))?.reviewReason).toBeUndefined();
	});
});
