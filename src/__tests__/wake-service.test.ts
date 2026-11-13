import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { WakeCoordinator } from "../gateway/wake.js";
import { WakeService, type WakeServiceDeps } from "../gateway/wakeService.js";
import type { TeamRegistry, WsData } from "../gateway/wsTypes.js";
import { processAmbient } from "../shared/ambient.js";
import { UNPICKED_WORD } from "../shared/session-harness.js";
import { SessionStore } from "../shared/session-store.js";

/** The wake orchestration's own contract: join semantics, the fast refusals, mint and rollback. */
describe("WakeService", () => {
	function fakeWs(over: Partial<WsData> = {}) {
		return {
			readyState: 1,
			send: () => {},
			data: { virtual: false, handshakeConfirmed: true, ...over },
		} as unknown as ServerWebSocket<WsData>;
	}

	function setup(over: Partial<WakeServiceDeps> = {}) {
		const sessionStore = new SessionStore({ ambient: processAmbient() });
		const registry: TeamRegistry = new Map();
		const wakeCoordinator = new WakeCoordinator(processAmbient());
		const sent: {
			type: string;
			team: string;
			launchId?: string;
			projectPath?: string;
			fresh?: boolean;
			harness?: string;
		}[] = [];
		let launches = 0;
		const hostWs = {
			readyState: 1,
			send: (s: string) => void sent.push(JSON.parse(s)),
			data: { launchIds: true },
		} as unknown as ServerWebSocket<WsData>;
		const presenceCalls: string[] = [];
		const forgotten: string[] = [];
		const presence: WakeServiceDeps["presence"] = {
			wakeStart: (t) => void presenceCalls.push(`wakeStart:${t}`),
			wakeEnd: (t) => void presenceCalls.push(`wakeEnd:${t}`),
			mintOrReattach: (opts) => sessionStore.mintOrReattach(opts),
			forget: (t) => {
				forgotten.push(t);
				return true;
			},
		};
		const service = new WakeService({
			registry,
			sessionStore,
			presence,
			wakeCoordinator,
			isAvailableProject: (n) => n === "recipe-app",
			knownTeamPaths: new Map([["recipe-app", "/proj/recipe-app"]]),
			offlineCatalog: new Map(),
			liveHostSocket: () => hostWs,
			wakeTimeoutMs: 60,
			newLaunchId: () => `launch-${String(++launches).padStart(4, "0")}`,
			...over,
		});
		/** Daemon answers, session registers. */
		const up = (team: string) => {
			const launchId = sent.findLast((frame) => frame.type === "wake" && frame.team === team)?.launchId;
			wakeCoordinator.ackReceived(team, 60_000, launchId);
			wakeCoordinator.notify(team);
		};
		return { service, sessionStore, registry, wakeCoordinator, sent, presenceCalls, forgotten, up };
	}

	it("concurrent wakes for one team join a single launch", async () => {
		const s = setup();
		const first = s.service.tryWakeTeam("proj");
		const second = s.service.tryWakeTeam("proj");
		expect(s.service.isWakeInFlight("proj")).toBe(true);
		expect(s.sent).toHaveLength(1);

		s.up("proj");
		await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
		expect(s.service.isWakeInFlight("proj")).toBe(false);
		// One presence announcement per genuine wake, never one per joiner.
		expect(s.presenceCalls).toEqual(["wakeStart:proj", "wakeEnd:proj"]);
	});

	it("refuses a catalog project fast instead of waiting out the timeout", async () => {
		const s = setup();
		await expect(s.service.tryWakeTeam("recipe-app")).resolves.toEqual({ ok: false });
		expect(s.sent).toHaveLength(0);
	});

	it("reports a live incarnation up rather than relaunching over it", async () => {
		const s = setup();
		s.registry.set("proj", new Map([["s1", fakeWs()]]));
		await expect(s.service.tryWakeTeam("proj")).resolves.toEqual({ ok: true });
		expect(s.sent).toHaveLength(0);
	});

	it("never dispatches a wake over the reserved host-daemon pane", async () => {
		const s = setup();
		await expect(s.service.tryWakeTeam("host.host-daemon")).resolves.toEqual({ ok: false });
		expect(s.sent).toHaveLength(0);
	});

	it("a recordless composite refuses to adopt the typed name, before the host check", async () => {
		const s = setup({ liveHostSocket: () => undefined });
		const result = await s.service.tryWakeTeam("proj.story");
		// The more actionable refusal wins over "disconnected": the send was doomed either way.
		expect(result).toEqual({ ok: false, error: expect.any(String), refusal: { kind: "no_label" } });
	});

	it("a disconnected host answers disconnected instead of holding the timeout", async () => {
		const s = setup({ liveHostSocket: () => undefined });
		await expect(s.service.tryWakeTeam("proj")).resolves.toEqual({ ok: false, errorKind: "disconnected" });
	});

	it("a displayLabel mints an opaque id and the caller learns the real address", async () => {
		const s = setup();
		const wake = s.service.tryWakeTeam("proj.story", { displayLabel: "Story Time", harness: "claude" });
		expect(s.sent).toHaveLength(1);
		const launched = s.sent[0].team;
		// The typed segment is never adopted; the launch targets the minted opaque id.
		expect(launched).not.toBe("proj.story");
		expect(launched.startsWith("proj.")).toBe(true);

		s.up(launched);
		await expect(wake).resolves.toEqual({ ok: true, resolvedTeam: launched });
		expect(s.forgotten).toHaveLength(0);
	});

	it("mints a host session only for a cleared send, and never the typed name", async () => {
		const s = setup();
		const create = { displayLabel: "GitHub Ops", harness: "claude" as const };
		const uncleared = await s.service.tryWakeTeam("host.github-ops", create);
		const before = s.sent.length;
		const wake = s.service.tryWakeTeam("host.github-ops", { ...create, cleared: true });
		const launched = s.sent[0]?.team ?? "";
		s.up(launched);

		expect(uncleared).toMatchObject({ ok: false });
		expect(before).toBe(0);
		expect(launched.startsWith("host.")).toBe(true);
		expect(launched).not.toBe("host.github-ops");
		await expect(wake).resolves.toEqual({ ok: true, resolvedTeam: launched });
	});

	it("joins a wake of a create's minted name to that create's launch", async () => {
		const s = setup();
		const create = s.service.tryWakeTeam("proj.story", { displayLabel: "Story Time", harness: "claude" });
		const launched = s.sent[0].team;
		const byName = s.service.tryWakeTeam(launched);
		s.up(launched);

		await expect(Promise.all([create, byName])).resolves.toEqual([
			{ ok: true, resolvedTeam: launched },
			{ ok: true, resolvedTeam: launched },
		]);
		expect(s.sent).toHaveLength(1);
	});

	it("keeps a create's record when the host link drops mid-launch, so a later wake reattaches", async () => {
		const s = setup();
		const create = s.service.tryWakeTeam("proj.story", { displayLabel: "Story Time", harness: "claude" });
		const launched = s.sent[0].team;
		s.wakeCoordinator.failAll();
		const dropped = await create;
		const again = s.service.tryWakeTeam(launched);
		s.up(launched);

		expect(dropped).toMatchObject({ ok: false, errorKind: "disconnected" });
		expect(s.forgotten).toEqual([]);
		await expect(again).resolves.toEqual({ ok: true });
		expect(s.sent.map((frame) => frame.team)).toEqual([launched, launched]);
	});

	it("records each launch before its wake goes out, and names it on the frame and to every settle listener", async () => {
		const s = setup();
		const events: unknown[] = [];
		s.service.useLedger({
			open: (team, launchId, created, retained) => {
				events.push(["open", team, launchId, created, retained, s.sent.length]);
				return true;
			},
			retain: () => true,
			abandon: (launchId) => events.push(["abandon", launchId]),
		});
		s.service.onSettled((team, result, launchId) => events.push(["settled", team, result.ok, launchId]));

		const create = s.service.tryWakeTeam("proj.story", { displayLabel: "Story Time", harness: "claude" });
		const [frame] = s.sent;
		s.up(frame.team);
		await create;

		expect(frame.launchId).toEqual(expect.any(String));
		expect(events).toEqual([
			["open", frame.team, frame.launchId, true, false, 0],
			["settled", frame.team, true, frame.launchId],
		]);
		// Ledger alone gives up.
		expect(s.forgotten).toEqual([]);
	});

	it("abandons a recorded launch whose wake never reached the host, and settles nothing", async () => {
		const dropping = {
			readyState: 1,
			send: () => 0,
			data: { launchIds: true },
		} as unknown as ServerWebSocket<WsData>;
		const s = setup({ liveHostSocket: () => dropping });
		const events: unknown[] = [];
		s.service.useLedger({
			open: (team, launchId) => {
				events.push(["open", team, launchId]);
				return true;
			},
			retain: () => true,
			abandon: (launchId) => events.push(["abandon", launchId]),
		});
		s.service.onSettled((team) => events.push(["settled", team]));

		const answer = await s.service.tryWakeTeam("proj");

		expect(answer).toMatchObject({ ok: false, errorKind: "disconnected" });
		expect(events).toEqual([
			["open", "proj", expect.any(String)],
			["abandon", (events[0] as unknown[])[2]],
		]);
	});

	it("sends no wake when its launch cannot be recorded, and forgets only the record its create minted", async () => {
		const s = setup();
		s.service.useLedger({ open: () => false, retain: () => true, abandon: () => {} });

		const woken = await s.service.tryWakeTeam("proj");
		const created = await s.service.tryWakeTeam("proj.story", { displayLabel: "Story Time", harness: "claude" });

		expect([woken, created]).toEqual([
			{ ok: false, error: expect.any(String) },
			expect.objectContaining({ ok: false, error: expect.any(String) }),
		]);
		expect(s.sent).toEqual([]);
		expect(s.forgotten).toEqual(s.sessionStore.list().map((record) => s.sessionStore.teamOf(record)));
		expect(s.forgotten).toHaveLength(1);
	});

	it("claims a launch for the owner, whether its wake starts it or joins it", async () => {
		const s = setup();
		const opened: boolean[] = [];
		const retained: string[] = [];
		s.service.useLedger({
			open: (_team, _launchId, _created, held) => {
				opened.push(held);
				return true;
			},
			retain: (launchId) => {
				retained.push(launchId);
				return true;
			},
			abandon: () => {},
		});

		const create = s.service.tryWakeTeam("proj.story", { displayLabel: "Story Time", harness: "claude" });
		const [frame] = s.sent;
		const joined = s.service.tryWakeTeam(frame.team, undefined, { retain: true });
		const owned = s.service.tryWakeTeam("proj", undefined, { retain: true });
		for (const team of [frame.team, "proj"]) s.up(team);
		await Promise.all([create, joined, owned]);

		expect(opened).toEqual([false, true]);
		expect(retained).toEqual([frame.launchId]);
		expect(s.sent.filter((sent) => sent.type === "wake")).toHaveLength(2);
	});

	it("marks a wake fresh until its session first confirms, minted by that wake or not", async () => {
		const s = setup();
		const minting = s.service.tryWakeTeam("proj.story", { displayLabel: "Story Time", harness: "claude" });
		const launched = s.sent[0].team;
		s.up(launched);
		await minting;

		const wakeAgain = async () => {
			const wake = s.service.tryWakeTeam(launched);
			s.up(launched);
			await wake;
		};
		await wakeAgain();
		s.sessionStore.confirm(launched);
		await wakeAgain();

		expect(s.sent.map((frame) => [frame.team, frame.fresh])).toEqual([
			[launched, true],
			[launched, true],
			[launched, undefined],
		]);
	});

	it("names the CLI on every wake: the record's, or none picked for a bare project", async () => {
		const s = setup();
		const teams = [s.sessionStore.teamOf(s.sessionStore.mint({ spawn: "host", harness: "copilot" })), "proj"];

		const wakes = teams.map((team) => s.service.tryWakeTeam(team));
		for (const team of teams) s.up(team);
		await Promise.all(wakes);

		expect(s.sent.map((frame) => frame.harness)).toEqual(["copilot", UNPICKED_WORD]);
	});

	it("joins a create and a wake of one session to one launch, its frame naming the create", async () => {
		const s = setup();
		const team = s.sessionStore.teamOf(s.sessionStore.mint({ spawn: "host", harness: "claude" }));

		const created = s.service.tryWakeTeam(team, undefined, { retain: true, door: "create" });
		const woken = s.service.tryWakeTeam(team);
		s.up(team);

		await expect(Promise.all([created, woken])).resolves.toEqual([{ ok: true }, { ok: true }]);
		expect(s.sent).toEqual([expect.objectContaining({ type: "wake", team, door: "create" })]);
	});

	it("makes a launch begun inside a hold wait, then resume the conversation the record names by then", async () => {
		const s = setup();
		const before = "11111111-1111-4111-8111-111111111111";
		const after = "22222222-2222-4222-8222-222222222222";
		const record = s.sessionStore.mint({ spawn: "host", harness: "claude", claudeSessionId: before });
		const team = s.sessionStore.teamOf(record);

		const release = s.service.hold(team);
		const wake = s.service.tryWakeTeam(team);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const heldBack = s.sent.length;
		s.sessionStore.repointConversation(team, after);
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		s.up(team);

		await expect(wake).resolves.toEqual({ ok: true });
		expect(heldBack).toBe(0);
		expect(s.sent).toEqual([expect.objectContaining({ type: "wake", team, resumeSessionId: after })]);
	});

	it("holds a launch in flight past the session registering, until the daemon answers it", async () => {
		const s = setup();
		const wake = s.service.tryWakeTeam("proj");
		const [frame] = s.sent;

		s.wakeCoordinator.notify("proj");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const registered = s.service.isWakeInFlight("proj");
		s.wakeCoordinator.ackReceived("proj", 60_000, frame.launchId);

		await expect(wake).resolves.toEqual({ ok: true });
		expect(registered).toBe(true);
		expect(s.service.isWakeInFlight("proj")).toBe(false);
	});
});
