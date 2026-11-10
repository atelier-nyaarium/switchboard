import { describe, expect, it, vi } from "vitest";
import { decideWakeCreate, WakeCoordinator } from "../gateway/wake.js";
import { processAmbient } from "../shared/ambient.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

describe("WakeCoordinator", () => {
	it("resolves a waiter true when its team is notified online", async () => {
		const coord = new WakeCoordinator(processAmbient());
		const p = coord.waitFor("alpha", 10_000);
		coord.notify("alpha", true);
		await expect(p).resolves.toEqual({ ok: true });
	});

	it("resolves a definitive failure when notified of a failed wake (no errorKind)", async () => {
		const coord = new WakeCoordinator(processAmbient());
		const p = coord.waitFor("alpha", 10_000);
		coord.notify("alpha", false);
		await expect(p).resolves.toEqual({ ok: false });
	});

	it("does not wait for an edge that already passed", async () => {
		const live = new Set<string>();
		const coord = new WakeCoordinator(processAmbient(), (team) => live.has(team));
		live.add("alpha");
		coord.notify("alpha");

		await expect(coord.waitFor("alpha", 10)).resolves.toEqual({ ok: true });
	});

	it("resolves an ambiguous timeout rather than hanging", async () => {
		const coord = new WakeCoordinator(processAmbient());
		await expect(coord.waitFor("slow", 10)).resolves.toEqual({ ok: false, errorKind: "timeout" });
	});

	it("notify resolves every waiter for that team and leaves other teams pending", async () => {
		const coord = new WakeCoordinator(processAmbient());
		const a1 = coord.waitFor("a", 10_000);
		const a2 = coord.waitFor("a", 10_000);
		coord.notify("a", true);
		await expect(a1).resolves.toEqual({ ok: true });
		await expect(a2).resolves.toEqual({ ok: true });
		const b = coord.waitFor("b", 10_000);
		coord.notify("b", false);
		await expect(b).resolves.toEqual({ ok: false });
	});

	it("failAll resolves every in-flight wake as ambiguous (disconnected) across all teams", async () => {
		const coord = new WakeCoordinator(processAmbient());
		const a = coord.waitFor("a", 10_000);
		const b = coord.waitFor("b", 10_000);
		coord.failAll();
		await expect(a).resolves.toEqual({ ok: false, errorKind: "disconnected" });
		await expect(b).resolves.toEqual({ ok: false, errorKind: "disconnected" });
	});

	it("ackReceived shortens every in-flight wait so a started-but-unregistered team fails fast, still ambiguous", async () => {
		const coord = new WakeCoordinator(processAmbient());
		// Verifies the shortened deadline.
		const waits = [coord.waitFor("alpha", 10_000), coord.waitFor("alpha", 10_000)];
		coord.ackReceived("alpha", 10);
		await expect(Promise.all(waits)).resolves.toEqual([
			{ ok: false, errorKind: "timeout" },
			{ ok: false, errorKind: "timeout" },
		]);
	});

	it("ackReceived still resolves every waiter true when the team registers within the window", async () => {
		const coord = new WakeCoordinator(processAmbient());
		const waits = [coord.waitFor("alpha", 10_000), coord.waitFor("alpha", 10_000)];
		coord.ackReceived("alpha", 10_000);
		coord.notify("alpha", true);
		await expect(Promise.all(waits)).resolves.toEqual([{ ok: true }, { ok: true }]);
	});

	it("ackReceived can only bring the deadline in, never push it out", async () => {
		// Timing distinguishes clamped from unclamped deadlines.
		vi.useFakeTimers();
		try {
			const coord = new WakeCoordinator(processAmbient());
			// A wider window must not extend the deadline.
			const p = coord.waitFor("alpha", 5_000);
			let settled = false;
			void p.then(() => {
				settled = true;
			});
			coord.ackReceived("alpha", 10_000);

			await vi.advanceTimersByTimeAsync(5_000);
			expect(settled).toBe(true);
			await expect(p).resolves.toEqual({ ok: false, errorKind: "timeout" });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a launch's stages", () => {
	const WINDOW = 1_000;

	function rig() {
		const ambient = fakeAmbient({ drive: "manual" });
		const coord = new WakeCoordinator(ambient);
		const watch = (wait: Promise<unknown>) => {
			const state: { settled: unknown } = { settled: undefined };
			void wait.then((result) => {
				state.settled = result;
			});
			return state;
		};
		return { ambient, coord, watch };
	}
	const timedOut = { ok: false, errorKind: "timeout" };

	it("holds a waiter through a build, then gives it the whole window from the container coming up", async () => {
		const { ambient, coord, watch } = rig();
		coord.stage("alpha", "building");
		const wait = watch(coord.waitFor("alpha", WINDOW));

		await ambient.advance(10 * WINDOW);
		const duringBuild = wait.settled;
		coord.stage("alpha", "container_up");
		await ambient.advance(WINDOW - 1);
		const justBefore = wait.settled;
		await ambient.advance(1);

		expect([duringBuild, justBefore]).toEqual([undefined, undefined]);
		expect(wait.settled).toEqual(timedOut);
	});

	it("gives a waiter arriving after the container came up only the time left", async () => {
		const { ambient, coord, watch } = rig();
		coord.stage("alpha", "container_up");
		await ambient.advance(600);
		const wait = watch(coord.waitFor("alpha", WINDOW));

		await ambient.advance(399);
		const justBefore = wait.settled;
		await ambient.advance(1);

		expect(justBefore).toBeUndefined();
		expect(wait.settled).toEqual(timedOut);
	});

	it("gives the whole window when the container came up longer ago than that", async () => {
		const { ambient, coord, watch } = rig();
		coord.stage("alpha", "container_up");
		await ambient.advance(WINDOW + 500);
		const wait = watch(coord.waitFor("alpha", WINDOW));

		await ambient.advance(WINDOW - 1);
		const justBefore = wait.settled;
		await ambient.advance(1);

		expect(justBefore).toBeUndefined();
		expect(wait.settled).toEqual(timedOut);
	});

	it("forgets every stage when the host link drops, so a build no longer holds a waiter", async () => {
		const { ambient, coord, watch } = rig();
		coord.stage("alpha", "building");
		coord.failAll();
		const wait = watch(coord.waitFor("alpha", WINDOW));

		await ambient.advance(WINDOW);

		expect(wait.settled).toEqual(timedOut);
		expect(coord.countdownFrom("alpha")).toBe(ambient.now() - WINDOW);
	});

	it("answers when a launch's countdown runs from: never while building, else the container's coming up", async () => {
		const { ambient, coord } = rig();
		const startedAt = ambient.now();
		await ambient.advance(100);
		const unstaged = coord.countdownFrom("alpha");
		coord.stage("alpha", "building");
		const building = coord.countdownFrom("alpha");
		await ambient.advance(100);
		coord.stage("alpha", "container_up");

		expect([unstaged, building, coord.countdownFrom("alpha")]).toEqual([startedAt, null, startedAt + 200]);
	});

	it("leaves a newer launch's waiter alone when an older launch's stage or result arrives late", async () => {
		const { ambient, coord, watch } = rig();
		const wait = watch(coord.waitFor("alpha", WINDOW, "launch-new"));

		coord.stage("alpha", "building", "launch-old");
		coord.fail("alpha", { error: "the old pane died" }, "launch-old");
		await ambient.advance(WINDOW - 1);
		const justBefore = wait.settled;
		await ambient.advance(1);

		expect(justBefore).toBeUndefined();
		expect(wait.settled).toEqual(timedOut);
	});

	it("settles a launch by its own id, and any of its team's launches by a frame that names none", async () => {
		const { coord } = rig();
		const named = coord.waitFor("alpha", WINDOW, "launch-a");
		const untagged = coord.waitFor("beta", WINDOW, "launch-b");

		coord.fail("alpha", { error: "named" }, "launch-a");
		coord.notify("beta");

		await expect(named).resolves.toEqual({ ok: false, error: "named" });
		await expect(untagged).resolves.toEqual({ ok: true });
	});

	it("tells every failure listener of a daemon failure, waited on or not", () => {
		const { coord } = rig();
		const heard: unknown[] = [];
		coord.onFailure((team, detail) => heard.push([team, detail]));

		coord.fail("alpha", { failure: { kind: "timeout" } });
		coord.fail("beta", { error: "pane died" });

		expect(heard).toEqual([
			["alpha", { failure: { kind: "timeout" } }],
			["beta", { error: "pane died" }],
		]);
	});
});

describe("decideWakeCreate", () => {
	it("reattaches an existing record and ignores a displayLabel entirely, even one that was supplied", () => {
		// Existing records ignore display labels.
		expect(decideWakeCreate("proj.existing", true, undefined)).toEqual({ kind: "reattach" });
		expect(decideWakeCreate("proj.existing", true, "Some Label")).toEqual({ kind: "reattach" });
	});

	it("mints under a supplied displayLabel when no record exists yet", () => {
		expect(decideWakeCreate("proj.newsession", false, "Bug Hunt")).toEqual({
			kind: "mint",
			sessionLabel: "Bug Hunt",
		});
	});

	const refused = { kind: "refuse", error: expect.any(String), refusal: { kind: "no_label" } };

	it("refuses as having no label when no record exists and no displayLabel was supplied", () => {
		expect(decideWakeCreate("proj.newsession", false, undefined)).toEqual(refused);
	});

	it("refuses a whitespace/invisible-only displayLabel the same as an absent one, rather than minting a garbage-labeled session", () => {
		// Sanitization rejects invisible labels.
		expect(decideWakeCreate("proj.newsession", false, "   ")).toEqual(refused);
		expect(decideWakeCreate("proj.newsession", false, "\u200b")).toEqual(refused);
		expect(decideWakeCreate("proj.newsession", false, ".")).toEqual(refused);
	});

	it("mints under the sanitized form of a displayLabel that needed trimming", () => {
		expect(decideWakeCreate("proj.newsession", false, "  Bug Hunt  ")).toEqual({
			kind: "mint",
			sessionLabel: "Bug Hunt",
		});
	});
});
