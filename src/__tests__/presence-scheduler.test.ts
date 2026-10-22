import { describe, expect, it, vi } from "vitest";
import { deriveFromPeek, PresenceScheduler } from "../mcp/devcontainer/presenceScheduler.js";
import type { HostPeekResult, TmuxTarget } from "../shared/host-op.js";

const T: TmuxTarget = { kind: "devcontainer", name: "recipe-app", sessionName: "main" };

const RULE = "─".repeat(40);
const IDLE = `● done\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;
const WORKING = `✻ Envisioning… (2m)\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ bypass permissions on · esc to interrupt`;
const LOGGED_OUT = `${RULE}\n❯ \n${RULE}\n  Not logged in. Run /login`;
// The limit dialog replaces the composer, so there is no prompt row and no toolbar below.
const LIMITED = `  └   You've hit your weekly limit · resets 5pm\n${"━".repeat(40)}\n ❯ 1. Stop and wait for limit to reset\n   2. Switch to usage credits`;

function tmuxFrame(ansi: string, hash: string): HostPeekResult {
	return { kind: "tmux", ansi, hash };
}
function logsFrame(hash: string): HostPeekResult {
	return { kind: "container-logs", text: "esc: booting... Not logged in yet", hash };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("deriveFromPeek", () => {
	it("derives working/needsLogin from a tmux frame", () => {
		expect(deriveFromPeek(tmuxFrame(WORKING, "h1"))).toEqual({
			working: true,
			needsLogin: false,
			limitBlocked: false,
		});
		expect(deriveFromPeek(tmuxFrame(IDLE, "h2"))).toEqual({
			working: false,
			needsLogin: false,
			limitBlocked: false,
		});
		expect(deriveFromPeek(tmuxFrame(LOGGED_OUT, "h3"))).toEqual({
			working: false,
			needsLogin: true,
			limitBlocked: false,
		});
	});

	it("derives the usage-limit block and its reset text from the dialog frame", () => {
		expect(deriveFromPeek(tmuxFrame(LIMITED, "h4"))).toEqual({
			working: false,
			needsLogin: false,
			limitBlocked: true,
			limitDetail: "resets 5pm",
		});
	});

	it("never derives from a container-logs frame, even if the text contains lookalike substrings", () => {
		// The logs text above literally contains "esc" and "Not logged in" - proof this is a real
		// kind-gate, not a lucky regex non-match.
		expect(deriveFromPeek(logsFrame("h1"))).toBeUndefined();
	});
});

function makeScheduler(peekSequence: HostPeekResult[]) {
	let i = 0;
	const reports: Array<{
		team: string;
		value: { working: boolean; needsLogin: boolean; limitBlocked: boolean } | undefined;
	}> = [];
	const peek = vi.fn(async () => {
		const r = peekSequence[Math.min(i, peekSequence.length - 1)];
		i++;
		return r;
	});
	const scheduler = new PresenceScheduler({
		peek,
		report: (team, value) => reports.push({ team, value }),
	});
	return { scheduler, reports, peek };
}

describe("PresenceScheduler hysteresis", () => {
	it("does not report on the first frame observing a new value - only on the second confirming peek", async () => {
		const { scheduler, reports } = makeScheduler([tmuxFrame(IDLE, "h1")]);
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		expect(reports).toEqual([]); // idle is the initial "no confirmed value yet" baseline, not a flip
	});

	it("a one-frame transient blip does not flip the confirmed state (two frames disagreeing then reverting)", async () => {
		const { scheduler, reports } = makeScheduler([
			tmuxFrame(IDLE, "h1"), // baseline: idle (no report - nothing confirmed yet to flip from)
			tmuxFrame(WORKING, "h2"), // one frame of "working" - pending, not confirmed
			tmuxFrame(IDLE, "h3"), // reverts before confirmation - the blip never lands
		]);
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		await scheduler.tick("proj.main");
		await scheduler.tick("proj.main");
		expect(reports).toEqual([]); // never confirmed working; still never confirmed idle-as-a-flip either
	});

	it("confirms working after two consecutive working frames, then confirms idle the same way", async () => {
		const { scheduler, reports } = makeScheduler([
			tmuxFrame(IDLE, "h1"),
			tmuxFrame(WORKING, "h2"),
			tmuxFrame(WORKING, "h3"), // second peek agreeing -> confirms
			tmuxFrame(IDLE, "h4"),
			tmuxFrame(IDLE, "h5"), // confirms the revert back to idle
		]);
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		await scheduler.tick("proj.main"); // h2: pending working
		await scheduler.tick("proj.main"); // h3: confirmed working
		await scheduler.tick("proj.main"); // h4: pending idle
		await scheduler.tick("proj.main"); // h5: confirmed idle

		expect(reports).toEqual([
			{ team: "proj.main", value: { working: true, needsLogin: false, limitBlocked: false } },
			{ team: "proj.main", value: { working: false, needsLogin: false, limitBlocked: false } },
		]);
	});

	it("counts a cached frame once toward a flip", async () => {
		const working = tmuxFrame(WORKING, "h3");
		const { scheduler, reports } = makeScheduler([
			tmuxFrame(IDLE, "h1"),
			tmuxFrame(IDLE, "h2"),
			working,
			working,
			tmuxFrame(WORKING, "h4"),
		]);
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		await scheduler.tick("proj.main");
		reports.length = 0;
		await scheduler.tick("proj.main");
		await scheduler.tick("proj.main");

		expect(reports).toEqual([]);
		await scheduler.tick("proj.main");
		expect(reports).toEqual([
			{ team: "proj.main", value: { working: true, needsLogin: false, limitBlocked: false } },
		]);
	});

	it("skips an overlapping tick while its capture is in flight", async () => {
		const nextCapture = deferred<HostPeekResult>();
		const frames = [tmuxFrame(IDLE, "h1"), tmuxFrame(IDLE, "h2")];
		const working = tmuxFrame(WORKING, "h4");
		let calls = 0;
		const peek = async (): Promise<HostPeekResult> => {
			calls += 1;
			if (calls <= frames.length) return frames[calls - 1]!;
			if (calls === 3) return nextCapture.promise;
			return working;
		};
		const reports: Array<{ team: string; value: unknown }> = [];
		const scheduler = new PresenceScheduler({ peek, report: (team, value) => reports.push({ team, value }) });
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		await scheduler.tick("proj.main");
		reports.length = 0;

		const active = scheduler.tick("proj.main");
		await scheduler.tick("proj.main");
		expect(calls).toBe(3);
		nextCapture.resolve(tmuxFrame(WORKING, "h3"));
		await active;
		expect(reports).toEqual([]);

		await scheduler.tick("proj.main");
		expect(reports).toEqual([
			{ team: "proj.main", value: { working: true, needsLogin: false, limitBlocked: false } },
		]);
	});

	it("keeps an in-flight peek when the equal watch entry is refreshed", async () => {
		const nextCapture = deferred<HostPeekResult>();
		let calls = 0;
		const peek = async (): Promise<HostPeekResult> => {
			calls += 1;
			if (calls === 1) return tmuxFrame(IDLE, "h1");
			if (calls === 2) return nextCapture.promise;
			return tmuxFrame(WORKING, "h3");
		};
		const reports: Array<{ team: string; value: unknown }> = [];
		const scheduler = new PresenceScheduler({ peek, report: (team, value) => reports.push({ team, value }) });
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);

		const active = scheduler.tick("proj.main");
		await scheduler.setWatches([{ team: "proj.main", target: { ...T }, cadenceMs: 60_000 }]);
		nextCapture.resolve(tmuxFrame(WORKING, "h2"));
		await active;
		await scheduler.tick("proj.main");

		expect(calls).toBe(3);
		expect(reports).toEqual([
			{ team: "proj.main", value: { working: true, needsLogin: false, limitBlocked: false } },
		]);
	});

	it("confirms the flip back to idle off an unchanged pane, which is what an idle pane looks like", async () => {
		// Measured on a live session: eight consecutive idle captures hashed IDENTICALLY, while every
		// working capture differed. Confirming on two distinct FRAMES therefore made this flip
		// unreachable - the pane sits still once the turn ends, so the pending window never closed and
		// the board tile pulsed until something unrelated perturbed the pane (opening the terminal
		// view, whose peek resizes and reflows it). Agreement is on the derived value, not the pixels.
		const { scheduler, reports } = makeScheduler([
			tmuxFrame(WORKING, "h1"),
			tmuxFrame(WORKING, "h2"), // confirms working
			tmuxFrame(IDLE, "h3"), // the turn ends: pending idle
			tmuxFrame(IDLE, "h3"), // pane now static - same hash, and it must still confirm
		]);
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		await scheduler.tick("proj.main");
		await scheduler.tick("proj.main");
		await scheduler.tick("proj.main");

		expect(reports).toEqual([
			{ team: "proj.main", value: { working: true, needsLogin: false, limitBlocked: false } },
			{ team: "proj.main", value: { working: false, needsLogin: false, limitBlocked: false } },
		]);
	});

	it("container-logs frames never participate in hysteresis (no confirmation, no reset)", async () => {
		const { scheduler, reports } = makeScheduler([
			tmuxFrame(IDLE, "h1"),
			tmuxFrame(WORKING, "h2"), // pending working
			logsFrame("h3"), // pre-pane fallback frame mid-stream - ignored entirely
			tmuxFrame(WORKING, "h4"), // still confirms working (the pending window survived the logs frame)
		]);
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		await scheduler.tick("proj.main");
		await scheduler.tick("proj.main");
		await scheduler.tick("proj.main");
		expect(reports).toEqual([
			{ team: "proj.main", value: { working: true, needsLogin: false, limitBlocked: false } },
		]);
	});
});

describe("PresenceScheduler watch lifecycle", () => {
	it("dropping a team from setWatches stops peeking it and reports it as unknown (undefined)", async () => {
		const { scheduler, reports, peek } = makeScheduler([tmuxFrame(WORKING, "h1"), tmuxFrame(WORKING, "h2")]);
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		await scheduler.tick("proj.main");
		await scheduler.tick("proj.main");
		reports.length = 0;
		peek.mockClear();

		await scheduler.setWatches([]); // dropped
		expect(reports).toEqual([{ team: "proj.main", value: undefined }]);

		await scheduler.tick("proj.main"); // no-op: not watched anymore
		expect(peek).not.toHaveBeenCalled();
	});

	it("ignores a peek that completes after stopping the watch", async () => {
		const late = deferred<HostPeekResult>();
		const lateFrame = tmuxFrame(WORKING, "h2");
		let calls = 0;
		const peek = async (): Promise<HostPeekResult> => {
			calls += 1;
			if (calls === 1) return tmuxFrame(IDLE, "h1");
			if (calls === 2) return late.promise;
			if (calls === 3) return lateFrame;
			return tmuxFrame(WORKING, "h3");
		};
		const reports: Array<{ team: string; value: unknown }> = [];
		const scheduler = new PresenceScheduler({ peek, report: (team, value) => reports.push({ team, value }) });
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		const active = scheduler.tick("proj.main");
		scheduler.stopWatching("proj.main");
		reports.length = 0;

		late.resolve(lateFrame);
		await active;
		expect(reports).toEqual([]);

		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		await scheduler.tick("proj.main");
		expect(reports).toEqual([
			{ team: "proj.main", value: { working: true, needsLogin: false, limitBlocked: false } },
		]);
	});

	it("ignores a peek that completes for a replaced target", async () => {
		const late = deferred<HostPeekResult>();
		let calls = 0;
		const peek = async (): Promise<HostPeekResult> => {
			calls += 1;
			if (calls === 1) return tmuxFrame(IDLE, "h1");
			if (calls === 2) return late.promise;
			return tmuxFrame(WORKING, `h${calls}`);
		};
		const reports: Array<{ team: string; value: unknown }> = [];
		const scheduler = new PresenceScheduler({ peek, report: (team, value) => reports.push({ team, value }) });
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		const active = scheduler.tick("proj.main");
		await scheduler.setWatches([{ team: "proj.main", target: { ...T, sessionName: "other" }, cadenceMs: 60_000 }]);

		late.resolve(tmuxFrame(WORKING, "h2"));
		await active;
		expect(reports).toEqual([]);

		await scheduler.tick("proj.main");
		expect(reports).toEqual([]);
		await scheduler.tick("proj.main");
		expect(reports).toEqual([
			{ team: "proj.main", value: { working: true, needsLogin: false, limitBlocked: false } },
		]);
	});

	it("starts the re-added watch while the stopped watch still has a pending peek", async () => {
		const late = deferred<HostPeekResult>();
		const lateFrame = tmuxFrame(WORKING, "h4");
		let calls = 0;
		const peek = async (): Promise<HostPeekResult> => {
			calls += 1;
			if (calls === 1) return tmuxFrame(IDLE, "h1");
			if (calls === 2) return late.promise;
			if (calls === 3) return tmuxFrame(WORKING, "h3");
			return lateFrame;
		};
		const reports: Array<{ team: string; value: unknown }> = [];
		const scheduler = new PresenceScheduler({ peek, report: (team, value) => reports.push({ team, value }) });
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		const active = scheduler.tick("proj.main");

		scheduler.stopWatching("proj.main");
		reports.length = 0;
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		expect(calls).toBe(3);
		expect(reports).toEqual([]);

		late.resolve(lateFrame);
		await active;
		await scheduler.tick("proj.main");
		expect(reports).toEqual([
			{ team: "proj.main", value: { working: true, needsLogin: false, limitBlocked: false } },
		]);
	});

	it("a peek-failure streak (3 consecutive) clears to unknown; a single transient failure does not", async () => {
		let calls = 0;
		const reports: Array<{ team: string; value: unknown }> = [];
		const peek = vi.fn(async () => {
			calls++;
			if (calls <= 2) throw new Error("host offline");
			throw new Error("still offline");
		});
		const scheduler = new PresenceScheduler({ peek, report: (team, value) => reports.push({ team, value }) });
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		expect(reports).toEqual([]); // 1 failure: no report yet
		await scheduler.tick("proj.main");
		expect(reports).toEqual([]); // 2 failures: still no report
		await scheduler.tick("proj.main");
		expect(reports).toEqual([{ team: "proj.main", value: undefined }]); // 3rd: clears
	});

	it("a cadence change reschedules without re-peeking or discarding hysteresis history", async () => {
		const { scheduler, reports, peek } = makeScheduler([
			tmuxFrame(WORKING, "h1"), // pending working
		]);
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 5_000 }]); // cadence ramp

		// Only the FIRST setWatches peeks: a ramp on an already-watched team just retimes the loop. An
		// extra peek here would land inside hostOpRunner's cadence floor and hand back the capture the
		// first tick already consumed, confirming `working` off one capture counted twice.
		expect(peek).toHaveBeenCalledTimes(1);
		expect(reports).toEqual([]);
	});

	it("clearAll (daemon disconnect) reports every watched team as unknown without dropping the watch list", async () => {
		const { scheduler, reports, peek } = makeScheduler([tmuxFrame(WORKING, "h1"), tmuxFrame(WORKING, "h2")]);
		await scheduler.setWatches([{ team: "proj.main", target: T, cadenceMs: 60_000 }]);
		await scheduler.tick("proj.main");
		reports.length = 0;
		peek.mockClear();

		scheduler.clearAll();
		expect(reports).toEqual([{ team: "proj.main", value: undefined }]);

		// Still watched - a later tick peeks again (daemon reconnected) rather than needing a fresh
		// setWatches push.
		await scheduler.tick("proj.main");
		expect(peek).toHaveBeenCalledTimes(1);
	});
});
