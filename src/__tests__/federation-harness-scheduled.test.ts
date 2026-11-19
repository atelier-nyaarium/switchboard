import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scheduledBodyAadKind } from "../shared/content-envelope.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

describe("federation harness: a scheduled send", () => {
	let h: FederationHarness;
	let live: FakeSession;
	beforeAll(async () => {
		h = await startFederationHarness();
		live = attachFakeSession(h.gateway, { team: "fixture-app.sched", conversationId: "conv-sched" });
		await live.ready();
	}, 30_000);
	afterAll(async () => {
		live?.close();
		if (h) await h.close();
	});

	it("lands as the owner's message, and its reply reaches the owner's conversation", async () => {
		const opId = "sched-op-1";
		const { conversationId } = h.phone.ownerOp({ kind: "hello" });
		const [domainId, gatewayId] = h.target(live.team).split(".") as [string, string];
		const plaintext = JSON.stringify({ text: "scheduled hello", messageId: opId, files: [] });
		const armed = (await h.phone.send(
			{
				kind: "schedule_send",
				target: { domainId, gatewayId, sessionId: live.team },
				fireAt: h.now(),
				opId,
				files: [],
				body: h.phone.seal(plaintext, scheduledBodyAadKind(conversationId, opId)),
			},
			opId,
		)) as { outcome: string };
		expect(armed.outcome).toBe("accepted");

		const push = await h.waitFor(
			() => live.inbound.find((frame) => frame.body === "scheduled hello"),
			"the scheduled push",
		);
		expect(push.from).toBe(h.phone.device);

		// Same conversation as ordinary.
		expect((await h.phone.deliver(live.team, { kind: "send", to: live.team, body: "ordinary" })).outcome).toBe(
			"accepted",
		);
		const ordinary = await h.waitFor(() => live.inbound.find((frame) => frame.body === "ordinary"), "the push");
		expect(push.session_id).toBe(ordinary.session_id);

		expect((await live.reply(String(push.session_id), "got it")).status).toBe(200);
		const reply = await h.waitFor(async () => {
			const entries = h.phone.entries(await h.phone.inboxRead());
			return entries.find((entry) => entry.kind === "reply" && entry.body === "got it");
		}, "the owner's reply row");
		expect(reply.session_id).toBe(push.session_id);
		// No Gateway mirror.
		const entries = h.phone.entries(await h.phone.inboxRead());
		expect(entries.filter((entry) => entry.kind === "sent" && entry.opId === opId)).toEqual([]);
	});

	it("tells the owner when the Gateway refuses the fired send", async () => {
		const opId = "sched-op-refused";
		const { conversationId } = h.phone.ownerOp({ kind: "hello" });
		const [domainId, gatewayId] = h.target(live.team).split(".") as [string, string];
		// Not the scheduled shape.
		const plaintext = JSON.stringify({ to: live.team, from: "phone", body: "refused" });
		await h.phone.send(
			{
				kind: "schedule_send",
				target: { domainId, gatewayId, sessionId: live.team },
				fireAt: h.now(),
				opId,
				files: [],
				body: h.phone.seal(plaintext, scheduledBodyAadKind(conversationId, opId)),
			},
			opId,
		);
		const results = async () =>
			(await h.phone.inboxRead())
				.filter((row) => row.envelope.kind === "scheduled_result")
				.map((row) => row.body as { opId: string; outcome: string; reason?: string })
				.filter((body) => body.opId === opId);
		const failed = await h.waitFor(
			async () => (await results()).find((body) => body.outcome === "failed"),
			"the failed result",
		);
		expect(failed.reason).toBe("malformed_body");
		expect((await results()).map((body) => body.outcome)).toEqual(["pending", "sent", "failed"]);
		expect(live.inbound.filter((frame) => frame.body === "refused")).toEqual([]);
	});
});
