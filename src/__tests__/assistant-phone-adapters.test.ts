import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createActGuard } from "../gateway/assistant/actGuard.js";
import type { ActionRecord } from "../gateway/assistant/actionDispatch.js";
import { createPhoneDispatch } from "../gateway/assistant/phoneDispatch.js";
import { createPhoneRequests } from "../gateway/assistant/phoneRequests.js";
import { createConsolePushOps } from "../gateway/consolePushOps.js";
import { generateIdentity } from "../shared/crypto.js";
import { Address } from "../shared/session-id.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const HOLDER_KEY = generateIdentity().sign.pub;

describe("phone request append completion", () => {
	it("returns the Router stamp and carries the holder recipient", async () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-phone-outbox-"));
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
		const producer = generateIdentity();
		let appended: Record<string, unknown> | undefined;
		const push = createConsolePushOps({
			dataDir,
			ambient,
			ownerId: () => "owner",
			routerClient: {
				isConnected: () => true,
				isRegistered: () => true,
				callInboxTool: async (_tool, params) => {
					appended = params;
					return {
						result: {
							opKey: params.opKey,
							outcome: "accepted",
							result: { stamp: { holder: HOLDER_KEY } },
						},
					} as never;
				},
			},
			localGatewayId: "gateway",
			localDomainId: "domain",
			producerSignPriv: producer.sign.priv,
			ownerSignPub: () => producer.sign.pub,
			contentKeyStore: { seal: () => ({ kind: "ok", envelope: { epoch: 1 } }) } as never,
			localAddress: () => Address.of("domain", "gateway", "spawn", "session"),
			refuseImpersonation: () => null,
		});
		try {
			const queued = push.deliverToOwner({
				entry: {
					kind: "plugin_action",
					session_id: "assistant-owner",
					pluginId: "phone",
					actionType: "capability",
					payload: { requestId: "call-0001", key: "status", guard: "none" },
				},
				dedupeKey: "call-0001",
				volatile: true,
				recipient: { kind: "holder" },
				completion: true,
			});
			expect(queued).toMatchObject({ queued: true });
			if (queued === "migrating" || !queued.queued) throw new Error("phone row did not queue");

			expect(await queued.completion).toEqual({ kind: "accepted", stamp: { holder: HOLDER_KEY } });
			expect((appended?.row as { envelope?: { recipient?: unknown } } | undefined)?.envelope?.recipient).toEqual({
				kind: "holder",
			});
		} finally {
			push.stop();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("keeps the completion unsettled when Router blob staging is missing", async () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-phone-outbox-"));
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
		const producer = generateIdentity();
		let reachedRouter: () => void = () => undefined;
		const atRouter = new Promise<void>((resolve) => {
			reachedRouter = resolve;
		});
		const push = createConsolePushOps({
			dataDir,
			ambient,
			ownerId: () => "owner",
			routerClient: {
				isConnected: () => true,
				isRegistered: () => true,
				callInboxTool: async (_tool, params) => {
					reachedRouter();
					return {
						result: { opKey: params.opKey, outcome: "refused", reason: "blob_missing" },
					} as never;
				},
			},
			localGatewayId: "gateway",
			localDomainId: "domain",
			producerSignPriv: producer.sign.priv,
			ownerSignPub: () => producer.sign.pub,
			contentKeyStore: { seal: () => ({ kind: "ok", envelope: { epoch: 1 } }) } as never,
			localAddress: () => Address.of("domain", "gateway", "spawn", "session"),
			refuseImpersonation: () => null,
		});
		try {
			const queued = push.deliverToOwner({
				entry: {
					kind: "plugin_action",
					session_id: "assistant-owner",
					pluginId: "phone",
					actionType: "capability",
					payload: { requestId: "call-0002", key: "status", guard: "none" },
				},
				dedupeKey: "call-0002",
				volatile: true,
				recipient: { kind: "holder" },
				completion: true,
			});
			if (queued === "migrating" || !queued.queued) throw new Error("phone row did not queue");
			await atRouter;
			await new Promise((resolve) => setTimeout(resolve, 0));
			const pending = Symbol("pending");

			expect(await Promise.race([queued.completion, Promise.resolve(pending)])).toBe(pending);
			expect(JSON.parse(fs.readFileSync(path.join(dataDir, "owner-row-outbox.json"), "utf8"))).toHaveLength(1);
		} finally {
			push.stop();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("settles no holder as unavailable and retracts the row", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
		const retracted: string[] = [];
		const requests = createPhoneRequests({
			ambient,
			deliver: () => ({
				queued: true,
				completion: Promise.resolve({ kind: "refused", reason: "no_holder" }),
			}),
			retract: (request) => {
				retracted.push(request.requestId);
				return true;
			},
		});
		const opened = requests.open({ callId: "call-0001", key: "status", params: {}, guard: "none" });
		if (opened.kind !== "opened") throw new Error(`request did not open: ${opened.reason}`);

		expect(await opened.answer).toEqual({ kind: "unavailable", reason: "no_holder" });
		expect(retracted).toEqual(["call-0001"]);
	});

	it("answers a capability unavailable when the Router reports no holder", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
		const requests = createPhoneRequests({
			ambient,
			deliver: () => ({
				queued: true,
				completion: Promise.resolve({ kind: "refused", reason: "no_holder" }),
			}),
			retract: () => true,
		});
		const records: ActionRecord[] = [];
		const dispatch = createPhoneDispatch({
			ambient,
			approveEverySend: () => true,
			hold: () => ({ kind: "held", holder: "phone-a", label: "Pixel", claimedAt: 1_000, remainingMs: 1_000 }),
			phone: requests,
			act: { run: async () => ({ kind: "refused", reason: "unused" }) } as never,
			gateways: {} as never,
			record: (_callId, record) => {
				records.push(record);
				return true;
			},
		});

		expect(await dispatch({ key: "status", callId: "call-0002", params: {} })).toEqual({
			kind: "unavailable",
			reason: "no_holder",
		});
		expect(records[0]?.threads).toEqual([{ threadId: "status", outcome: "unavailable" }]);
	});

	it("refuses a lapsed hold with the gate's text and opens nothing", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
		let opened = 0;
		const dispatch = createPhoneDispatch({
			ambient,
			approveEverySend: () => true,
			hold: () => ({ kind: "lapsed", holder: "phone-a", label: "Pixel 10 Pro XL", lapsedMs: 120_000 }),
			phone: {
				open: () => {
					opened += 1;
					throw new Error("opened without a hold");
				},
			} as never,
			act: { run: async () => ({ kind: "refused", reason: "unused" }) } as never,
			gateways: {} as never,
			record: () => true,
		});

		const result = await dispatch({ key: "torch", callId: "call-lapsed1", params: { on: true } });
		expect(result).toMatchObject({ kind: "unavailable", reason: "no_holder" });
		expect((result as { detail?: string }).detail).toContain("lapsed 2 minutes ago");
		expect((result as { detail?: string }).detail).toContain("your Pixel 10 Pro XL");
		expect(opened).toBe(0);
	});

	it("appends one row per attempt with the call id as the request", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
		const delivered: string[] = [];
		const attempt = () =>
			createPhoneRequests({
				ambient,
				deliver: (request) => {
					delivered.push(request.requestId);
					return {
						queued: true,
						completion: Promise.resolve({ kind: "accepted", stamp: { holder: "phone-a" } }),
					};
				},
				retract: () => true,
			}).open({ callId: "call-restart", key: "status", params: {}, guard: "none" });

		expect(attempt().kind).toBe("opened");
		expect(attempt().kind).toBe("opened");
		expect(delivered).toEqual(["call-restart", "call-restart"]);
	});

	it("runs an approved card and refuses a denied card", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
		const cards: Array<{ requestId: string; key: string; label: string; summary: string }> = [];
		const retracted: string[] = [];
		const calls: Array<{ callId: string; key: string; params: unknown; guard: string }> = [];
		const guard = createActGuard({
			ambient,
			deliver: (request) => {
				cards.push(request);
				return true;
			},
			retract: (requestId) => {
				retracted.push(requestId);
				return true;
			},
			runPhone: async (input) => {
				calls.push(input as (typeof calls)[number]);
				return { kind: "ok", answer: { on: true, levels: 5 } };
			},
		});

		const approved = guard.run({ callId: "act-00001", key: "torch", params: { on: true } });
		expect(cards[0]).toMatchObject({
			requestId: "act-00001",
			key: "torch",
			label: "Torch",
			summary: 'Torch: {"on":true}',
		});
		expect(guard.answer("act-00001", "approve")).toEqual({ ok: true });
		expect(await approved).toEqual({ kind: "ok", answer: { on: true, levels: 5 } });
		expect(calls).toEqual([{ callId: "act-00001", key: "torch", params: { on: true }, guard: "approved" }]);

		const denied = guard.run({ callId: "act-00002", key: "torch", params: { on: false } });
		expect(guard.answer("act-00002", "deny", "owner said no")).toEqual({ ok: true });
		expect(await denied).toEqual({ kind: "refused", reason: "owner said no" });
		expect(retracted).toEqual(["act-00001", "act-00002"]);
	});
});
