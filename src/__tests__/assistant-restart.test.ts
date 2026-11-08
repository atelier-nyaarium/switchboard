import { describe, expect, it } from "vitest";
import { createAssistantRestart, RESTART_GRACE_MS } from "../gateway/assistant/assistantRestart.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import type { HostOp, HostOpResult } from "../shared/host-op.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

function setup(answers: Array<{ typed: boolean }>, busy = () => false) {
	const ambient = fakeAmbient({ drive: "manual" });
	const ops: HostOp[] = [];
	const restart = createAssistantRestart({
		ambient,
		busy,
		relayToHost: async (op): Promise<HostOpResult> => {
			ops.push(op);
			const next = answers.shift() ?? { typed: true };
			return { ok: true, result: next.typed ? { typed: true } : { typed: false, reason: "busy" } };
		},
	});
	return { ambient, ops, restart };
}

describe("assistant restart on an installed update", () => {
	it("types /exit into an idle assistant after the grace, retrying a busy pane", async () => {
		const { ambient, ops, restart } = setup([{ typed: false }, { typed: true }]);
		restart.seen("host.other", true);
		restart.seen(ASSISTANT_TEAM, true);
		await ambient.advance(RESTART_GRACE_MS - 1);
		expect(ops).toHaveLength(0);
		await ambient.advance(1);
		await ambient.advance(RESTART_GRACE_MS);
		expect(ops).toHaveLength(2);
		expect(ops[1]).toMatchObject({ kind: "typeIntoPane", text: "/exit", target: { sessionName: "assistant" } });
		await ambient.advance(RESTART_GRACE_MS * 3);
		expect(ops).toHaveLength(2);
	});

	it("waits out an open run or agent turn, and stands down once the line goes", async () => {
		let busy = true;
		const { ambient, ops, restart } = setup([], () => busy);
		restart.seen(ASSISTANT_TEAM, true);
		await ambient.advance(RESTART_GRACE_MS * 2);
		expect(ops).toHaveLength(0);
		restart.seen(ASSISTANT_TEAM, false);
		busy = false;
		await ambient.advance(RESTART_GRACE_MS * 2);
		expect(ops).toHaveLength(0);
	});
});
