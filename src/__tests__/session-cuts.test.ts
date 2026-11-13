import { describe, expect, it } from "vitest";
import { CUT_TOOL_SINCE, createSessionCuts, SUMMARY_WAIT_MS } from "../gateway/sessionCuts.js";
import type { HostOp, HostOpResult } from "../shared/host-op.js";
import type { CutFacts, HostSessionCutResult } from "../shared/schemasSessionCut.js";
import type { SessionRecord } from "../shared/session-store.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const TEAM = "host.work";
const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const TURN = "33333333-3333-4333-8333-333333333333";
const PICK = { at: 1_700_000_000_000, text: "next task" };
const FACTS: CutFacts = {
	target: TURN,
	keepAt: PICK.at,
	keepText: "next task",
	snapped: false,
	keptRows: 40,
	foldedRows: 900,
	keptBytes: 3 << 20,
	sourceBytes: 800 << 20,
};

/** A Gateway around one host session, with a daemon that answers as scripted. */
function world(
	over: {
		built?: HostSessionCutResult;
		checked?: HostSessionCutResult;
		record?: Partial<SessionRecord>;
		killed?: boolean;
		repointed?: boolean;
		woke?: boolean;
	} = {},
) {
	const ambient = fakeAmbient({ drive: "manual" });
	const record: SessionRecord = {
		id: "work",
		sessionLabel: "Work",
		spawn: "host",
		harness: "claude",
		claudeSessionId: OLD,
		lastSeen: 0,
		...over.record,
	};
	const state = {
		live: true,
		busy: false as boolean | undefined,
		launching: false,
		held: false,
		version: CUT_TOOL_SINCE as string | undefined,
	};
	const events: string[] = [];
	const asked: string[] = [];
	const told: string[] = [];
	const ops: HostOp[] = [];
	const cuts = createSessionCuts({
		ambient,
		relayToHost: async (op): Promise<HostOpResult> => {
			ops.push(op);
			if (op.kind === "killSession") {
				if (over.killed === false) return { ok: false, error: "no pane" };
				events.push("close");
				state.live = false;
				return { ok: true, result: { killed: true } };
			}
			if (op.kind !== "sessionCut") return { ok: false, error: "unexpected" };
			if (!op.build) return { ok: true, result: (op.endBefore && over.checked) || { kind: "planned", ...FACTS } };
			events.push("build");
			return { ok: true, result: over.built ?? { kind: "built", conversationId: NEW, ...FACTS } };
		},
		record: (team) => (team === TEAM ? record : undefined),
		ownTerminal: () => true,
		isLive: () => state.live,
		busy: () => state.busy,
		pluginVersion: () => state.version,
		launching: () => state.launching,
		holdWakes: () => {
			state.held = true;
			return () => {
				state.held = false;
			};
		},
		ask: async (request) => {
			asked.push(request.body);
			return null;
		},
		repoint: (_team, conversationId) => {
			if (over.repointed === false) return false;
			events.push(`repoint:${conversationId}${state.held ? ":held" : ""}`);
			record.claudeSessionId = conversationId;
			return true;
		},
		wake: async () => {
			events.push(`wake:${record.claudeSessionId}${state.held ? ":held" : ""}`);
			if (over.woke === false) return { ok: false, error: "no launch" };
			state.live = true;
			return { ok: true };
		},
		closed: () => events.push("ended"),
		tellOwner: (_team, line) => told.push(`${line.title}: ${line.body}`),
	});
	const cutIdOf = () => /cutId "(cut-[0-9a-f]+)"/.exec(asked.at(-1) ?? "")?.[1] ?? "";
	const settle = () => ambient.advance(0);
	return { cuts, state, events, asked, told, ops, record, ambient, cutIdOf, settle };
}

describe("session cuts", () => {
	it("compacts: asks the session, then on its summary closes it, builds at the planned turn, repoints and wakes", async () => {
		const w = world();
		const started = await w.cuts.start(TEAM, "compact", PICK, "Phone");
		const cutId = w.cutIdOf();
		const before = [...w.events];
		const answer = w.cuts.submit(TEAM, cutId, "what happened so far");
		await w.settle();

		expect(started).toEqual({ started: true });
		expect(w.asked[0]).toContain(cutId);
		expect(before).toEqual([]);
		expect(answer).toEqual({ kind: "taken" });
		// The wake comes after the hold lifts, so it reads the repointed record.
		expect(w.events).toEqual(["close", "ended", "build", `repoint:${NEW}:held`, `wake:${NEW}`]);
		const [checked, built] = w.ops.filter((op) => op.kind === "sessionCut").slice(-2);
		expect(checked).toMatchObject({ conversationId: OLD, pick: { uuid: TURN }, endBefore: cutId });
		expect(checked).not.toHaveProperty("build");
		expect(built).toMatchObject({ ...checked, build: { summary: "what happened so far" } });
		expect(w.told).toEqual([expect.stringMatching(/^Compacted: /)]);
	});

	it("leaves the record alone when the build is refused, and wakes the session it closed", async () => {
		const w = world({
			built: { kind: "refused", reason: "end_missing", detail: "the request is not in the file" },
		});
		await w.cuts.start(TEAM, "compact", PICK, "Phone");
		w.cuts.submit(TEAM, w.cutIdOf(), "summary");
		await w.settle();

		expect(w.events).toEqual(["close", "ended", "build", `wake:${OLD}`]);
		expect(w.told).toEqual([expect.stringMatching(/^Compact failed: .*Nothing was changed\.$/)]);
		// The slot is free again.
		expect(await w.cuts.start(TEAM, "compact", PICK, "Phone")).toEqual({ started: true });
	});

	it("never builds over a session it could not close, and wakes the old file when the record could not move", async () => {
		const unclosed = world({ killed: false });
		await unclosed.cuts.start(TEAM, "compact", PICK, "Phone");
		unclosed.cuts.submit(TEAM, unclosed.cutIdOf(), "summary");
		await unclosed.settle();
		const unrecorded = world({ repointed: false });
		await unrecorded.cuts.start(TEAM, "compact", PICK, "Phone");
		unrecorded.cuts.submit(TEAM, unrecorded.cutIdOf(), "summary");
		await unrecorded.settle();
		const asleep = world({ woke: false });
		await asleep.cuts.start(TEAM, "compact", PICK, "Phone");
		asleep.cuts.submit(TEAM, asleep.cutIdOf(), "summary");
		await asleep.settle();

		// A kill that failed may still land.
		expect(unclosed.events).toEqual([`wake:${OLD}`]);
		expect(unclosed.told).toEqual([expect.stringMatching(/^Compact failed: .*Nothing was changed\.$/)]);
		expect(unrecorded.events).toEqual(["close", "ended", "build", `wake:${OLD}`]);
		expect(unrecorded.told).toEqual([expect.stringMatching(/^Compact failed: .*Nothing was changed\.$/)]);
		expect(asleep.events).toEqual(["close", "ended", "build", `repoint:${NEW}:held`, `wake:${NEW}`]);
		expect(asleep.told).toEqual([expect.stringContaining("did not restart")]);
		// Every road lifts the hold.
		expect([unclosed, unrecorded, asleep].map((w) => w.state.held)).toEqual([false, false, false]);
	});

	it("closes nothing while the session keeps working, or when the check before the close refuses", async () => {
		const working = world();
		await working.cuts.start(TEAM, "compact", PICK, "Phone");
		working.state.busy = true;
		working.cuts.submit(TEAM, working.cutIdOf(), "summary");
		await working.ambient.advance(60_000);
		const late = world({ checked: { kind: "refused", reason: "late_message", detail: "a message arrived" } });
		await late.cuts.start(TEAM, "compact", PICK, "Phone");
		late.cuts.submit(TEAM, late.cutIdOf(), "summary");
		await late.settle();

		expect(working.events).toEqual([]);
		expect(working.told).toEqual([expect.stringMatching(/^Compact failed: .*Nothing was changed\.$/)]);
		expect(late.events).toEqual([]);
		expect(late.ops.some((op) => op.kind === "killSession")).toBe(false);
	});

	it("asks no session whose plugin has no summary tool", async () => {
		const old = world();
		old.state.version = "8.14.73";

		expect(await old.cuts.start(TEAM, "compact", PICK, "Phone")).toMatchObject({
			started: false,
			reason: "plugin",
		});
		expect(await old.cuts.plan(TEAM, "compact", PICK)).toMatchObject({ planned: false, reason: "plugin" });
		expect(old.asked).toEqual([]);
	});

	it("takes one summary, for the cut it asked, from the session it asked", async () => {
		const w = world();
		await w.cuts.start(TEAM, "compact", PICK, "Phone");
		const cutId = w.cutIdOf();

		expect(w.cuts.submit(TEAM, "cut-0000000000000000", "x")).toEqual({ kind: "unknown_cut" });
		expect(w.cuts.submit("host.other", cutId, "x")).toEqual({ kind: "unknown_cut" });
		expect(w.cuts.submit(null, cutId, "x")).toEqual({ kind: "unauthenticated" });
		expect(await w.cuts.start(TEAM, "compact", PICK, "Phone")).toMatchObject({
			started: false,
			reason: "in_flight",
		});
		expect(w.cuts.submit(TEAM, cutId, "first")).toEqual({ kind: "taken" });
		expect(w.cuts.submit(TEAM, cutId, "second")).toEqual({ kind: "taken" });
		await w.settle();
		expect(w.ops.filter((op) => op.kind === "sessionCut" && op.build)).toEqual([
			expect.objectContaining({ build: expect.objectContaining({ summary: "first" }) }),
		]);
	});

	it("refuses a session that is working, closed, starting, or not a host Claude session", async () => {
		const reasonOf = async (w: ReturnType<typeof world>, team = TEAM) =>
			(await w.cuts.start(team, "compact", PICK, "Phone")).reason;
		const working = world();
		working.state.busy = true;
		const closed = world();
		closed.state.live = false;
		const starting = world();
		starting.state.launching = true;

		expect(await reasonOf(working)).toBe("busy");
		expect(await reasonOf(closed)).toBe("not_live");
		expect(await reasonOf(starting)).toBe("launching");
		expect(await reasonOf(world({ record: { harness: "copilot" } }))).toBe("cli");
		expect(await reasonOf(world({ record: { spawn: "recipe-app" } }))).toBe("place");
		expect(await reasonOf(world(), "host.gone")).toBe("no_session");
		expect([working, closed, starting].flatMap((w) => [...w.asked, ...w.events])).toEqual([]);
	});

	it("gives up when no summary arrives, and a late one finds no cut", async () => {
		const w = world();
		await w.cuts.start(TEAM, "compact", PICK, "Phone");
		const cutId = w.cutIdOf();
		await w.ambient.advance(SUMMARY_WAIT_MS);

		expect(w.told).toEqual([expect.stringMatching(/^Compact failed: .*Nothing was changed\.$/)]);
		expect(w.cuts.submit(TEAM, cutId, "late")).toEqual({ kind: "unknown_cut" });
		expect(w.events).toEqual([]);
	});

	it("clears a closed session without a summary, and leaves it closed", async () => {
		const w = world();
		w.state.live = false;
		const started = await w.cuts.start(TEAM, "clear", PICK, "Phone");
		await w.settle();

		expect(started).toEqual({ started: true });
		expect(w.asked).toEqual([]);
		expect(w.events).toEqual(["close", "ended", "build", `repoint:${NEW}:held`]);
		expect(w.told).toEqual([expect.stringMatching(/^Compacted: Cleared/)]);
	});

	it("answers a plan with what the cut keeps, and a refusal with its reason alone", async () => {
		const w = world();
		expect(await w.cuts.plan(TEAM, "compact", PICK)).toEqual({
			planned: true,
			keepAt: PICK.at,
			keepText: "next task",
			snapped: false,
			keptRows: 40,
			foldedRows: 900,
			keptBytes: 3 << 20,
			sourceBytes: 800 << 20,
		});
		expect(await w.cuts.plan("host.gone", "compact", PICK)).toEqual({
			planned: false,
			reason: "no_session",
			detail: expect.any(String),
		});
	});
});
