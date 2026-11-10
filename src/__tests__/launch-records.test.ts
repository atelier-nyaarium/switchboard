import { describe, expect, it } from "vitest";
import {
	AWAY_RETRY_MS,
	createLaunchRecords,
	createLaunchSubscriber,
	type LaunchJoin,
	type LaunchRecordsDeps,
	type LaunchRelay,
	launchOutcome,
	OWNER_LAUNCH_KEY,
} from "../gateway/launchRecords.js";
import type { AwarenessObservation } from "../shared/awareness-types.js";
import type { LaunchNotice } from "../shared/launch-notice.js";

const TIMEOUT = 1_000;
const TEAM = "app.abc123";

function rig(stored: unknown = null) {
	const clock = { now: 10_000 };
	let disk: unknown = stored;
	const countdown = new Map<string, number | null>();
	const link: { current: object | undefined } = { current: {} };
	const cancel = { reaches: true, attempts: [] as object[], reached: [] as object[], named: [] as unknown[] };
	const forgotten: string[] = [];
	const observed: AwarenessObservation<LaunchNotice>[] = [];
	const relayed: Array<{ relay: LaunchRelay; notice: LaunchNotice }> = [];
	/** Owner lines; stored or not. */
	const owner = { told: [] as unknown[], stores: true };
	/** Routine runs told; taken or not. */
	const routines = { told: [] as unknown[], takes: true };
	const live = new Set<string>();
	/** Senders with a session record. */
	const known = new Set<string>();
	const writes = { fail: false };
	const withdrawn: string[] = [];
	/** Launch countdown, else team's; null while building. */
	const countdownOf = (team: string, launchId: string | undefined): number | null => {
		const key = launchId !== undefined && countdown.has(launchId) ? launchId : team;
		return countdown.has(key) ? (countdown.get(key) ?? null) : 0;
	};
	const deps: LaunchRecordsDeps = {
		durable: {
			saveChecked: (state) => {
				if (writes.fail) throw new Error("disk full");
				disk = state;
			},
			load: () => disk,
		},
		now: () => clock.now,
		timeoutMs: TIMEOUT,
		countdownFrom: countdownOf,
		isLive: (team) => live.has(team),
		senderKnown: (sessionKey) => known.has(sessionKey),
		inFlight: () => false,
		withdraw: (delivery) => withdrawn.push(delivery.deliveryId),
		forgetCreated: (team) => forgotten.push(team),
		hostLink: () => link.current,
		cancel: (team, launchId) => {
			const at = link.current as object;
			cancel.attempts.push(at);
			cancel.named.push([team, launchId]);
			if (cancel.reaches) cancel.reached.push(at);
			return cancel.reaches;
		},
		observe: (observations) => observed.push(...observations),
		relay: async (relay, notice) => {
			relayed.push({ relay, notice });
			return false;
		},
		tellOwner: (team, outcome) => {
			owner.told.push([team, outcome]);
			return owner.stores;
		},
		tellRoutine: (run, outcome, team) => {
			routines.told.push([run, outcome, team]);
			return routines.takes;
		},
	};
	const records = createLaunchRecords(deps);
	const join = (over: Partial<LaunchJoin> = {}) =>
		records.join({
			team: TEAM,
			address: `d.g.${TEAM}`,
			created: false,
			sessionKey: "sender",
			delivery: { deliveryId: `d-${observed.length}`, channelJobId: "job" },
			foreign: false,
			...over,
		});
	/** Notices the last tick handed the bank. */
	const tick = () => {
		observed.length = 0;
		records.tick();
		return [...observed];
	};
	return {
		clock,
		countdown,
		link,
		cancel,
		forgotten,
		relayed,
		known,
		owner,
		routines,
		live,
		writes,
		withdrawn,
		records,
		join,
		tick,
		disk: () => disk,
	};
}

const failed = (observations: AwarenessObservation<LaunchNotice>[]) =>
	observations.filter((observation) => observation.post?.kind === "failed");

describe("a launch a send waits on", () => {
	it("times nothing out while the container builds, then counts from the later of the launch and the container", () => {
		const r = rig();
		r.countdown.set(TEAM, null);
		r.join();

		r.clock.now += 10 * TIMEOUT;
		const whileBuilding = r.tick();
		r.countdown.set(TEAM, r.clock.now - 500);
		const halfway = r.tick();
		r.clock.now += 500;
		const atWindow = r.tick();

		expect([whileBuilding, halfway]).toEqual([[], []]);
		expect(failed(atWindow)).toEqual([
			expect.objectContaining({
				sessionKey: "sender",
				post: expect.objectContaining({ failure: { kind: "timeout" } }),
			}),
		]);
	});

	it("answers a send that joins after its launch failed with that failure, and withdraws its row", () => {
		const r = rig();
		r.records.open(TEAM, "L1", false, false);
		r.records.settle(TEAM, { failure: { kind: "stopped" } }, "L1");
		r.join({ launchId: "L1" });

		expect(r.withdrawn).toEqual(["d-0"]);
		expect(failed(r.tick())).toEqual([
			expect.objectContaining({
				sessionKey: "sender",
				post: expect.objectContaining({ failure: { kind: "stopped" } }),
			}),
		]);
	});

	it("counts from the launch's own start when the countdown began before it", () => {
		const r = rig();
		r.countdown.set(TEAM, 0);
		r.join();

		r.clock.now += TIMEOUT - 1;
		const justBefore = r.tick();
		r.clock.now += 1;

		expect(justBefore).toEqual([]);
		expect(failed(r.tick())).toHaveLength(1);
	});

	it("cancels a failed create's pane once per host link, and again on a new link", () => {
		const r = rig();
		const first = r.link.current;
		r.join({ created: true });

		r.records.settle(TEAM, { failure: { kind: "error", reason: "no pane" } });
		r.tick();
		r.tick();
		r.link.current = {};
		r.tick();
		r.tick();

		expect(r.cancel.reached).toEqual([first, r.link.current]);
	});

	it("gives up only a create no owner claimed: its pane cancelled by launch, its record forgotten", () => {
		const r = rig();
		r.records.open("app.created", "launch-created", true, false);
		r.records.open("app.woken", "launch-woken", false, false);
		r.records.open("app.claimed", "launch-claimed", true, false);
		r.records.open("app.owned", "launch-owned", true, true);
		r.records.retain("launch-claimed");

		r.clock.now += TIMEOUT;
		r.tick();

		expect(r.cancel.named).toEqual([["app.created", "launch-created"]]);
		expect(r.forgotten).toEqual(["app.created"]);
	});

	it("counts each launch riding one pane from its own container", () => {
		const r = rig();
		r.records.open(TEAM, "launch-a", false, false);
		r.join({ launchId: "launch-a", sessionKey: "first" });
		r.records.open(TEAM, "launch-b", false, false);
		r.join({ launchId: "launch-b", sessionKey: "second" });
		r.countdown.set("launch-a", r.clock.now);
		r.countdown.set("launch-b", r.clock.now + 500);

		r.clock.now += TIMEOUT;
		const atFirst = failed(r.tick()).map((notice) => notice.sessionKey);
		r.clock.now += 500;

		expect(atFirst).toEqual(["first"]);
		expect(failed(r.tick()).map((notice) => notice.sessionKey)).toEqual(["first", "second"]);
	});

	it("covers every launch of the session with the owner's claim, an older unclaimed create included", () => {
		const r = rig();
		r.records.open(TEAM, "launch-older", true, false);
		r.records.open(TEAM, "launch-claimed", true, true);
		r.records.open("app.other", "launch-other", true, false);
		r.records.open("app.other", "launch-retained", true, false);
		r.records.retain("launch-retained");

		r.clock.now += TIMEOUT;
		r.tick();

		expect(r.cancel.named).toEqual([]);
		expect(r.forgotten).toEqual([]);
	});

	it("names an opened launch by its team until a send names its address", () => {
		const r = rig();
		r.records.open(TEAM, "launch-a", false, false);
		const opened = (r.disk() as Array<{ address?: string }>)[0];
		r.join({ launchId: "launch-a", address: "d.g.app.abc123" });
		r.records.settle(TEAM, { up: true }, "launch-a");

		expect(opened.address).toBe(TEAM);
		expect(r.tick().map((notice) => notice.post)).toEqual([{ kind: "up", address: "d.g.app.abc123" }]);
	});

	it("keeps a pruned launch's cancel when the prune cannot be written, so the cancel is not sent again", () => {
		const r = rig();
		r.join({ created: true });
		r.records.settle(TEAM, { failure: { kind: "error", reason: "no pane" } });
		const [notice] = r.tick();
		r.records.markTold(notice.identity, notice.sessionKey);
		const sent = r.cancel.attempts.length;

		r.writes.fail = true;
		r.tick();
		r.tick();
		r.tick();

		expect(sent).toBe(1);
		expect(r.cancel.attempts).toHaveLength(sent);
	});

	it("leaves a newer launch alone when an older launch's result arrives late", () => {
		const r = rig();
		r.records.open(TEAM, "launch-new", false, false);
		r.join({ launchId: "launch-new" });

		r.records.settle(TEAM, { failure: { kind: "error", reason: "the old pane" } }, "launch-old");
		const afterOld = r.tick();
		r.records.settle(TEAM, { up: true }, "launch-new");

		expect(afterOld).toEqual([]);
		expect(r.tick().map((notice) => notice.post?.kind)).toEqual(["up"]);
	});

	it("settles a launch stored before launches had ids, by any result for its team", () => {
		const legacy = {
			team: TEAM,
			address: `d.g.${TEAM}`,
			created: false,
			startedAt: 10_000,
			stage: { kind: "launching" },
			requesters: [
				{
					sessionKey: "sender",
					deliveries: [{ deliveryId: "d", channelJobId: "job" }],
					told: false,
					foreign: false,
				},
			],
		};
		const r = rig([legacy]);

		r.records.settle(TEAM, { failure: { kind: "error", reason: "no pane" } }, "launch-any");

		expect(failed(r.tick()).map((notice) => notice.sessionKey)).toEqual(["sender"]);
	});

	it("holds a failed create until a cancel reaches the daemon, even once every sender was told", () => {
		const r = rig();
		r.cancel.reaches = false;
		r.join({ created: true });
		r.records.settle(TEAM, { failure: { kind: "error", reason: "no pane" } });
		const [notice] = r.tick();
		r.records.markTold(notice.identity, notice.sessionKey);

		const told = r.cancel.attempts.length;
		r.tick();
		r.tick();
		const retried = r.cancel.attempts.length - told;
		r.cancel.reaches = true;
		r.tick();
		const reached = r.cancel.attempts.length;
		r.link.current = {};
		r.tick();

		expect(retried).toBe(2);
		expect(r.cancel.reached).toHaveLength(1);
		expect(r.cancel.attempts).toHaveLength(reached);
	});

	it("tells another Domain's sender why without the project path or the daemon's words", () => {
		const r = rig();
		const relay: LaunchRelay = { srcGateway: "far", srcSession: "far.app.s", dstDomainId: "bob" };
		r.join({ sessionKey: "local" });
		r.join({ sessionKey: "foreign", foreign: true, relay });
		r.join({ team: "app.other", sessionKey: "foreign", foreign: true, relay });

		r.records.settle(TEAM, { failure: { kind: "container", spawn: "app", projectPath: "/home/me/app" } });
		r.records.settle("app.other", { failure: { kind: "error", reason: "secret daemon text" } });
		const local = r.tick();

		expect(failed(local).map((observation) => observation.post)).toEqual([
			expect.objectContaining({ failure: { kind: "container", spawn: "app", projectPath: "/home/me/app" } }),
		]);
		expect(r.relayed.map(({ notice }) => notice)).toEqual([
			expect.objectContaining({ foreign: true, failure: { kind: "container", spawn: "app" } }),
			expect.objectContaining({ foreign: true, failure: { kind: "error", reason: expect.any(String) } }),
		]);
		expect(JSON.stringify(r.relayed)).not.toContain("secret daemon text");
	});

	it("tells the owner and a waiting routine run directly, each until it takes the word, never through the bank", () => {
		const r = rig();
		const run = { routineId: "triage", scheduledAt: 5 };
		const failure = { kind: "error", reason: "no pane" } as const;
		r.records.open(TEAM, "launch-a", true, true);
		r.join({ launchId: "launch-a", sessionKey: OWNER_LAUNCH_KEY, owner: true, delivery: undefined });
		r.join({ launchId: "launch-a", sessionKey: "routine:triage:5", routine: run, delivery: undefined });
		r.records.settle(TEAM, { failure }, "launch-a");
		const launching = r.records.launching(TEAM);

		r.owner.stores = false;
		r.routines.takes = false;
		const untaken = r.tick();
		const awaitedUntold = r.records.awaits(run);
		r.owner.stores = true;
		r.routines.takes = true;
		const taken = r.tick();
		r.tick();

		expect(launching).toBe(false);
		expect([untaken, taken]).toEqual([[], []]);
		expect([awaitedUntold, r.records.awaits(run)]).toEqual([true, false]);
		expect(r.owner.told).toEqual([
			[TEAM, { failure }],
			[TEAM, { failure }],
		]);
		expect(r.routines.told).toEqual([
			[run, { failure }, TEAM],
			[run, { failure }, TEAM],
		]);
	});

	it("refuses a watch alone with no launch holding its team, and drops a launch abandoned before anyone joined", () => {
		const r = rig();
		const watch = {
			sessionKey: "routine:triage:5",
			routine: { routineId: "triage", scheduledAt: 5 },
			delivery: undefined,
		};

		const alone = r.join(watch);
		r.records.open(TEAM, "launch-a", true, false);
		r.records.abandon("launch-a");
		const afterAbandon = r.records.launching(TEAM);
		r.records.open(TEAM, "launch-b", true, false);
		const held = r.join({ ...watch, launchId: "launch-b" });
		r.records.abandon("launch-b");

		expect([alone, afterAbandon]).toEqual([false, false]);
		expect([held, r.records.launching(TEAM)]).toEqual([true, true]);
	});

	it("leaves a waiter's timeout to the tick, which reads a live team up, and reads a failure up while live", () => {
		const timedOut = rig();
		timedOut.records.open(TEAM, "launch-a", false, false);
		timedOut.join({ launchId: "launch-a" });
		timedOut.records.settle(TEAM, launchOutcome({ ok: false, errorKind: "timeout" }), "launch-a");
		const stillLaunching = timedOut.records.launching(TEAM);
		timedOut.live.add(TEAM);
		const cameUp = timedOut.tick();

		const late = rig();
		late.records.open(TEAM, "launch-b", false, false);
		late.join({ launchId: "launch-b" });
		late.live.add(TEAM);
		late.records.settle(TEAM, { failure: { kind: "error", reason: "after registering" } }, "launch-b");

		expect(stillLaunching).toBe(true);
		expect(cameUp.map((notice) => notice.post?.kind)).toEqual(["up"]);
		expect(late.tick().map((notice) => notice.post?.kind)).toEqual(["up"]);
	});

	it("asks a reconnecting sender the bank gave up on again after a while, and stops telling a forgotten one", () => {
		const r = rig();
		const subscriber = createLaunchSubscriber(() => r.records);
		r.known.add("away");
		r.join({ sessionKey: "away" });
		r.join({ sessionKey: "gone" });
		r.records.settle(TEAM, { failure: { kind: "timeout" } });
		for (const notice of r.tick()) {
			subscriber.dropped?.(notice.sessionKey, { identity: notice.identity, pre: undefined, post: notice.post });
		}

		r.clock.now += AWAY_RETRY_MS - 1;
		const meanwhile = r.tick();
		r.clock.now += 1;

		expect(meanwhile).toEqual([]);
		expect(r.tick().map((notice) => notice.sessionKey)).toEqual(["away"]);
	});
});
