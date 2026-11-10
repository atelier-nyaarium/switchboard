import { describe, expect, it } from "vitest";
import {
	AWAY_RETRY_MS,
	createLaunchRecords,
	createLaunchSubscriber,
	type LaunchJoin,
	type LaunchRecordsDeps,
	type LaunchRelay,
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
	/** Senders with a session record. */
	const known = new Set<string>();
	const deps: LaunchRecordsDeps = {
		durable: {
			saveChecked: (state) => {
				disk = state;
			},
			load: () => disk,
		},
		now: () => clock.now,
		timeoutMs: TIMEOUT,
		countdownFrom: (team) => (countdown.has(team) ? (countdown.get(team) ?? null) : 0),
		isLive: () => false,
		senderKnown: (sessionKey) => known.has(sessionKey),
		inFlight: () => false,
		withdraw: () => {},
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
	return { clock, countdown, link, cancel, forgotten, relayed, known, records, join, tick };
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
