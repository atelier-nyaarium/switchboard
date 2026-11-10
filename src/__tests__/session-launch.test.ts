import { describe, expect, it } from "vitest";
import {
	createSessionLaunch,
	LAUNCHER_READY_MS,
	type LaunchDoor,
	type LaunchFacts,
	type LaunchSite,
	placementRefusal,
	resolveLaunchHarness,
} from "../mcp/devcontainer/sessionLaunch.js";
import { type PaneAgentState, type ReadyAnswer, reattachStep } from "../mcp/devcontainer/tmuxCore.js";
import { cliRefusalText } from "../shared/cli-resolve.js";
import type { TmuxTarget } from "../shared/host-op.js";
import { FIRST_LAUNCH_GREETING, UNPICKED_WORD } from "../shared/session-harness.js";

const RULE = "─".repeat(40);
const READY = `● done\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ bypass permissions on`;
const SHELL = "$ ";
const LIMITED = "You've hit your weekly limit · resets 5pm";
const SES = "ses_sb0f8b2a4c1d3e4f5a9b6c7d8e9f0a1b2c";
const TARGET: TmuxTarget = { kind: "host", name: "host", sessionName: "oc" };
const CONTAINER: TmuxTarget = { kind: "devcontainer", name: "app", sessionName: "main" };
const STATUS = "/run/sb/host.oc.json";
/** The launcher already running. */
const OLD = 4242;
/** The one a relaunch starts. */
const NEW = 5151;
const statusOf = (state: "starting" | "ready" | "failed" | "exited", pid: number) =>
	JSON.stringify({
		state,
		pid,
		...(state === "ready" ? { version: "2.2.5" } : {}),
		...(state === "failed" ? { error: "the OpenCode server exited" } : {}),
		...(state === "exited" ? { code: 0 } : {}),
	});

interface Ctl {
	files: Map<string, string>;
	/** Its pid leaves the pane. */
	kill(pid: number): void;
	dropPane(): void;
}

interface RigOptions {
	/** Pane already exists. */
	pane?: boolean;
	/** Process probes; last sticks. */
	process?: PaneAgentState[];
	/** Screen waits; last sticks. */
	readies?: ReadyAnswer[];
	peeks?: string[];
	status?: string;
	/** Pids not on the pane's tty. */
	offPane?: number[];
	/** Pids whose probe fails. */
	unanswered?: number[];
	/** Written after a create. */
	launcherWrites?: { status: string; afterPolls: number };
	/** Run at that poll. */
	atPoll?: Array<[poll: number, act: (ctl: Ctl) => void]>;
}

function rig(options: RigOptions = {}) {
	const files = new Map<string, string>(options.status ? [[STATUS, options.status]] : []);
	const calls = { probes: 0, ensured: [] as string[], kills: 0, waits: 0, peeks: 0, typed: [] as string[] };
	const offPane = new Set(options.offPane);
	const unanswered = new Set(options.unanswered);
	let pane = options.pane ?? false;
	let clock = 0;
	let polls = 0;
	const script = [...(options.atPoll ?? [])];
	const ctl: Ctl = {
		files,
		kill: (pid) => offPane.add(pid),
		dropPane: () => {
			pane = false;
		},
	};
	const next = <T>(list: T[] | undefined, fallback: T): T =>
		list && list.length > 1 ? (list.shift() as T) : (list?.[0] ?? fallback);
	const host: LaunchSite = {
		runtime: "/home/me/.bun/bin/bun",
		root: "/home/me/sb",
		statusFile: () => STATUS,
		readStatus: async () => files.get(STATUS),
		clearStatus: async () => {
			files.delete(STATUS);
		},
	};
	const launch = createSessionLaunch({
		hasSession: async () => {
			calls.probes += 1;
			return pane;
		},
		ensureSession: async (_target, command) => {
			calls.ensured.push(command);
			if (pane) return { created: false };
			pane = true;
			const writes = options.launcherWrites;
			if (writes) script.push([polls + writes.afterPolls, () => files.set(STATUS, writes.status)]);
			return { created: true };
		},
		killSession: async () => {
			calls.kills += 1;
			pane = false;
		},
		awaitReady: async () => {
			calls.waits += 1;
			return next(options.readies, { alive: true, ready: true, screen: READY });
		},
		paneAgentState: async () => next(options.process, "alive"),
		reattachStep,
		peekScreen: async () => {
			calls.peeks += 1;
			return next(options.peeks, READY);
		},
		sendText: async (_target, text) => {
			calls.typed.push(text);
		},
		pathPrefix: "/home/me/.bun/bin",
		sites: { host, windows: null, container: null },
		paneHolds: async (_target, pid) => (unanswered.has(pid) ? undefined : !offPane.has(pid)),
		sleep: async (ms) => {
			clock += ms;
			polls += 1;
			for (const [at, act] of script) if (at === polls) act(ctl);
		},
		now: () => clock,
		log: () => undefined,
	});
	return { launch, calls, files, elapsed: () => clock };
}

const claude = (door: LaunchDoor, extra: Partial<LaunchFacts> = {}): LaunchFacts => ({
	harness: "claude",
	door,
	...extra,
});
const opencode = (door: LaunchDoor, extra: Partial<LaunchFacts> = {}): LaunchFacts => ({
	harness: "opencode",
	resumeSessionId: SES,
	door,
	...extra,
});

describe("a launch read through its pane", () => {
	it("creates a pane and greets it once it is ready", async () => {
		const r = rig();

		const outcome = await r.launch(TARGET, claude("wake"));

		expect(outcome).toMatchObject({ created: true, ready: true, live: true });
		expect(r.calls.ensured).toHaveLength(1);
		expect(r.calls.typed).toEqual([FIRST_LAUNCH_GREETING]);
	});

	it("relaunches a woken pane whose CLI is gone, and keeps one at its composer", async () => {
		const gone = rig({ pane: true, process: ["gone"] });
		const ready = rig({ pane: true });

		const relaunched = await gone.launch(TARGET, claude("wake"));
		const kept = await ready.launch(TARGET, claude("wake"));

		expect([gone.calls.kills, ready.calls.kills]).toEqual([1, 0]);
		expect(relaunched).toMatchObject({ created: false, ready: true });
		expect(kept).toMatchObject({ created: false, ready: true });
		expect(gone.calls.typed).toEqual([]);
	});

	it("keeps a pane holding a limit dialog", async () => {
		const limit = { headline: LIMITED, detail: "resets 5pm" };
		const r = rig({ pane: true, readies: [{ alive: true, ready: false, screen: LIMITED, limit }] });

		const outcome = await r.launch(TARGET, claude("wake"));

		expect(r.calls.kills).toBe(0);
		expect(outcome).toMatchObject({ ready: false, limit });
	});

	it("rechecks a pane that read neither ready nor working, and relaunches only if it still does not", async () => {
		const blank = { alive: true, ready: false, screen: SHELL };
		const settled = rig({ pane: true, readies: [blank], peeks: [READY] });
		const dead = rig({ pane: true, readies: [blank, { alive: true, ready: true, screen: READY }], peeks: [SHELL] });

		const kept = await settled.launch(TARGET, claude("wake"));
		const relaunched = await dead.launch(TARGET, claude("wake"));

		expect([settled.calls.kills, dead.calls.kills]).toEqual([0, 1]);
		expect(kept).toMatchObject({ ready: true, screen: READY });
		expect(relaunched).toMatchObject({ ready: true });
	});

	it("reads the screen of a woken container pane, and nothing of a pane a create finds", async () => {
		const peeked = rig({ pane: true, peeks: ["mid-turn"] });
		const left = rig({ pane: true });

		const peek = await peeked.launch(CONTAINER, claude("wake"));
		const leave = await left.launch(TARGET, claude("create"));

		expect(peek).toMatchObject({ created: false, live: true, screen: "mid-turn" });
		expect(leave).toMatchObject({ created: false, live: true, screen: "" });
		expect([peeked.calls.waits, peeked.calls.kills, left.calls.waits, left.calls.peeks]).toEqual([0, 0, 0, 0]);
	});
});

describe("a launch read through its launcher", () => {
	const relaunched = { launcherWrites: { status: statusOf("ready", NEW), afterPolls: 2 } };

	it.each([
		["is ready on the pane", {}],
		["is ready, and the pane probe goes unanswered", { unanswered: [OLD] }],
	])("keeps a woken pane whose launcher %s, and kills nothing", async (_label, options) => {
		const r = rig({ pane: true, status: statusOf("ready", OLD), ...options });

		const outcome = await r.launch(TARGET, opencode("wake"));

		expect(outcome).toMatchObject({ created: false, ready: true });
		expect([r.calls.kills, r.calls.ensured.length]).toEqual([0, 0]);
	});

	it.each([
		["has not reported", undefined],
		["is still starting", statusOf("starting", OLD)],
	])("waits on a woken pane whose launcher %s, without killing it", async (_label, status) => {
		const later: RigOptions["atPoll"] = [[3, ({ files }) => files.set(STATUS, statusOf("ready", OLD))]];
		const r = rig({ pane: true, ...(status ? { status } : {}), atPoll: later });

		const outcome = await r.launch(TARGET, opencode("wake"));

		expect(outcome).toMatchObject({ created: false, ready: true });
		expect([r.calls.kills, r.calls.ensured.length]).toEqual([0, 0]);
	});

	it.each([
		["its launcher failed, its server or its UI gone", { status: statusOf("failed", OLD) }],
		["its launcher's UI exited", { status: statusOf("exited", OLD) }],
		["its ready launcher's pid is not on the pane's tty", { status: statusOf("ready", OLD), offPane: [OLD] }],
		[
			"its starting launcher leaves the pane during the wait",
			{ status: statusOf("starting", OLD), atPoll: [[2, ({ kill }) => kill(OLD)]] as RigOptions["atPoll"] },
		],
	])("relaunches a woken pane when %s", async (_label, options) => {
		const r = rig({ pane: true, ...options, ...relaunched });

		const outcome = await r.launch(TARGET, opencode("wake"));

		expect(r.calls.kills).toBe(1);
		expect(r.calls.ensured).toHaveLength(1);
		expect(outcome).toMatchObject({ created: true, ready: true });
	});

	it("answers a kept pane's failure without relaunching it", async () => {
		const failing: RigOptions["atPoll"] = [[2, ({ files }) => files.set(STATUS, statusOf("failed", OLD))]];
		const r = rig({ pane: true, status: statusOf("starting", OLD), atPoll: failing });

		const outcome = await r.launch(TARGET, opencode("wake"));

		expect(outcome).toMatchObject({ created: false, ready: false });
		expect(outcome.error).toBeTruthy();
		expect([r.calls.kills, r.calls.ensured.length]).toEqual([0, 0]);
	});

	it.each([
		["its pane reads gone twice", { process: ["gone" as const], peeks: ["opencode: command not found"] }],
		[
			"its starting launcher leaves the pane",
			{
				launcherWrites: { status: statusOf("starting", NEW), afterPolls: 1 },
				atPoll: [[3, ({ kill }) => kill(NEW)]] as RigOptions["atPoll"],
			},
		],
		["its UI exits first", { launcherWrites: { status: statusOf("exited", NEW), afterPolls: 1 } }],
		["its tmux session is gone", { atPoll: [[2, ({ dropPane }) => dropPane()]] as RigOptions["atPoll"] }],
	])("fails early when a new launcher exits without starting: %s", async (label, options) => {
		const r = rig(options);

		const outcome = await r.launch(TARGET, opencode("wake"));

		expect(outcome).toMatchObject({ created: true, ready: false });
		expect(outcome.error).toBeTruthy();
		expect(r.elapsed()).toBeLessThan(LAUNCHER_READY_MS);
		if ("peeks" in options) expect(outcome.screen, label).toBe("opencode: command not found");
	});

	it("fails once the launcher never reports, and only at the deadline", async () => {
		const r = rig();

		const outcome = await r.launch(TARGET, opencode("wake"));

		expect(outcome).toMatchObject({ created: true, ready: false, screen: "" });
		expect(outcome.error).toBeTruthy();
		expect(r.elapsed()).toBeGreaterThanOrEqual(LAUNCHER_READY_MS);
	});

	it.each([
		["is ready", { status: statusOf("ready", OLD) }],
		["exited", { status: statusOf("exited", OLD) }],
		["is not on the pane's tty", { status: statusOf("ready", OLD), offPane: [OLD] }],
	])("leaves a pane a create finds whose launcher %s, with no error", async (_label, options) => {
		const r = rig({ pane: true, ...options });

		const outcome = await r.launch(TARGET, opencode("create"));

		expect(outcome).toMatchObject({ created: false });
		expect(outcome.error).toBeUndefined();
		expect([r.calls.kills, r.calls.ensured.length]).toEqual([0, 0]);
	});

	it("refuses a place with no launcher before touching tmux", async () => {
		const r = rig();

		await expect(r.launch(CONTAINER, opencode("wake"))).rejects.toThrow(/refusing to launch/);
		expect([r.calls.probes, r.calls.ensured.length, r.calls.kills]).toEqual([0, 0, 0]);
	});

	it("asks the launcher to greet only a session that has never confirmed", async () => {
		const flags = await Promise.all(
			[true, false].map(async (fresh) => {
				const r = rig({ launcherWrites: { status: statusOf("ready", NEW), afterPolls: 1 } });
				await r.launch(TARGET, opencode("create", { fresh }));
				return r.calls.ensured[0]?.includes(" --greet");
			}),
		);

		expect(flags).toEqual([true, false]);
	});
});

describe("a launch's CLI", () => {
	it("refuses before the start a CLI its place never runs, or one it cannot read", () => {
		const offHost = [
			CONTAINER,
			{ kind: "host" as const, name: "windows", sessionName: "oc" },
			{ kind: "host" as const, name: "host", sessionName: "assistant" },
		];

		expect([placementRefusal("opencode", TARGET), placementRefusal(UNPICKED_WORD, CONTAINER)]).toEqual([
			undefined,
			undefined,
		]);
		for (const target of offHost) expect(placementRefusal("opencode", target), target.name).toBeTruthy();
		expect(placementRefusal("no-such-cli", TARGET)).toBeTruthy();
	});

	it("runs what the place has installed: a named CLI only there, an unpicked one only when it is the one", () => {
		const both = ["claude", "opencode"] as const;

		expect(resolveLaunchHarness("opencode", TARGET, both)).toEqual({ harness: "opencode" });
		expect(resolveLaunchHarness(UNPICKED_WORD, TARGET, ["claude"])).toEqual({ harness: "claude" });
		expect(resolveLaunchHarness(undefined, TARGET, [])).toEqual({ harness: "claude" });
		expect(resolveLaunchHarness(UNPICKED_WORD, TARGET, both)).toEqual({
			refused: cliRefusalText({ cause: "needs_pick", available: [...both] }, "host.oc"),
			cli: { cause: "needs_pick", available: [...both] },
		});
		expect(resolveLaunchHarness("opencode", TARGET, ["claude"])).toHaveProperty("refused");
		expect(resolveLaunchHarness("opencode", CONTAINER, both)).toHaveProperty("refused");
	});
});
