import { describe, expect, it } from "vitest";
import { createAwarenessBank } from "../gateway/awarenessBank.js";
import { workspaceAnswerNoting, workspaceAwarenessSubscriber } from "../gateway/workspaceAwareness.js";
import type { ChannelPushPayload } from "../shared/types.js";
import type { FileMutation, WorkspaceOp, WorkspaceOpAnswer, WorkspaceOpResult } from "../shared/workspace-op.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

////////////////////////////////
//  Functions & Helpers

const mutation = (m: FileMutation): WorkspaceOp => ({ kind: "mutateFile", mutation: m });

const answered = (answer: WorkspaceOpAnswer): WorkspaceOpResult => ({ ok: true, answer });

const done = (path: string) => answered({ kind: "mutateFile", path, outcome: "done" });

////////////////////////////////
//  Tests

describe("workspace awareness", () => {
	it("tells the session each file the owner changed or may have, once per path, and nothing else", () => {
		let now = 0;
		const sent: ChannelPushPayload[] = [];
		const bank = createAwarenessBank({
			liveness: () => "live",
			ambient: fakeAmbient({ now: () => now }),
			deliver: (_session, payload) => {
				sent.push(payload);
				return true;
			},
		});
		const observe = bank.register(workspaceAwarenessSubscriber);
		const ask = (op: WorkspaceOp, result: WorkspaceOpResult) =>
			workspaceAnswerNoting(op, result, (change) =>
				observe([{ sessionKey: "s", identity: change.path, pre: undefined, post: change }]),
			);

		const write = mutation({ kind: "write", path: "src/a.ts", expectedHash: "h", text: "x" });
		ask(write, done("src/a.ts"));
		ask(write, done("src/a.ts"));
		ask(mutation({ kind: "create", path: "src/b.ts", text: "" }), done("src/b.ts"));
		ask(mutation({ kind: "delete", path: "src/b.ts", expectedHash: "h", expectedIdentity: "i" }), done("src/b.ts"));
		const move = mutation({
			kind: "move",
			path: "src/c.ts",
			expectedHash: "h",
			expectedIdentity: "i",
			to: "lib/c.ts",
			destination: { kind: "absent" },
		});
		expect(ask(move, { ok: false, failure: "timeout", detail: "slow" })).toMatchObject({ outcome: "unknown" });
		const save: WorkspaceOp = { kind: "saveSpan", symbolId: "sym", expectedSpanHash: "h", text: "x" };
		// @unknown Only the module is read from the span.
		ask(
			save,
			answered({
				kind: "saveSpan",
				symbolId: "sym",
				outcome: "saved",
				current: { module: "src/d.ts" },
			} as WorkspaceOpAnswer),
		);

		const stale = mutation({ kind: "write", path: "src/e.ts", expectedHash: "h", text: "x" });
		ask(stale, answered({ kind: "mutateFile", path: "src/e.ts", outcome: "stale" }));
		expect(() => ask(stale, { ok: false, failure: "refused", detail: "withheld" })).toThrow("withheld");
		ask({ kind: "read", path: "src/e.ts" }, answered({ kind: "read", path: "src/e.ts", text: "", lines: 0 }));

		now = 10 * 60_000;
		bank.tick();
		expect(sent).toHaveLength(0);

		const told = bank.takeFor("s");
		expect(told?.act).toBe("no_act");
		expect(told?.body.split("\n").slice(1)).toEqual([
			"- edited src/a.ts",
			"- deleted src/b.ts",
			"- may have moved src/c.ts to lib/c.ts",
			"- edited src/d.ts",
		]);
	});

	it("lists a bounded number of changes and counts the rest", () => {
		const bank = createAwarenessBank({
			liveness: () => "live",
			ambient: fakeAmbient({ now: () => 0 }),
			deliver: () => true,
		});
		const observe = bank.register(workspaceAwarenessSubscriber);
		for (let i = 0; i < 100; i++) {
			const change = { path: `src/f${i}.ts`, change: "created", confirmed: true } as const;
			observe([{ sessionKey: "s", identity: change.path, pre: undefined, post: change }]);
		}

		const lines = bank.takeFor("s")?.body.split("\n") ?? [];
		expect(lines.length).toBeLessThan(50);
		expect(lines.at(-1)).toMatch(/more$/);
	});
});
