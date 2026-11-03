import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createActGuard } from "../gateway/assistant/actGuard.js";
import { approvedDeviceRun, createDeviceDispatch } from "../gateway/assistant/deviceDispatch.js";
import { createPhoneDispatch } from "../gateway/assistant/phoneDispatch.js";
import { createPhoneRequests } from "../gateway/assistant/phoneRequests.js";
import { composeDevices } from "../gateway/compose/composeDevices.js";
import { createConsolePushOps } from "../gateway/consolePushOps.js";
import { createKasaTransport } from "../gateway/devices/kasa/transport.js";
import { generateIdentity } from "../shared/crypto.js";
import type { DeviceToolOp } from "../shared/schemasDeviceTool.js";
import { HolderKeySchema } from "../shared/schemasPhoneHold.js";
import { Address } from "../shared/session-id.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";
import { createFakeKasaPlug } from "../testing/fakeKasaPlug.js";

const HOLDER_KEY = HolderKeySchema.parse(generateIdentity().sign.pub);

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

	it.each([
		{
			name: "phone answer",
			raw: { kind: "invalid" },
			reason: "the phone answer did not parse",
		},
		{
			name: "capability answer",
			raw: { kind: "ok", answer: {} },
			reason: "the capability answer did not match its schema",
		},
	])("settles an invalid stamped $name as refused", async ({ raw, reason }) => {
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
		const requests = createPhoneRequests({
			ambient,
			deliver: () => ({
				queued: true,
				completion: Promise.resolve({ kind: "accepted", stamp: { holder: HOLDER_KEY } }),
			}),
			retract: () => true,
		});
		const opened = requests.open({ callId: "call-invalid", key: "status", params: {}, guard: "none" });
		if (opened.kind !== "opened") throw new Error(`request did not open: ${opened.reason}`);

		expect(await requests.answer("call-invalid", raw, HOLDER_KEY)).toEqual({ ok: false, reason });
		const pending = Symbol("pending");
		expect(await Promise.race([opened.answer, Promise.resolve(pending)])).toEqual({ kind: "refused", reason });
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
		const dispatch = createPhoneDispatch({
			ambient,
			approveEverySend: () => true,
			hold: () => ({ kind: "held", holder: "phone-a", label: "Pixel", claimedAt: 1_000, remainingMs: 1_000 }),
			phone: requests,
			act: { run: async () => ({ kind: "refused", reason: "unused" }) } as never,
			gateways: {} as never,
		});

		expect(await dispatch({ key: "status", callId: "call-0002", params: {} })).toEqual({
			kind: "unavailable",
			reason: "no_holder",
		});
	});

	it("opens a text draft without a card and sends only through an approval card", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
		const cards: Array<{ requestId: string; key: string; label: string; summary: string }> = [];
		const opened: Array<{ callId: string; key: string; params: unknown; guard: string }> = [];
		const guard = createActGuard({
			ambient,
			deliver: (request) => {
				cards.push(request);
				return true;
			},
			retract: () => true,
			runPhone: async () => ({ kind: "ok", answer: { sent: true, parts: 1 } }),
			runDevice: async () => ({ kind: "refused", reason: "unused" }),
		});
		const dispatch = createPhoneDispatch({
			ambient,
			approveEverySend: () => true,
			hold: () => ({ kind: "held", holder: "phone-a", label: "Pixel", claimedAt: 1_000, remainingMs: 1_000 }),
			phone: {
				open: (input: (typeof opened)[number]) => {
					opened.push(input);
					return {
						kind: "opened",
						answer: Promise.resolve({ kind: "ok", answer: { sent: false, parts: 0 } }),
					};
				},
			} as never,
			act: guard,
			gateways: {} as never,
		});

		const draft = await dispatch({
			key: "sms",
			callId: "sms-draft-01",
			params: { to: "+15551234567", body: "Hello" },
		});
		expect(draft).toMatchObject({ kind: "ok", answer: { sent: false, parts: 0 } });
		expect(opened).toMatchObject([{ key: "sms", guard: "none" }]);
		expect(cards).toHaveLength(0);

		const sending = dispatch({
			key: "sms",
			callId: "sms-send-001",
			params: { to: "+15551234567", body: "Hello", send: true },
		});
		expect(opened).toHaveLength(1);
		expect(cards).toMatchObject([{ requestId: "sms-send-001", key: "sms", label: "Text" }]);
		expect(guard.answer("sms-send-001", "approve")).toEqual({ ok: true });
		expect(await sending).toMatchObject({ kind: "ok", answer: { sent: true, parts: 1 } });
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
						completion: Promise.resolve({ kind: "accepted", stamp: { holder: HOLDER_KEY } }),
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
			runDevice: async () => ({ kind: "refused", reason: "unused" }),
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

describe("Gateway device ops", () => {
	it("lists live devices, hides a plug's text and address, and holds a danger act on the owner's card", async () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-device-ops-"));
		const ambient = fakeAmbient({ now: () => 1_000 });
		const MAC = "aa:bb:cc:dd:ee:ff";
		let refuseRelay = false;
		const plug = await createFakeKasaPlug({
			mac: MAC,
			behavior: (request) =>
				request.command === "set_relay_state" && refuseRelay
					? { kind: "error", command: "set_relay_state", code: -17, message: "private plug text" }
					: undefined,
		});
		const devices = composeDevices({
			dataDir,
			ambient,
			transport: createKasaTransport(plug.port),
			relayToHost: async () => ({ ok: false, error: "unused" }),
		});
		const cards: Array<{ requestId: string; key: string; label: string; summary: string }> = [];
		const guard = createActGuard({
			ambient,
			deliver: (request) => {
				cards.push(request);
				return true;
			},
			retract: () => true,
			runPhone: async () => ({ kind: "refused", reason: "unused" }),
			runDevice: approvedDeviceRun(devices),
		});
		const dispatch = createDeviceDispatch({ ambient, devices, act: guard });
		const run = (device: DeviceToolOp, callId: string) => dispatch({ device, callId });
		const unbinds = () => plug.received().filter((row) => row.command === "unbind").length;

		try {
			expect(
				await devices.console({ kind: "device_add", mac: MAC, address: "127.0.0.1", name: "Lamp" }),
			).toMatchObject({ kind: "ok" });
			expect(await run({ kind: "device_list" }, "device-list-0001")).toMatchObject({
				kind: "ok",
				answer: {
					kind: "ok",
					devices: [
						{
							id: MAC,
							name: "Lamp",
							kind: "switch",
							driver: "kasa",
							state: "off",
							capabilities: expect.arrayContaining(["switch", "cloud"]),
						},
					],
				},
			});
			expect(await run({ kind: "device_set", id: MAC, verb: "on" }, "device-set-000001")).toMatchObject({
				kind: "ok",
				answer: { kind: "ok", state: { state: "on" } },
			});

			refuseRelay = true;
			const refused = await run({ kind: "device_set", id: MAC, verb: "off" }, "device-error-0001");
			expect(refused).toMatchObject({
				kind: "ok",
				answer: {
					kind: "refused",
					refusal: { code: "device_error", detail: "the device answered err_code -17" },
				},
			});
			expect(JSON.stringify(refused)).not.toContain("private plug text");
			expect(JSON.stringify(refused)).not.toContain("127.0.0.1");

			const disconnect: DeviceToolOp = {
				kind: "device_setting_put",
				id: MAC,
				revision: devices.record(MAC)?.revision ?? 0,
				setting: { driver: "kasa", setting: { key: "cloud", value: "disconnected" } },
			};
			expect(await devices.assistant(disconnect)).toMatchObject({
				kind: "refused",
				refusal: { code: "invalid" },
			});
			expect(unbinds()).toBe(0);

			const read = await run({ kind: "device_read", id: MAC }, "device-read-00001");
			expect(read).toMatchObject({ kind: "ok", answer: { kind: "ok", settings: { driver: "kasa" } } });
			const renamed = await run(
				{ kind: "device_rename", id: MAC, name: "Hall lamp", revision: devices.record(MAC)?.revision ?? 0 },
				"device-rename-001",
			);
			expect(renamed).toMatchObject({ kind: "ok", answer: { kind: "ok", record: { name: "Hall lamp" } } });
			const schedule = { enabled: true, rules: [] };
			const put = await run(
				{
					kind: "device_schedule_put",
					id: MAC,
					revision: devices.record(MAC)?.revision ?? 0,
					base: schedule,
					schedule,
				},
				"device-schedule-01",
			);
			expect(put).toMatchObject({ kind: "ok", answer: { kind: "ok", schedule } });
			for (const answer of [read, renamed, put]) expect(JSON.stringify(answer)).not.toContain("127.0.0.1");
			disconnect.revision = devices.record(MAC)?.revision ?? 0;

			const pending = run(disconnect, "device-danger-0001");
			await vi.waitFor(() => expect(cards).toHaveLength(1));
			expect(cards[0]).toMatchObject({
				requestId: "device-danger-0001",
				key: "device/device_setting_put",
				label: "Disconnect from the cloud",
				summary: expect.stringMatching(/^Disconnect from the cloud: Hall lamp\. The Kasa app/),
			});
			expect(unbinds()).toBe(0);
			expect(guard.answer("device-danger-0001", "approve")).toEqual({ ok: true });
			expect(await pending).toMatchObject({
				kind: "ok",
				answer: { kind: "ok", settings: { driver: "kasa", cloud: "disconnected" } },
			});
			expect(unbinds()).toBe(1);

			const denied = run(disconnect, "device-danger-0002");
			await vi.waitFor(() => expect(cards).toHaveLength(2));
			expect(guard.answer("device-danger-0002", "deny", "keep the cloud")).toEqual({ ok: true });
			expect(await denied).toEqual({ kind: "refused", reason: "keep the cloud" });
			expect(unbinds()).toBe(1);
		} finally {
			await devices.close();
			await plug.close();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
