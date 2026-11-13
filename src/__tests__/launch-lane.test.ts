import { describe, expect, it } from "vitest";
import { ContainerStopped } from "../mcp/devcontainer/containers.js";
import { createLaunchLane, LATE_CANCEL_MS, RESULT_KEEP_MS, WakeFailure } from "../mcp/devcontainer/launchLane.js";
import type { LaunchFacts, LaunchOutcome } from "../mcp/devcontainer/sessionLaunch.js";
import type { TmuxTarget } from "../shared/host-op.js";
import type { SessionHarness } from "../shared/session-harness.js";

const HOST_A: TmuxTarget = { kind: "host", name: "host", sessionName: "a" };
const WINDOWS_A: TmuxTarget = { kind: "host", name: "windows", sessionName: "a" };
const APP_A: TmuxTarget = { kind: "devcontainer", name: "app", sessionName: "a" };
const MADE: LaunchOutcome = { created: true, ready: true, alive: true, live: true, screen: "" };
const FOUND: LaunchOutcome = { ...MADE, created: false };

interface Launch {
	target: TmuxTarget;
	facts: LaunchFacts;
	answer(outcome: LaunchOutcome): Promise<void>;
}

function rig(
	options: { installed?: SessionHarness[]; unready?: SessionHarness[]; holdInstalled?: Promise<void> } = {},
) {
	const sent: Record<string, unknown>[] = [];
	const launches: Launch[] = [];
	const events: string[] = [];
	let clock = 0;
	let generation = 0;
	let minted = 0;
	const name = (target: TmuxTarget) => `${target.name}.${target.sessionName}`;
	const lane = createLaunchLane({
		launch: (target, facts) =>
			new Promise<LaunchOutcome>((resolve) => {
				events.push(`launch ${name(target)} ${facts.door}`);
				launches.push({
					target,
					facts,
					answer: async (outcome) => {
						resolve(outcome);
						await flush();
					},
				});
			}),
		kill: async (target) => {
			events.push(`kill ${name(target)}`);
		},
		installed: async () => {
			await options.holdInstalled;
			return options.installed ?? ["claude"];
		},
		project: (project) => ({ path: `/home/me/projects/${project}` }),
		generation: () => generation,
		ensureUp: async (_project, _path, admitted, then, undo) => {
			if (admitted !== generation) throw new ContainerStopped();
			const value = await then(options.installed ?? ["claude"], options.unready);
			if (admitted !== generation) {
				await undo(value);
				throw new ContainerStopped();
			}
			return { pluginsProvisioned: false, value };
		},
		send: (frame) => sent.push(frame),
		now: () => clock,
		uuid: () => {
			minted += 1;
			return `00000000-0000-4000-8000-00000000000${minted}`;
		},
		log: () => undefined,
	});
	const results = (team: string) => sent.filter((frame) => frame.type === "wake_result" && frame.team === team);
	const stages = () => sent.filter((frame) => frame.type === "wake_stage").map((frame) => frame.stage);
	return {
		lane,
		sent,
		launches,
		events,
		results,
		stages,
		advance: (ms: number) => {
			clock += ms;
		},
		/** A Stop as the daemon makes one. */
		stop: (project: string) => {
			generation += 1;
			lane.stop(project);
		},
		bumpGeneration: () => {
			generation += 1;
		},
	};
}

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const wake = (target: TmuxTarget, extra: { fresh?: true; launchId?: string } = {}) => ({
	target,
	harness: "claude",
	sessionToken: "t",
	...extra,
});

/** The launch ids each kind of frame named, in order. */
const idsOf = (frames: Record<string, unknown>[], type: string) =>
	frames.filter((frame) => frame.type === type).map((frame) => frame.launchId);

describe("a launch lane", () => {
	it("runs one launch for a repeated wake and a create behind it, and answers each door", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A));
		r.lane.wake("host.a", wake(HOST_A));
		const created = r.lane.create(wake(HOST_A));
		await flush();
		await r.launches[0]?.answer(MADE);

		expect(r.events).toEqual(["launch host.a wake"]);
		expect(await created).toEqual({ created: true, ready: true, alive: true });
		expect(r.results("host.a")).toMatchObject([{ success: true }]);
	});

	it("queues a wake behind a create, since a create leaves a dead pane alone, then runs it as a wake", async () => {
		const r = rig();

		const created = r.lane.create(wake(HOST_A));
		await flush();
		r.lane.wake("host.a", wake(HOST_A));
		await flush();
		expect(r.events).toEqual(["launch host.a create"]);

		await r.launches[0]?.answer(FOUND);
		expect(await created).toEqual({ created: false });
		expect(r.events).toEqual(["launch host.a create", "launch host.a wake"]);
	});

	it("serializes host and windows names on one tmux server, and runs a container's pane apart", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A));
		r.lane.wake("windows.a", wake(WINDOWS_A));
		r.lane.wake("app.a", wake(APP_A));
		await flush();
		expect([...r.events].sort()).toEqual(["launch app.a wake", "launch host.a wake"]);

		await r.launches.find((launch) => launch.target === HOST_A)?.answer(FOUND);
		expect(r.events.at(-1)).toBe("launch windows.a wake");
	});

	it("drops a cancelled queued wake and leaves the running wake on its pane alone", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A));
		r.lane.wake("windows.a", wake(WINDOWS_A));
		await flush();
		r.lane.cancel("windows.a");
		await flush();
		await r.launches[0]?.answer(FOUND);

		expect(r.results("windows.a")).toMatchObject([{ success: false, failure: { kind: "error" } }]);
		expect(r.results("host.a")).toMatchObject([{ success: true }]);
		expect(r.events).toEqual(["launch host.a wake"]);
	});

	it("closes the pane a cancelled running wake made, unless a create took its outcome", async () => {
		const alone = rig();
		const shared = rig();

		alone.lane.wake("host.a", wake(HOST_A));
		shared.lane.wake("host.a", wake(HOST_A));
		const created = shared.lane.create(wake(HOST_A));
		await flush();
		alone.lane.cancel("host.a");
		shared.lane.cancel("host.a");
		await alone.launches[0]?.answer(MADE);
		await shared.launches[0]?.answer(MADE);

		expect(alone.events).toEqual(["launch host.a wake", "kill host.a"]);
		expect(alone.results("host.a")).toMatchObject([{ success: false }]);
		expect(shared.events).toEqual(["launch host.a wake"]);
		expect(await created).toMatchObject({ created: true });
	});

	it("replays a running wake's last stage on connect, and nothing once it settles", async () => {
		const r = rig();

		r.lane.wake("app.a", wake(APP_A));
		await flush();
		expect(r.stages()).toEqual(["building", "container_up", "cli_found"]);
		r.lane.replayStages();
		expect(r.stages()).toEqual(["building", "container_up", "cli_found", "cli_found"]);

		await r.launches[0]?.answer(MADE);
		r.lane.replayStages();
		expect(r.stages()).toHaveLength(4);
	});

	it.each([
		["a never-confirmed wake inside its window", { fresh: true as const }, 60_000, true],
		["a never-confirmed wake past its window", { fresh: true as const }, LATE_CANCEL_MS, false],
		["a confirmed session's wake", {}, 60_000, false],
	])("closes the pane on a late cancel only for %s", async (_label, extra, after, closes) => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A, extra));
		await flush();
		await r.launches[0]?.answer(MADE);
		r.advance(after);
		r.lane.cancel("host.a");
		await flush();

		expect(r.events.includes("kill host.a")).toBe(closes);
	});

	it("fails launches queued before a Stop as stopped, and undoes the running one at its fence", async () => {
		const r = rig();

		const created = r.lane.create(wake(APP_A)).catch((err: unknown) => err);
		await flush();
		r.lane.wake("app.a", wake(APP_A));
		r.stop("app");
		await flush();
		expect(r.results("app.a")).toMatchObject([{ success: false, failure: { kind: "stopped" } }]);

		await r.launches[0]?.answer(MADE);
		expect(await created).toMatchObject({ failure: { kind: "stopped" } });
		expect(r.events).toEqual(["launch app.a create", "kill app.a"]);
	});

	it("fences a launch by the generation it was admitted under, not when it reaches its container", async () => {
		const r = rig();

		r.lane.create(wake(APP_A)).catch(() => undefined);
		await flush();
		r.lane.wake("app.a", wake(APP_A));
		r.bumpGeneration();
		await r.launches[0]?.answer(FOUND);

		expect(r.results("app.a")).toMatchObject([{ success: false, failure: { kind: "stopped" } }]);
		expect(r.launches).toHaveLength(1);
	});

	it("kills ahead of a running launch, gives up everything on the pane, and runs a later wake after", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A));
		const joined = r.lane.create(wake(HOST_A)).catch((err: unknown) => err);
		await flush();
		r.lane.wake("windows.a", wake(WINDOWS_A));
		await r.lane.kill(HOST_A);
		r.lane.wake("host.a", wake(HOST_A));
		expect(r.events).toEqual(["launch host.a wake", "kill host.a"]);

		await r.launches[0]?.answer(MADE);
		await r.launches[1]?.answer(FOUND);
		expect(r.events).toEqual(["launch host.a wake", "kill host.a", "launch host.a wake"]);
		expect(r.results("host.a")).toMatchObject([{ success: false }, { success: true }]);
		expect(r.results("windows.a")).toMatchObject([{ success: false }]);
		expect(await joined).toBeInstanceOf(Error);
	});

	it("never launches a unit a kill took before it reached its launch", async () => {
		let release!: () => void;
		const r = rig({ holdInstalled: new Promise<void>((resolve) => (release = resolve)) });

		r.lane.wake("host.a", wake(HOST_A));
		await flush();
		await r.lane.kill(HOST_A);
		release();
		await flush();

		expect(r.events).toEqual(["kill host.a"]);
		expect(r.results("host.a")).toMatchObject([{ success: false }]);
	});

	it("runs a close's follow-up before a wake of that name queued behind it", async () => {
		const r = rig();

		const closed = r.lane.closeBehind(HOST_A, async () => {
			await flush();
			r.events.push("after close");
		});
		r.lane.wake("host.a", wake(HOST_A));
		await closed;
		await flush();

		expect(r.events.slice(0, 3)).toEqual(["kill host.a", "after close", "launch host.a wake"]);
	});

	it("holds a close behind a launch that already started, then closes the pane it made", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A));
		await flush();
		const closed = r.lane.closeBehind(HOST_A, async () => {
			r.events.push("after close");
		});
		await flush();
		expect(r.events).toEqual(["launch host.a wake"]);

		await r.launches[0]?.answer(MADE);
		await closed;
		expect(r.events).toEqual(["launch host.a wake", "kill host.a", "after close"]);
	});

	it("joins only a launch run with the same facts, and queues one with another record's token", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A));
		r.lane.wake("host.a", { ...wake(HOST_A), sessionToken: "readopted" });
		await flush();
		await r.launches[0]?.answer(FOUND);
		await r.launches[1]?.answer(FOUND);

		expect(r.launches.map((launch) => launch.facts.sessionToken)).toEqual(["t", "readopted"]);
		expect(r.results("host.a")).toMatchObject([{ success: true }, { success: true }]);
	});

	it("answers a missing CLI by frame to a wake and by typed failure to a create", async () => {
		const r = rig({ installed: [] });

		r.lane.wake("host.a", wake(HOST_A));
		const created = r.lane.create(wake({ ...HOST_A, sessionName: "b" })).catch((err: unknown) => err);
		await flush();

		expect(r.results("host.a")).toMatchObject([{ success: false, failure: { kind: "cli" } }]);
		const refused = await created;
		expect(refused).toBeInstanceOf(WakeFailure);
		expect(refused).toMatchObject({ failure: { kind: "cli" } });
		expect(r.launches).toHaveLength(0);
	});

	it("fails a container launch whose CLI's plugins did not install, and launches nothing", async () => {
		const r = rig({ installed: ["claude", "opencode"], unready: ["claude"] });

		r.lane.wake("app.a", wake(APP_A));
		await flush();

		expect(r.results("app.a")).toMatchObject([{ success: false, failure: { kind: "error" } }]);
		expect(r.launches).toHaveLength(0);
	});
});

describe("a launch lane's ids", () => {
	it("answers each id a joined launch took, and tells each its stages", async () => {
		const r = rig();

		r.lane.wake("app.a", wake(APP_A, { launchId: "launch-1" }));
		r.lane.wake("app.a", wake(APP_A, { launchId: "launch-2" }));
		await flush();
		await r.launches[0]?.answer(MADE);

		expect(r.launches).toHaveLength(1);
		expect(idsOf(r.sent, "wake_result")).toEqual(["launch-1", "launch-2"]);
		const cliFound = r.sent.filter((frame) => frame.type === "wake_stage" && frame.stage === "cli_found");
		expect(cliFound.map((frame) => frame.launchId)).toEqual(["launch-1", "launch-2"]);
	});

	it("cancels only the id it names, and the launch carries on for a create that joined it", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A, { launchId: "launch-1" }));
		const created = r.lane.create(wake(HOST_A, { launchId: "launch-2" }));
		await flush();
		r.lane.cancel("host.a", "launch-1");
		await r.launches[0]?.answer(MADE);

		expect(r.results("host.a")).toMatchObject([{ launchId: "launch-1", success: false }]);
		expect(await created).toMatchObject({ created: true });
		expect(r.events).toEqual(["launch host.a wake"]);
	});

	it("leaves a tagged launch alone on a cancel that names no id", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A, { launchId: "launch-1", fresh: true }));
		await flush();
		r.lane.cancel("host.a");
		await r.launches[0]?.answer(MADE);
		r.lane.cancel("host.a");
		await flush();

		expect(r.results("host.a")).toMatchObject([{ launchId: "launch-1", success: true }]);
		expect(r.events).toEqual(["launch host.a wake"]);
	});

	it("replays a tagged result on every connect until acknowledged, and an untagged one never", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A, { launchId: "launch-1" }));
		r.lane.wake("windows.b", wake({ ...WINDOWS_A, sessionName: "b" }));
		await flush();
		for (const launch of [...r.launches]) await launch.answer(FOUND);
		r.lane.replayResults();
		r.lane.replayResults();
		r.lane.ack("launch-1");
		r.lane.replayResults();

		expect(idsOf(r.sent, "wake_result")).toEqual(["launch-1", undefined, "launch-1", "launch-1"]);
	});

	it("drops an unacknowledged result once its keep runs out", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A, { launchId: "launch-1" }));
		await flush();
		await r.launches[0]?.answer(FOUND);
		r.advance(RESULT_KEEP_MS);
		r.lane.replayResults();

		expect(idsOf(r.sent, "wake_result")).toEqual(["launch-1"]);
	});

	it("queues a new id behind a launch whose id was cancelled, and answers each under its own", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A, { launchId: "launch-1" }));
		await flush();
		r.lane.cancel("host.a", "launch-1");
		r.lane.wake("host.a", wake(HOST_A, { launchId: "launch-2" }));
		await r.launches[0]?.answer(MADE);
		await r.launches[1]?.answer(FOUND);

		expect(r.events).toEqual(["launch host.a wake", "kill host.a", "launch host.a wake"]);
		expect(r.results("host.a")).toMatchObject([
			{ launchId: "launch-1", success: false },
			{ launchId: "launch-2", success: true },
		]);
	});

	it("lets no late frame for an earlier launch touch the one that replaced it", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A, { launchId: "launch-1", fresh: true }));
		await flush();
		await r.launches[0]?.answer(MADE);
		r.lane.wake("host.a", wake(HOST_A, { launchId: "launch-2", fresh: true }));
		await flush();
		r.lane.cancel("host.a", "launch-1");
		r.lane.ack("launch-1");
		r.lane.wake("host.a", wake(HOST_A, { launchId: "launch-1" }));
		await r.launches[1]?.answer(MADE);
		r.lane.replayResults();

		expect(r.events).toEqual(["launch host.a wake", "launch host.a wake"]);
		expect(idsOf(r.sent, "wake_result")).toEqual(["launch-1", "launch-2", "launch-2"]);
		expect(r.results("host.a").every((frame) => frame.success)).toBe(true);
	});
});

describe("a create's intent on a wake", () => {
	it("launches with the create door and answers a found pane by frame as success", async () => {
		const r = rig();

		r.lane.wake("app.a", wake(APP_A, { launchId: "launch-1" }), "create");
		await flush();
		await r.launches[0]?.answer(FOUND);

		expect(r.events).toEqual(["launch app.a create"]);
		expect(r.stages()).toEqual(["building", "container_up", "cli_found"]);
		expect(r.results("app.a")).toMatchObject([{ launchId: "launch-1", success: true }]);
	});

	it("joins a running wake of the same facts, and each id is answered", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A, { launchId: "launch-1" }));
		r.lane.wake("host.a", wake(HOST_A, { launchId: "launch-2" }), "create");
		await flush();
		await r.launches[0]?.answer(MADE);

		expect(r.events).toEqual(["launch host.a wake"]);
		expect(idsOf(r.sent, "wake_result")).toEqual(["launch-1", "launch-2"]);
	});

	it("queues behind a running create of other facts, and runs its own create after", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A, { launchId: "launch-1" }), "create");
		r.lane.wake("host.a", { ...wake(HOST_A, { launchId: "launch-2" }), sessionToken: "readopted" }, "create");
		await flush();
		expect(r.events).toEqual(["launch host.a create"]);

		await r.launches[0]?.answer(MADE);
		await r.launches[1]?.answer(FOUND);
		expect(r.events).toEqual(["launch host.a create", "launch host.a create"]);
		expect(r.launches.map((launch) => launch.facts.sessionToken)).toEqual(["t", "readopted"]);
		expect(idsOf(r.sent, "wake_result")).toEqual(["launch-1", "launch-2"]);
	});
});

describe("a CLI resolved at launch", () => {
	it("mints its own id for an unpicked request, launches with it, and reports it with cli_found and the result", async () => {
		const r = rig({ installed: ["copilot"] });

		r.lane.wake("app.a", { ...wake(APP_A, { launchId: "launch-1" }), harness: "unpicked" }, "create");
		await flush();
		await r.launches[0]?.answer(MADE);

		const id = "00000000-0000-4000-8000-000000000001";
		expect(r.launches[0]?.facts).toMatchObject({ harness: "copilot", resumeSessionId: id });
		expect(r.sent.find((frame) => frame.stage === "cli_found")).toMatchObject({
			harness: "copilot",
			sessionId: id,
		});
		expect(r.results("app.a")).toMatchObject([
			{ launchId: "launch-1", success: true, harness: "copilot", sessionId: id },
		]);
	});

	it("repeats the resolved CLI on a failed result, so a lost cli_found costs the record nothing", async () => {
		const r = rig();

		r.lane.wake("host.a", wake(HOST_A, { launchId: "launch-1" }));
		await flush();
		await r.launches[0]?.answer({ ...MADE, alive: false, live: false, ready: false, error: "no composer" });

		expect(r.results("host.a")).toMatchObject([{ launchId: "launch-1", success: false, harness: "claude" }]);
	});

	it.each<[string, { harness: string; resumeSessionId?: string }]>([
		["names its CLI", { harness: "copilot" }],
		["carries an id", { harness: "unpicked", resumeSessionId: "11111111-2222-4333-8444-555555555555" }],
	])("mints nothing for a request that %s", async (_label, extra) => {
		const r = rig({ installed: ["copilot"] });

		r.lane.wake("host.a", { ...wake(HOST_A), ...extra });
		await flush();

		expect(r.launches[0]?.facts.resumeSessionId).toBe(extra.resumeSessionId);
		expect(r.sent.find((frame) => frame.stage === "cli_found")).not.toHaveProperty("sessionId");
	});

	it("mints nothing for a CLI whose ids are not its own", async () => {
		const r = rig();

		r.lane.wake("host.a", { ...wake(HOST_A), harness: "unpicked" });
		await flush();

		expect(r.launches[0]?.facts).toMatchObject({ harness: "claude", resumeSessionId: undefined });
	});
});
