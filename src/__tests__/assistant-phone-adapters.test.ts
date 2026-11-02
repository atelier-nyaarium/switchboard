import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createActGuard } from "../gateway/assistant/actGuard.js";
import { GatewayCapabilityRefusal, GatewayCapabilityRejected } from "../gateway/assistant/gatewayCapabilityRefusal.js";
import { createPhoneDispatch } from "../gateway/assistant/phoneDispatch.js";
import { createPhoneRequests } from "../gateway/assistant/phoneRequests.js";
import { composeDevices } from "../gateway/compose/composeDevices.js";
import { createConsolePushOps } from "../gateway/consolePushOps.js";
import type { KasaTransport } from "../gateway/devices/kasa/transport.js";
import { generateIdentity } from "../shared/crypto.js";
import type { GatewayCapabilityRuns } from "../shared/schemasPhoneCapabilities.js";
import { HolderKeySchema } from "../shared/schemasPhoneHold.js";
import { Address } from "../shared/session-id.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

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

describe("Gateway device actions", () => {
	it("lists live devices and resolves ids or exact names", async () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-device-actions-"));
		const macs = new Map([
			["127.0.0.2", "aa:bb:cc:dd:ee:ff"],
			["127.0.0.3", "aa:bb:cc:dd:ee:ee"],
		]);
		const states = new Map<string, 0 | 1>();
		const requests: string[] = [];
		let refuseRelay = false;
		const transport: KasaTransport = {
			request: async (address, command) => {
				requests.push(address);
				const modules = command as Record<string, Record<string, Record<string, unknown>>>;
				const [module] = Object.keys(modules);
				const commands = modules[module ?? ""];
				const [name] = Object.keys(commands ?? {});
				const args = commands?.[name ?? ""] ?? {};
				if (module === "system" && name === "get_sysinfo") {
					return {
						system: {
							get_sysinfo: {
								err_code: 0,
								mac: macs.get(address),
								relay_state: states.get(address) ?? 0,
								led_off: 0,
							},
						},
					};
				}
				if (module === "system" && name === "set_relay_state") {
					if (refuseRelay) {
						return { system: { set_relay_state: { err_code: -17, err_msg: "private plug text" } } };
					}
					states.set(address, args.state === 1 ? 1 : 0);
					return { system: { set_relay_state: { err_code: 0 } } };
				}
				if (module === "schedule" && name === "get_rules") {
					return { schedule: { get_rules: { err_code: 0, rule_list: [], enable: 1 } } };
				}
				return { [module ?? ""]: { [name ?? ""]: { err_code: 0 } } };
			},
		};
		const devices = composeDevices({
			dataDir,
			ambient: fakeAmbient({ now: () => 1_000 }),
			transport,
			relayToHost: async () => ({ ok: false, error: "unused" }),
		});
		const runs: GatewayCapabilityRuns = {
			ifttt_trigger: async () => ({ status: 200, ok: true }),
			devices: async () => {
				const result = await devices.listDevices();
				if (result.kind === "ok") return result.answer;
				throw new GatewayCapabilityRefusal(result.reason, result.detail);
			},
			device_set: async ({ target, verb }) => {
				const result = await devices.setDevice(target, verb);
				if (result.kind === "ok") return result.answer;
				if (result.kind === "unavailable") throw new GatewayCapabilityRefusal(result.reason, result.detail);
				throw new GatewayCapabilityRejected(result.reason);
			},
		};
		const dispatch = createPhoneDispatch({
			ambient: fakeAmbient({ now: () => 1_000 }),
			approveEverySend: () => true,
			hold: () => ({ kind: "none" }),
			phone: { open: () => ({ kind: "refused" }) } as never,
			act: { run: async () => ({ kind: "refused", reason: "unused" }) } as never,
			gateways: runs,
		});

		try {
			expect(
				await devices.console.add({
					mac: "aa:bb:cc:dd:ee:ff",
					address: "127.0.0.2",
					name: "Lamp",
				}),
			).toMatchObject({ stored: true });
			const listed = await dispatch({ key: "devices", callId: "device-list-0001", params: {} });
			expect(listed).toMatchObject({
				kind: "ok",
				answer: { devices: [{ id: "aa:bb:cc:dd:ee:ff", name: "Lamp", kind: "switch", state: "off" }] },
			});

			const byName = await dispatch({
				key: "device_set",
				callId: "device-name-0001",
				params: { target: "lAmP", verb: "on" },
			});
			expect(byName).toEqual({ kind: "ok", answer: { id: "aa:bb:cc:dd:ee:ff", state: "on" } });

			const byId = await dispatch({
				key: "device_set",
				callId: "device-id-000001",
				params: { target: "aa:bb:cc:dd:ee:ff", verb: "off" },
			});
			expect(byId).toEqual({ kind: "ok", answer: { id: "aa:bb:cc:dd:ee:ff", state: "off" } });

			expect(
				await devices.console.add({
					mac: "aa:bb:cc:dd:ee:ee",
					address: "127.0.0.3",
					name: "Lamp",
				}),
			).toMatchObject({ stored: true });
			const beforeRefusals = requests.length;
			const ambiguous = await dispatch({
				key: "device_set",
				callId: "device-ambiguous-01",
				params: { target: "Lamp", verb: "on" },
			});
			expect(ambiguous).toMatchObject({ kind: "refused" });
			expect((ambiguous as { reason: string }).reason).toContain("aa:bb:cc:dd:ee:ff");
			expect((ambiguous as { reason: string }).reason).toContain("aa:bb:cc:dd:ee:ee");

			const unknown = await dispatch({
				key: "device_set",
				callId: "device-unknown-001",
				params: { target: "Missing", verb: "on" },
			});
			expect(unknown).toMatchObject({ kind: "refused" });
			expect((unknown as { reason: string }).reason).toContain("Lamp");
			expect(requests.length).toBe(beforeRefusals);

			const secondById = await dispatch({
				key: "device_set",
				callId: "device-id-000002",
				params: { target: "aa:bb:cc:dd:ee:ee", verb: "on" },
			});
			expect(secondById).toEqual({ kind: "ok", answer: { id: "aa:bb:cc:dd:ee:ee", state: "on" } });

			refuseRelay = true;
			const refused = await dispatch({
				key: "device_set",
				callId: "device-error-0001",
				params: { target: "aa:bb:cc:dd:ee:ff", verb: "on" },
			});
			expect(refused).toEqual({ kind: "refused", reason: "the device answered err_code -17" });
			expect(JSON.stringify(refused)).not.toContain("private plug text");
		} finally {
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
