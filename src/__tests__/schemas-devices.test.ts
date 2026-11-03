import { describe, expect, it } from "vitest";
import { ConsoleOpSchema } from "../shared/schemasConsoleOp.js";
import {
	DEVICE_MAX_RULES,
	DeviceAddressSchema,
	DeviceIdSchema,
	DeviceNameSchema,
	DeviceScheduleSchema,
	DeviceSettingsSchema,
	deviceNameRefusal,
	normalizeDeviceMac,
} from "../shared/schemasDevices.js";

const id = "aa:bb:cc:dd:ee:ff";
const schedule = {
	enabled: true,
	rules: [
		{
			days: [true, true, true, true, true, true, true],
			time: "07:30",
			action: "on",
			enabled: true,
		},
	],
};

describe("device schemas", () => {
	it("normalizes MAC spellings and only accepts canonical ids", () => {
		expect(normalizeDeviceMac("AA-BB-CC-DD-EE-FF")).toBe(id);
		expect(normalizeDeviceMac("AABBCCDDEEFF")).toBe(id);
		expect(normalizeDeviceMac("aa:bb:cc:dd:ee:ff")).toBe(id);
		expect(normalizeDeviceMac("aa:bb:cc:dd:ee")).toBeNull();
		expect(DeviceIdSchema.safeParse(id).success).toBe(true);
		expect(DeviceIdSchema.safeParse("AA:BB:CC:DD:EE:FF").success).toBe(false);
		expect(DeviceIdSchema.safeParse("aa-bb-cc-dd-ee-ff").success).toBe(false);
		expect(DeviceNameSchema.safeParse("AA-BB-CC-DD-EE-FF").success).toBe(false);
		expect(DeviceNameSchema.safeParse("   ").success).toBe(false);
		expect(deviceNameRefusal("   ")).toBe("device name cannot be blank");
		expect(DeviceNameSchema.safeParse("Desk lamp").success).toBe(true);
		expect(DeviceAddressSchema.safeParse("192.168.1.10").success).toBe(true);
		expect(DeviceAddressSchema.safeParse("010.0.0.1").success).toBe(false);
	});

	it("bounds schedules and validates driver settings", () => {
		expect(DeviceScheduleSchema.safeParse(schedule).success).toBe(true);
		expect(
			DeviceScheduleSchema.safeParse({
				enabled: true,
				rules: Array.from({ length: DEVICE_MAX_RULES + 1 }, () => schedule.rules[0]),
			}).success,
		).toBe(false);
		expect(
			DeviceScheduleSchema.safeParse({
				enabled: true,
				rules: [{ ...schedule.rules[0], days: [true, false] }],
			}).success,
		).toBe(false);
		expect(
			DeviceSettingsSchema.safeParse({
				driver: "kasa",
				led: false,
				clock: { time: "2026-11-02T12:30:00Z", zone: "America/Los_Angeles" },
				cloud: "disconnected",
			}).success,
		).toBe(true);
		expect(
			DeviceSettingsSchema.safeParse({
				driver: "kasa",
				led: "off",
				clock: { time: "not a date", zone: "" },
				cloud: "connected",
			}).success,
		).toBe(false);
	});

	it("parses each device console operation", () => {
		const ops = [
			{ kind: "device_list" },
			{ kind: "device_read", id },
			{ kind: "device_scan" },
			{ kind: "device_add", mac: id, address: "192.168.1.10", name: "Lamp" },
			{ kind: "device_rename", id, name: "Desk lamp", revision: 1 },
			{ kind: "device_remove", id, revision: 1 },
			{ kind: "device_set", id, verb: "toggle" },
			{ kind: "device_schedule_put", id, revision: 1, base: schedule, schedule },
			{
				kind: "device_setting_put",
				id,
				revision: 1,
				setting: { driver: "kasa", setting: { key: "led", value: false } },
			},
		];
		for (const op of ops) expect(ConsoleOpSchema.safeParse(op).success).toBe(true);
	});
});
