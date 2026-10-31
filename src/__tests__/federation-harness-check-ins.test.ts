import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nudgeFor } from "../gateway/routines/execution.js";
import type { Occurrence } from "../gateway/routines/occurrences.js";
import { UNPLACED_REASON } from "../gateway/routines/reservation.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import { occurrenceIdOf, type Routine } from "../shared/schemasRoutine.js";
import { SESSION_BASELINE_PATH } from "../shared/session-baseline.js";
import { composeSessionName } from "../shared/session-id.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

const setAssistantHome = async (h: FederationHarness) => {
	const current = await h.phone.homeRead();
	const placed = await h.phone.homePut({
		gatewayId: h.set.gateway.id,
		workdirPath: "~/projects/notes",
		carried: null,
		baseVersion: current.record?.version ?? 0,
	});
	if (!placed.record) throw new Error("the Router did not hold the home choice");
	await h.waitFor(async () => {
		const answer = await h.phone.homeRead();
		return answer.report?.version === placed.record?.version && answer.report?.outcome === "placed"
			? answer
			: undefined;
	}, "the assistant placement report");
	return placed;
};

/** Monday, one hour before check-in. */
const TAKEN_AT = Date.parse("2026-09-14T08:00:00Z");
const SLOT = Date.parse("2026-09-14T09:00:00Z");

describe("federation harness: a check-in reaching the assistant", () => {
	let h: FederationHarness;
	let clock = TAKEN_AT;
	const attached = new Map<string, FakeSession>();
	const attach = (team: string, sessionToken: string | undefined) => {
		const held = attached.get(team);
		if (held) return held;
		const session = attachFakeSession(h.gateway, {
			team,
			conversationId: `conv-${team.replaceAll(".", "-")}`,
			sessionToken,
		});
		attached.set(team, session);
		return session;
	};
	const assistant = () => {
		const session = attached.get(ASSISTANT_TEAM);
		if (!session) throw new Error("the assistant is not attached");
		return session;
	};

	const checkIn: Routine = {
		id: "standup",
		name: "Standup",
		weekdays: [1],
		weekInterval: 1,
		startDate: "2026-09-14",
		time: "09:00",
		zone: "UTC",
		runbookId: "standup",
		approvedRevision: 1,
		values: {},
		target: { kind: "assistant", spawn: "host" },
		linkedEntries: [],
		forgetAfterDays: 7,
		enabled: true,
		revision: 1,
		since: 0,
	};
	const dispatched: Occurrence = {
		routineId: checkIn.id,
		scheduledAt: SLOT,
		deadlineAt: SLOT,
		state: "dispatched",
		version: 1,
	};

	beforeAll(async () => {
		h = await startFederationHarness({ wakeTimeoutMs: 2_000, now: () => clock });
		h.host.handlers.onCreateSession = (op) =>
			void attach(composeSessionName(op.target.name, op.target.sessionName), op.sessionToken);
		h.host.handlers.onWake = (frame) => void attach(String(frame.team), frame.sessionToken as string | undefined);
		await h.phone.value({
			kind: "runbook_put",
			runbook: {
				id: "standup",
				name: "Standup",
				body: "Ask what is blocking today.",
				parameters: [],
				revision: 1,
			},
		});
	}, 60_000);
	afterAll(async () => {
		for (const session of attached.values()) session.close();
		if (h) await h.close();
	});

	it("is refused until the assistant lives on the Gateway", async () => {
		const unplaced = await h.phone.value({ kind: "routine_put", routine: checkIn });
		expect(unplaced.result).toMatchObject({ stored: false, reason: UNPLACED_REASON });

		// The phone offers Assistant only where the answer says check-ins are kept.
		const placed = await setAssistantHome(h);
		const state = (await h.phone.value({ kind: "assistant_state" })).result;
		expect(placed.outcome).toBe("applied");
		expect(state).toMatchObject({ checkIns: true });
		const saved = await h.phone.value({ kind: "routine_put", routine: checkIn });
		expect(saved.result).toMatchObject({ stored: true });
	});

	it("nudges the assistant as the owner and carries the phone hold into its baseline", async () => {
		await h.phone.value({ kind: "assistant_safety", approveEverySend: false });
		clock = SLOT + 60_000;
		await h.phone.claimHold();
		await h.gateway.faults.sweepRoutines();

		const nudge = nudgeFor(checkIn, dispatched);
		await h.waitFor(() => attached.get(ASSISTANT_TEAM)?.inbound.find((frame) => frame.body === nudge), "the nudge");
		const occurrenceId = occurrenceIdOf(checkIn.id, SLOT);
		const instructions = await (await assistant().post("/routine/session", { occurrenceId })).json();
		const baseline = await (await assistant().post(SESSION_BASELINE_PATH, {})).json();

		const { result } = await h.phone.value({
			kind: "create_session",
			target: h.target("host"),
			displayLabel: "Worker",
		});
		const worker = await h.waitFor(() => attached.get(`host.${(result as { id: string }).id}`), "the worker");
		await worker.ready();
		const sent = await (
			await assistant().post("/assistant/send", {
				to: worker.team,
				body: "standup question",
				fromConversationId: assistant().conversationId,
				waitMs: 0,
			})
		).json();

		expect(nudge).toContain(occurrenceId);
		expect(instructions).toMatchObject({ kind: "instructions", text: "Ask what is blocking today." });
		expect(baseline.routines).toEqual([{ occurrenceId, routine: "Standup" }]);
		expect(baseline.assistant.hold).toMatchObject({ kind: "held", label: h.phone.device });
		expect(sent).toMatchObject({ outcome: "sent", guard: "unasked" });
	});
});
