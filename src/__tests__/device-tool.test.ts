import { describe, expect, it } from "vitest";
import { z } from "zod";
import { approvedDeviceRun, createDeviceDispatch, type DeviceSurface } from "../gateway/assistant/deviceDispatch.js";
import { deviceText } from "../mcp/assistant/deviceTool.js";
import { DEVICE_CONSOLE_OP_KINDS, DEVICE_CONSOLE_REQUESTS, type DeviceRecord } from "../shared/schemasDevices.js";
import {
	DEVICE_TOOL_OFFERS,
	DEVICE_TOOL_OP_KINDS,
	DEVICE_TOOL_REQUESTS,
	type DeviceToolOp,
	DeviceToolOpSchema,
	dangerActOf,
} from "../shared/schemasDeviceTool.js";
import { INTEGRATIONS } from "../shared/schemasIntegrations.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const LAMP: DeviceRecord = {
	id: "aa:bb:cc:dd:ee:ff",
	name: "Lamp",
	kind: "switch",
	driver: "kasa",
	address: "10.0.0.1",
	revision: 3,
};

const disconnect: DeviceToolOp = {
	kind: "device_setting_put",
	id: LAMP.id,
	revision: 3,
	setting: { driver: "kasa", setting: { key: "cloud", value: "disconnected" } },
};

function fakeSurface(record: DeviceRecord | null = LAMP) {
	const ops: DeviceToolOp[] = [];
	const surface: DeviceSurface = {
		assistant: (async (op: DeviceToolOp) => {
			ops.push(op);
			return { kind: "ok", state: { state: "on", readAt: 1 } };
		}) as DeviceSurface["assistant"],
		record: () => record,
	};
	return { surface, ops };
}

describe("the device tool's schema", () => {
	it("is the console's own request objects for the offered kinds, rendered as one JSON Schema", () => {
		const offered = DEVICE_CONSOLE_REQUESTS.filter((request) => DEVICE_TOOL_OFFERS[request.shape.kind.value]);
		expect(DEVICE_TOOL_REQUESTS.length).toBe(offered.length);
		for (const [at, request] of offered.entries()) expect(DEVICE_TOOL_REQUESTS[at]).toBe(request);

		expect(DeviceToolOpSchema.safeParse({ kind: "device_list" }).success).toBe(true);
		expect(DeviceToolOpSchema.safeParse({ kind: "device_scan" }).success).toBe(false);
		expect(DeviceToolOpSchema.safeParse({ kind: "device_set", id: "Lamp", verb: "on" }).success).toBe(false);

		const rendered = JSON.stringify(z.toJSONSchema(z.object({ op: DeviceToolOpSchema }), { io: "input" }));
		for (const kind of DEVICE_TOOL_OP_KINDS) expect(rendered).toContain(`"${kind}"`);
		for (const kind of DEVICE_CONSOLE_OP_KINDS.filter((kind) => !DEVICE_TOOL_OFFERS[kind]))
			expect(rendered).not.toContain(`"${kind}"`);
	});

	it("finds the catalogue's danger act by the put it sends", () => {
		expect(dangerActOf(disconnect, "kasa")).toBe(INTEGRATIONS.kasa.acts[0]);
		expect(dangerActOf(disconnect, undefined)).toBeNull();
		expect(
			dangerActOf({ ...disconnect, setting: { driver: "kasa", setting: { key: "led", value: false } } }, "kasa"),
		).toBeNull();
		expect(dangerActOf({ kind: "device_set", id: LAMP.id, verb: "on" }, "kasa")).toBeNull();
	});
});

describe("the device dispatch", () => {
	it("refuses an op that does not parse, answers not_supported without a stage, and joins a retry", async () => {
		const ambient = fakeAmbient({ now: () => 1_000 });
		const { surface, ops } = fakeSurface();
		const act = { runDevice: async () => ({ kind: "refused" as const, reason: "unused" }) };
		const dispatch = createDeviceDispatch({ ambient, devices: surface, act });
		const none = createDeviceDispatch({ ambient, devices: null, act });

		expect(
			await dispatch({ device: { kind: "device_set", id: "Lamp", verb: "on" }, callId: "device-bad-0001" }),
		).toMatchObject({
			kind: "refused",
			reason: expect.stringContaining("id"),
		});
		expect(await none({ device: { kind: "device_list" }, callId: "device-none-001" })).toEqual({
			kind: "unavailable",
			reason: "not_supported",
		});
		const request = { device: { kind: "device_set", id: LAMP.id, verb: "on" }, callId: "device-set-00001" };
		const [first, second] = await Promise.all([dispatch(request), dispatch(request)]);
		expect(first).toEqual({ kind: "ok", answer: { kind: "ok", state: { state: "on", readAt: 1 } } });
		expect(second).toEqual(first);
		expect(ops).toHaveLength(1);
	});

	it("holds a danger act on one owner's card, with its consent words, and runs it only once approved", async () => {
		const ambient = fakeAmbient({ now: () => 1_000 });
		const { surface, ops } = fakeSurface();
		const cards: unknown[] = [];
		const approved = approvedDeviceRun(surface);
		const act = {
			runDevice: async (input: { callId: string; kind: string; op: unknown; label: string; summary: string }) => {
				cards.push({ kind: input.kind, label: input.label, summary: input.summary });
				return approved(input.callId, input.op);
			},
		};
		const dispatch = createDeviceDispatch({ ambient, devices: surface, act });
		const request = { device: disconnect, callId: "device-danger-001" };

		const [answer, retried] = await Promise.all([dispatch(request), dispatch(request)]);

		expect(cards).toEqual([
			{
				kind: "device_setting_put",
				label: "Disconnect from the cloud",
				summary: `Disconnect from the cloud: Lamp. ${INTEGRATIONS.kasa.acts[0].confirm}`,
			},
		]);
		expect(retried).toEqual(answer);
		expect(ops).toEqual([disconnect]);
		expect(answer).toMatchObject({ kind: "ok", answer: { kind: "ok" } });
		expect(await approved("device-danger-002", { kind: "device_scan" })).toMatchObject({ kind: "refused" });
		expect(await approvedDeviceRun(null)("device-danger-003", disconnect)).toEqual({
			kind: "unavailable",
			reason: "not_supported",
		});
	});
});

describe("the device tool's text", () => {
	it("is an error for a refusal at either level, and JSON otherwise", () => {
		const op: DeviceToolOp = { kind: "device_set", id: LAMP.id, verb: "on" };
		const ok = deviceText(op, { kind: "ok", answer: { kind: "ok", state: { state: "on", readAt: 1 } } });
		const refused = deviceText(op, {
			kind: "ok",
			answer: { kind: "refused", refusal: { code: "toggle_unknown", effect: "none" } },
		});
		const unreadable = deviceText(op, { kind: "ok", answer: { kind: "ok" } });
		const unavailable = deviceText(op, { kind: "unavailable", reason: "timeout" });

		expect(ok.isError).toBeUndefined();
		expect(ok.content[0]?.text).toContain('"state":"on"');
		expect(refused.isError).toBe(true);
		expect(refused.content[0]?.text).toContain("toggle_unknown");
		expect(unreadable.isError).toBe(true);
		expect(unavailable.isError).toBe(true);
	});

	it("formats Celsius sensor readings in the owner's unit", () => {
		const answer = deviceText(
			{ kind: "device_read", id: "aa:bb:cc:dd:ee:ff" },
			{
				kind: "ok",
				answer: {
					kind: "sensor",
					model: "H5110",
					temperatureUnit: "F",
					readings: [
						{
							spec: {
								kind: "number",
								field: "temperature",
								label: "Temperature",
								unit: "C",
								decimals: 1,
							},
							alerts: ["low", "high"],
							value: 24.4,
							low: { value: -5.3, at: 1 },
						},
						{
							spec: { kind: "number", field: "humidity", label: "Humidity", unit: "%", decimals: 1 },
							alerts: ["low"],
							value: 42.4,
						},
					],
					thresholds: [
						{ measure: "temperature", high: 30, deadZone: 1, coolDownSec: 0, revision: 1 },
						{ measure: "humidity", low: 30, deadZone: 1, coolDownSec: 0, revision: 1 },
					],
				},
			},
		);

		expect(answer.content[0]?.text).toContain('"unit":"F"');
		expect(answer.content[0]?.text).toContain('"value":"75.9 °F"');
		expect(answer.content[0]?.text).toContain('"value":"22.5 °F"');
		expect(answer.content[0]?.text).toContain('"high":86');
		expect(answer.content[0]?.text).toContain('"deadZone":1.8');
		expect(answer.content[0]?.text).not.toContain("temperatureUnit");
		expect(JSON.parse(answer.content[0]?.text ?? "{}").thresholds).toEqual([
			{ measure: "temperature", high: 86, deadZone: 1.8, coolDownSec: 0, revision: 1 },
			{ measure: "humidity", low: 30, deadZone: 1, coolDownSec: 0, revision: 1 },
		]);
	});
});
