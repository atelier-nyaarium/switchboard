import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

describe("the assistant's session through the console", () => {
	let h: FederationHarness;

	const dispatch = async (target: string, op: Parameters<typeof h.phone.deliver>[1]) => {
		const opId = `op-assistant-${op.kind}`;
		expect((await h.phone.deliver(target, op, opId)).outcome).toBe("accepted");
		const row = await h.waitFor(
			async () =>
				(await h.phone.inboxRead()).find(
					(candidate) => candidate.envelope.kind === "op_result" && candidate.envelope.opKey.opId === opId,
				),
			`dispatch result for ${opId}`,
		);
		return h.phone.open(row) as { ok: boolean; error?: string };
	};

	beforeAll(async () => {
		h = await startFederationHarness({ assistantWorkdir: "~/projects/notes" });
	}, 30_000);
	afterAll(async () => {
		if (h) await h.close();
	});

	it("is provisioned at boot and refuses a forget", async () => {
		const opsBefore = h.host.ops.length;
		const answer = await dispatch(ASSISTANT_TEAM, { kind: "forget", target: h.target(ASSISTANT_TEAM) });

		expect(answer.ok, JSON.stringify(answer)).toBe(false);
		expect(h.gateway.faults.sessionRecord(ASSISTANT_TEAM)).toMatchObject({ workdirPath: "~/projects/notes" });
		expect(h.host.ops.length).toBe(opsBefore);
	});

	it("outlives the session sweep that takes an ordinary idle session", async () => {
		const { result } = await h.phone.value({
			kind: "create_session",
			target: h.target("host"),
			displayLabel: "Idle",
		});
		const idle = `host.${(result as { id: string }).id}`;
		await new Promise((resolve) => setTimeout(resolve, 5));

		const swept = h.gateway.faults.sweepSessions(0);

		expect(swept).toContain(idle);
		expect(swept).not.toContain(ASSISTANT_TEAM);
		expect(h.gateway.faults.sessionRecord(ASSISTANT_TEAM)).toBeDefined();
	});
});
