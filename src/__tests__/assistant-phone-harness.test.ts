import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASSISTANT_HOLD_PATH } from "../shared/assistant-hold.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import { ACTION_FRONT_ROUTES } from "../shared/schemasActionFront.js";
import type { PhoneCapabilityAnswer } from "../shared/schemasPhoneCapabilities.js";
import { PHONE_HOLD_WINDOW_MS } from "../shared/schemasPhoneHold.js";
import { createFakeKasaPlug, type FakeKasaPlug } from "../testing/fakeKasaPlug.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";
import type { MailboxEntry } from "../testing/phoneDriver.js";

describe("phone capabilities through the federation harness", () => {
	let h: FederationHarness;
	let assistant: FakeSession;
	let plug: FakeKasaPlug;
	let clock: number;

	const postPhone = (key: string, callId: string, params: Record<string, unknown> = {}) =>
		assistant.post(ACTION_FRONT_ROUTES.run, { id: `phone/${key}`, callId, params });

	const drainCapability = (requestId: string) =>
		h.waitFor(async () => {
			try {
				return await h.phone.drainPhoneCapability(requestId);
			} catch {
				return undefined;
			}
		}, `phone capability ${requestId}`);

	const answerPhone = (answer: unknown): PhoneCapabilityAnswer => ({ kind: "ok", answer });

	const waitForHold = (kind: string) =>
		h.waitFor(async () => {
			const answer = (await (await assistant.post(ASSISTANT_HOLD_PATH, {})).json()) as { kind: string };
			return answer.kind === kind ? answer : undefined;
		}, `hold ${kind}`);

	beforeAll(async () => {
		clock = Date.now();
		plug = await createFakeKasaPlug({ mac: "aa:bb:cc:dd:ee:ff" });
		h = await startFederationHarness({ now: () => clock, kasaPort: plug.port });
		h.host.handlers.onWake = (frame) => {
			if (frame.team !== ASSISTANT_TEAM) return;
			assistant = attachFakeSession(h.gateway, {
				team: ASSISTANT_TEAM,
				conversationId: "conv-assistant-phone",
				sessionToken: frame.sessionToken as string | undefined,
			});
		};
		const home = await h.phone.homeRead();
		const placed = await h.phone.homePut({
			gatewayId: h.set.gateway.id,
			workdirPath: "~/projects/notes",
			carried: null,
			baseVersion: home.record?.version ?? 0,
		});
		if (!placed.record) throw new Error("the Router did not hold the assistant home");
		await h.waitFor(async () => {
			const current = await h.phone.homeRead();
			return current.report?.version === placed.record?.version && current.report?.outcome === "placed"
				? current
				: undefined;
		}, "assistant placement");
		await h.phone.deliver(ASSISTANT_TEAM, {
			kind: "send",
			to: ASSISTANT_TEAM,
			body: "Start the phone capability session.",
		});
		await h.waitFor(() => assistant, "assistant session");
		await assistant.registered();
		await assistant.ready();
	}, 60_000);

	afterAll(async () => {
		assistant?.close();
		if (h) await h.close();
		if (plug) await plug.close();
	});

	it("answers no holder as unavailable, then claims the phone hold", async () => {
		const result = await (await postPhone("status", "phone-status-no-holder")).json();
		expect(result).toMatchObject({ kind: "unavailable", reason: "no_holder" });
		expect((result as { detail?: string }).detail).toContain("No phone holds me");

		const claimed = await h.phone.claimHold();
		expect(claimed.hold).toMatchObject({ holder: h.phone.signerSignPub, label: h.phone.device });
		expect(claimed.lineage?.version).toBe(claimed.hold.version);
		await waitForHold("held");
	});

	it("stamps status to the holder, refuses the other phone, and returns the answer", async () => {
		const callId = "phone-status-stamped";
		const pending = postPhone("status", callId);
		const { row, entry } = await drainCapability(callId);
		const owner = await h.phone2.answerPhone(callId, answerPhone({ holder: h.phone.device, keys: [] }));
		const phone = await h.phone.answerPhone(callId, answerPhone({ holder: h.phone.device, keys: [] }));
		const result = await (await pending).json();

		expect(row.stamp).toEqual({ holder: h.phone.signerSignPub });
		expect(entry).toMatchObject({
			kind: "plugin_action",
			pluginId: "phone",
			actionType: "capability",
			payload: { requestId: callId, key: "status", guard: "none" },
		});
		expect(owner.result).toMatchObject({ ok: false, reason: "the answer came from a different phone" });
		expect(phone.result).toMatchObject({ ok: true });
		expect(result).toEqual({ kind: "ok", answer: { holder: h.phone.device, keys: [] } });

		const records = (await h.phone.inboxRead())
			.map((candidate) => h.phone.open(candidate) as MailboxEntry)
			.filter((candidate) => candidate.kind === "assistant_record");
		expect(records).toEqual([]);
	});

	it("refuses at once when the holder answers outside the schema", async () => {
		const callId = "phone-status-malformed";
		const pending = postPhone("status", callId);
		await drainCapability(callId);
		const malformed = await h.phone.answerPhone(
			callId,
			answerPhone({ holder: h.phone.device, keys: [{ key: "torch" }] }),
		);
		const result = await (await pending).json();

		expect(malformed.result).toMatchObject({ ok: false, reason: "the capability answer did not match its schema" });
		expect(result).toMatchObject({ kind: "refused", reason: "the capability answer did not match its schema" });
	});

	it("runs a registered phone act directly", async () => {
		const callId = "phone-torch-direct";
		const pending = postPhone("torch", callId, { on: true });
		const request = await drainCapability(callId);
		expect(request.entry).toMatchObject({ payload: { guard: "none", key: "torch" } });
		await h.phone.answerPhone(callId, answerPhone({ on: true, levels: 1 }));
		expect(await (await pending).json()).toMatchObject({ kind: "ok", answer: { on: true, levels: 1 } });
	});

	it("adds a device through the Router and lists its set state in the assistant", async () => {
		const added = await h.phone.value({
			kind: "device_add",
			mac: "aa:bb:cc:dd:ee:ff",
			address: "127.0.0.1",
			name: "Hall lamp",
		});
		expect(added.result).toMatchObject({ stored: true, record: { id: "aa:bb:cc:dd:ee:ff", name: "Hall lamp" } });

		const set = await h.phone.value({ kind: "device_set", id: "aa:bb:cc:dd:ee:ff", verb: "on" });
		expect(set.result).toMatchObject({ state: { state: "on" } });

		const action = await (await postPhone("devices", "assistant-device-list-01")).json();
		expect(action).toEqual({
			kind: "ok",
			answer: {
				devices: [{ id: "aa:bb:cc:dd:ee:ff", name: "Hall lamp", kind: "switch", state: "on" }],
			},
		});
	});

	it("replays a call id without appending a second phone row", async () => {
		const callId = "phone-status-replay";
		const first = postPhone("status", callId);
		const second = postPhone("status", callId);
		await drainCapability(callId);
		await h.phone.answerPhone(callId, answerPhone({ holder: h.phone.device, keys: [] }));
		const [one, two] = await Promise.all([first, second].map(async (pending) => (await pending).json()));
		const rows = await h.phone.inboxRead();
		const requests = rows
			.map((row) => h.phone.open(row) as MailboxEntry)
			.filter((entry) => entry.kind === "plugin_action" && entry.actionType === "capability")
			.filter((entry) => entry.payload?.requestId === callId);

		expect(one).toEqual(two);
		expect(requests).toHaveLength(1);
	});

	it("hands one phone's read anchor to the other through the plane", async () => {
		const team = "domain.gateway.host.journal";
		const stream = `scheduled:${team}`;
		const reported = await h.phone.reportRead(stream, 1, 5);
		expect(reported.status).toBe(200);

		const anchors = await h.waitFor(async () => {
			const { planes } = await h.phone2.planesRead({});
			const plane = planes.find((candidate) => candidate.name === "readAnchors");
			const payload = plane?.payload as { anchors?: Array<{ stream: string; seq: number }> } | undefined;
			return payload?.anchors?.find((anchor) => anchor.stream === stream);
		}, "read anchor on the second phone");
		expect(anchors).toMatchObject({ stream, seq: 5 });
	});

	// Lapses the hold; keep last.
	it("refuses a lapsed hold with the holder named", async () => {
		await h.phone.claimHold();
		await waitForHold("held");
		clock += PHONE_HOLD_WINDOW_MS + 60_000;

		const result = (await (await postPhone("status", "phone-status-lapsed")).json()) as {
			kind: string;
			reason?: string;
			detail?: string;
		};
		expect(result).toMatchObject({ kind: "unavailable", reason: "no_holder" });
		expect(result.detail).toContain("lapsed");
		const hold = (await (await assistant.post(ASSISTANT_HOLD_PATH, {})).json()) as {
			kind: string;
			holder?: string;
		};
		expect(hold).toMatchObject({ kind: "lapsed", holder: h.phone.signerSignPub, label: h.phone.device });
	});
});
