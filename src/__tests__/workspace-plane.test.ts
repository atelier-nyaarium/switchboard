import { describe, expect, it } from "vitest";
import { WorkspaceOpCoordinator } from "../gateway/workspaceOpCoordinator.js";
import { createOpDedupe } from "../mcp/workspace/opDedupe.js";
import { parseWorkspaceOpRequest } from "../mcp/workspace/plane.js";
import type { WorkspaceOpResult } from "../shared/workspace-op.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

////////////////////////////////
//  Functions & Helpers

const clockOf = () => fakeAmbient({ drive: "manual", now: () => 0 });

const answered: WorkspaceOpResult = { ok: true, answer: { kind: "read", path: "a.ts", text: "x", lines: 1 } };
const refused: WorkspaceOpResult = { ok: false, failure: "refused", detail: "withheld" };

////////////////////////////////
//  Tests

describe("reading a workspace op frame", () => {
	const frame = (op: unknown) => ({ reqId: "r", key: "k", op });

	it("takes a save only whole, since a missing hash would be a save with no precondition", () => {
		const whole = { kind: "saveSpan", symbolId: "s", expectedSpanHash: "h", text: "" };

		expect(parseWorkspaceOpRequest(frame(whole))).toEqual({ reqId: "r", key: "k", op: whole });
		expect(parseWorkspaceOpRequest(frame({ kind: "saveSpan", symbolId: "s", text: "x" }))).toMatchObject({
			refused: expect.any(String),
		});
	});

	// Silence would hold the Gateway to its full timeout for an op an older plugin cannot read.
	it("refuses an op it cannot read at once, and ignores only a frame with no request to answer", () => {
		expect(parseWorkspaceOpRequest(frame({ kind: "delete", path: "a" }))).toMatchObject({
			reqId: "r",
			refused: expect.any(String),
		});
		expect(parseWorkspaceOpRequest({ key: "k", op: { kind: "tree", path: "" } })).toBeNull();
	});
});

describe("correlating a workspace op with its reply", () => {
	it("settles the waiter that asked", async () => {
		const clock = clockOf();
		const coordinator = new WorkspaceOpCoordinator(clock);

		const pending = coordinator.wait("r1", 1, 1_000);
		expect(coordinator.settle("r1", 1, answered)).toBe(true);

		await expect(pending).resolves.toEqual(answered);
		expect(clock.scheduled()).toBe(0);
	});

	it("drops a reply whose generation was replaced", async () => {
		const clock = clockOf();
		const coordinator = new WorkspaceOpCoordinator(clock);

		const pending = coordinator.wait("r1", 2, 1_000);
		expect(coordinator.settle("r1", 1, answered)).toBe(false);
		expect(coordinator.waiting).toBe(1);

		coordinator.settle("r1", 2, refused);
		await expect(pending).resolves.toEqual(refused);
	});

	it("times out rather than waiting forever, and forgets the waiter", async () => {
		const clock = clockOf();
		const coordinator = new WorkspaceOpCoordinator(clock);

		const pending = coordinator.wait("r1", 1, 500);
		await clock.advance(500);

		await expect(pending).resolves.toMatchObject({ ok: false, failure: "timeout" });
		expect(coordinator.waiting).toBe(0);
		// A reply arriving after the timeout settles nothing.
		expect(coordinator.settle("r1", 1, answered)).toBe(false);
	});

	it("never settles a reply twice", async () => {
		const clock = clockOf();
		const coordinator = new WorkspaceOpCoordinator(clock);

		const pending = coordinator.wait("r1", 1, 1_000);
		expect(coordinator.settle("r1", 1, answered)).toBe(true);
		expect(coordinator.settle("r1", 1, refused)).toBe(false);

		await expect(pending).resolves.toEqual(answered);
	});

	it("fails only the generation that dropped", async () => {
		const clock = clockOf();
		const coordinator = new WorkspaceOpCoordinator(clock);

		const mine = coordinator.wait("r1", 1, 1_000);
		const theirs = coordinator.wait("r2", 2, 1_000);

		expect(coordinator.failGeneration(1, "socket closed")).toBe(1);
		await expect(mine).resolves.toMatchObject({ ok: false, failure: "disconnected" });
		expect(coordinator.waiting).toBe(1);

		coordinator.settle("r2", 2, answered);
		await expect(theirs).resolves.toEqual(answered);
	});

	it("fails everything on a shutdown, leaving no armed timer", async () => {
		const clock = clockOf();
		const coordinator = new WorkspaceOpCoordinator(clock);

		const a = coordinator.wait("r1", 1, 1_000);
		const b = coordinator.wait("r2", 2, 1_000);
		coordinator.failAll("gateway stopping");

		await expect(a).resolves.toMatchObject({ failure: "disconnected" });
		await expect(b).resolves.toMatchObject({ failure: "disconnected" });
		expect(coordinator.waiting).toBe(0);
		expect(clock.scheduled()).toBe(0);
	});
});

describe("at-most-once on the answering side", () => {
	function dedupe(now: () => number = () => 0) {
		return createOpDedupe({ now, holdMs: 1_000 });
	}

	it("runs the work once and replays the answer for a repeated key", async () => {
		const pool = dedupe();
		let runs = 0;
		const work = async () => {
			runs += 1;
			return answered;
		};

		expect(await pool.once("k", work)).toEqual(answered);
		expect(await pool.once("k", work)).toEqual(answered);
		expect(runs).toBe(1);
	});

	// A replay arriving BEFORE the first answer is the case a settled-only map would miss.
	it("joins a flight already open rather than running twice", async () => {
		const pool = dedupe();
		let runs = 0;
		let release: (result: WorkspaceOpResult) => void = () => {};
		const work = () => {
			runs += 1;
			return new Promise<WorkspaceOpResult>((resolve) => {
				release = resolve;
			});
		};

		const first = pool.once("k", work);
		const second = pool.once("k", work);
		expect(pool.open).toBe(1);
		release(answered);

		await expect(first).resolves.toEqual(answered);
		await expect(second).resolves.toEqual(answered);
		expect(runs).toBe(1);
	});

	it("keeps distinct keys apart", async () => {
		const pool = dedupe();
		expect(await pool.once("a", async () => answered)).toEqual(answered);
		expect(await pool.once("b", async () => refused)).toEqual(refused);
		expect(pool.held).toBe(2);
	});

	// A refusal is an ANSWER, so replaying it is right; re-running could answer differently.
	it("replays a refusal as readily as a success", async () => {
		const pool = dedupe();
		let runs = 0;
		const work = async () => {
			runs += 1;
			return refused;
		};

		await pool.once("k", work);
		expect(await pool.once("k", work)).toEqual(refused);
		expect(runs).toBe(1);
	});

	// Nothing was answered, so a retry must be allowed to run.
	it("does not hold a thrown op, so a retry runs again", async () => {
		const pool = dedupe();
		let runs = 0;
		const work = async () => {
			runs += 1;
			if (runs === 1) throw new Error("socket died");
			return answered;
		};

		await expect(pool.once("k", work)).rejects.toThrow("socket died");
		expect(pool.held).toBe(0);
		expect(await pool.once("k", work)).toEqual(answered);
		expect(runs).toBe(2);
	});

	it("forgets a key once its hold has passed", async () => {
		let at = 0;
		const pool = createOpDedupe({ now: () => at, holdMs: 1_000 });
		let runs = 0;
		const work = async () => {
			runs += 1;
			return answered;
		};

		await pool.once("k", work);
		at = 1_001;
		await pool.once("k", work);

		expect(runs).toBe(2);
		expect(pool.held).toBe(1);
	});
});
