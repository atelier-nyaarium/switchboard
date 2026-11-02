import { z } from "zod";
import { REVISION_CEILING } from "./schemasRunbook.js";

export const DEVICE_KINDS = ["switch"] as const;
export const DEVICE_DRIVERS = ["kasa"] as const;
export const DEVICE_STATES = ["on", "off", "unknown", "unreachable"] as const;
export const DEVICE_ACTIONS = ["on", "off"] as const;
export const DEVICE_VERBS = ["on", "off", "toggle"] as const;
export const DEVICE_CLOUD_STATES = ["bound", "disconnected"] as const;
export const KASA_SETTING_KEYS = ["led", "cloud"] as const;
export const DEVICE_SCAN_REFUSALS = ["daemon_away", "timeout", "refused"] as const;
/** Gateway device op answers. */
export const DEVICE_OPERATION_REASONS = ["unreachable", "timeout", "refused", "not_supported"] as const;
export const DEVICE_CONSOLE_OP_KINDS = [
	"device_list",
	"device_read",
	"device_scan",
	"device_add",
	"device_rename",
	"device_remove",
	"device_set",
	"device_schedule_put",
	"device_setting_put",
] as const;
export const DEVICE_MAX_RULES = 32;
export const DEVICE_MAX_RECORDS = 64;

export type DeviceConsoleOpKind = (typeof DEVICE_CONSOLE_OP_KINDS)[number];

export const DeviceKindSchema = z.enum(DEVICE_KINDS).meta({ id: "DeviceKind" });
export const DeviceDriverSchema = z.enum(DEVICE_DRIVERS).meta({ id: "DeviceDriver" });
export const DeviceStateSchema = z.enum(DEVICE_STATES).meta({ id: "DeviceState" });
export const DeviceScheduleActionSchema = z.enum(DEVICE_ACTIONS).meta({ id: "DeviceScheduleAction" });
export const DeviceVerbSchema = z.enum(DEVICE_VERBS).meta({ id: "DeviceVerb" });
export const DeviceCloudStateSchema = z.enum(DEVICE_CLOUD_STATES).meta({ id: "DeviceCloudState" });

export function normalizeDeviceMac(value: string): string | null {
	const compact = /^[0-9a-f]{12}$/i.test(value)
		? value
		: /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value) || /^(?:[0-9a-f]{2}-){5}[0-9a-f]{2}$/i.test(value)
			? value.replace(/[:-]/g, "")
			: null;
	if (compact === null) return null;
	return compact.toLowerCase().match(/.{2}/g)?.join(":") ?? null;
}

export const DeviceIdSchema = z
	.string()
	.refine((value) => normalizeDeviceMac(value) === value, "device id must be a lower-case colon MAC")
	.meta({ id: "DeviceId" });

function isIpv4Literal(value: string): boolean {
	const parts = value.split(".");
	return (
		parts.length === 4 &&
		parts.every((part) => /^\d{1,3}$/.test(part) && (part.length === 1 || part[0] !== "0") && Number(part) <= 255)
	);
}

export const DeviceAddressSchema = z
	.string()
	.refine(isIpv4Literal, "device address must be an IPv4 literal")
	.meta({ id: "DeviceAddress" });

/** The one name rule. */
export function deviceNameRefusal(name: string): string | null {
	if (name.trim().length === 0) return "device name cannot be blank";
	if (name.length > 64) return "device name is too long";
	if (normalizeDeviceMac(name) !== null) return "device name cannot be a MAC address";
	return null;
}

export const DeviceNameSchema = z
	.string()
	.min(1)
	.max(64)
	.superRefine((value, ctx) => {
		const reason = deviceNameRefusal(value);
		if (reason) ctx.addIssue({ code: "custom", message: reason });
	})
	.meta({ id: "DeviceName" });
export const DeviceRevisionSchema = z.number().int().positive().max(REVISION_CEILING).meta({ id: "DeviceRevision" });

export const DeviceRecordSchema = z
	.object({
		id: DeviceIdSchema,
		name: DeviceNameSchema,
		kind: DeviceKindSchema,
		driver: DeviceDriverSchema,
		address: DeviceAddressSchema,
		revision: DeviceRevisionSchema,
	})
	.meta({ id: "DeviceRecord" });

export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

export const DeviceLiveStateSchema = z
	.object({
		state: DeviceStateSchema,
		readAt: z.number().int().nonnegative(),
	})
	.meta({ id: "DeviceLiveState" });

export const DeviceScheduleRuleSchema = z
	.object({
		id: z.string().min(1).max(64).optional(),
		days: z.array(z.boolean()).length(7),
		time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
		action: DeviceScheduleActionSchema,
		enabled: z.boolean(),
	})
	.meta({ id: "DeviceScheduleRule" });

export const DeviceScheduleSchema = z
	.object({
		enabled: z.boolean(),
		rules: z.array(DeviceScheduleRuleSchema).max(DEVICE_MAX_RULES),
	})
	.refine((schedule) => {
		const ids = schedule.rules.flatMap((rule) => (rule.id === undefined ? [] : [rule.id]));
		return new Set(ids).size === ids.length;
	}, "a rule id names one rule")
	.meta({ id: "DeviceSchedule" });

export const KasaClockSchema = z
	.object({
		time: z.string().datetime({ offset: true }),
		zone: z.string().min(1).max(128),
	})
	.meta({ id: "KasaClock" });

export const KasaDeviceSettingsSchema = z
	.object({
		driver: z.literal("kasa"),
		led: z.boolean(),
		clock: KasaClockSchema,
		cloud: DeviceCloudStateSchema,
	})
	.meta({ id: "KasaDeviceSettings" });

export const DeviceSettingsSchema = z
	.discriminatedUnion("driver", [
		z.object({
			driver: KasaDeviceSettingsSchema.shape.driver,
			led: KasaDeviceSettingsSchema.shape.led,
			clock: KasaDeviceSettingsSchema.shape.clock,
			cloud: KasaDeviceSettingsSchema.shape.cloud,
		}),
	])
	.meta({ id: "DeviceSettings" });

export const KasaSettingPutSchema = z
	.discriminatedUnion("key", [
		z.object({ key: z.literal(KASA_SETTING_KEYS[0]), value: z.boolean() }),
		z.object({ key: z.literal(KASA_SETTING_KEYS[1]), value: DeviceCloudStateSchema }),
	])
	.meta({ id: "KasaSettingPut" });

export const DeviceSettingPutSchema = z
	.discriminatedUnion("driver", [z.object({ driver: z.literal("kasa"), setting: KasaSettingPutSchema })])
	.meta({ id: "DeviceSettingPut" });

export const DeviceCandidateSchema = z
	.object({
		mac: DeviceIdSchema,
		address: DeviceAddressSchema,
		alias: z.string().max(128),
		model: z.string().max(128),
		hardware: z.string().max(128),
		firmware: z.string().max(128),
	})
	.meta({ id: "DeviceCandidate" });

export const DeviceScanRefusalSchema = z.enum(DEVICE_SCAN_REFUSALS).meta({ id: "DeviceScanRefusal" });
export const DeviceOperationReasonSchema = z.enum(DEVICE_OPERATION_REASONS).meta({ id: "DeviceOperationReason" });

export const DeviceListRequestSchema = z.object({}).meta({ id: "DeviceListRequest" });
export const DeviceReadRequestSchema = z.object({ id: DeviceIdSchema }).meta({ id: "DeviceReadRequest" });
export const DeviceScanRequestSchema = z.object({}).meta({ id: "DeviceScanRequest" });
export const DeviceAddRequestSchema = z
	.object({ mac: DeviceIdSchema, address: DeviceAddressSchema, name: DeviceNameSchema })
	.meta({ id: "DeviceAddRequest" });
export const DeviceRenameRequestSchema = z
	.object({ id: DeviceIdSchema, name: DeviceNameSchema, revision: DeviceRevisionSchema })
	.meta({ id: "DeviceRenameRequest" });
export const DeviceRemoveRequestSchema = z
	.object({ id: DeviceIdSchema, revision: DeviceRevisionSchema })
	.meta({ id: "DeviceRemoveRequest" });
export const DeviceSetRequestSchema = z
	.object({ id: DeviceIdSchema, verb: DeviceVerbSchema })
	.meta({ id: "DeviceSetRequest" });
export const DeviceSchedulePutRequestSchema = z
	.object({ id: DeviceIdSchema, revision: DeviceRevisionSchema, schedule: DeviceScheduleSchema })
	.meta({ id: "DeviceSchedulePutRequest" });
export const DeviceSettingPutRequestSchema = z
	.object({ id: DeviceIdSchema, revision: DeviceRevisionSchema, setting: DeviceSettingPutSchema })
	.meta({ id: "DeviceSettingPutRequest" });

export const ConsoleDeviceListResultSchema = z
	.object({
		records: z.array(DeviceRecordSchema).max(DEVICE_MAX_RECORDS).optional(),
		revision: z.number().int().nonnegative().max(REVISION_CEILING).optional(),
		reason: DeviceOperationReasonSchema.optional(),
		detail: z.string().optional(),
	})
	.refine((result) => {
		const available =
			result.records !== undefined &&
			result.revision !== undefined &&
			result.reason === undefined &&
			result.detail === undefined;
		const unavailable =
			result.records === undefined && result.revision === undefined && result.reason !== undefined;
		return available || unavailable;
	})
	.meta({ id: "ConsoleDeviceListResult" });

export const ConsoleDeviceScanResultSchema = z
	.object({
		candidates: z.array(DeviceCandidateSchema).max(DEVICE_MAX_RECORDS).optional(),
		reason: DeviceScanRefusalSchema.optional(),
		detail: z.string().optional(),
	})
	.refine((result) => {
		const available = result.candidates !== undefined && result.reason === undefined && result.detail === undefined;
		const unavailable = result.candidates === undefined && result.reason !== undefined;
		return available || unavailable;
	})
	.meta({ id: "ConsoleDeviceScanResult" });

export const ConsoleDeviceAddResultSchema = z
	.object({
		stored: z.boolean(),
		record: DeviceRecordSchema.optional(),
		reason: z.string().optional(),
		detail: z.string().optional(),
	})
	.meta({ id: "ConsoleDeviceAddResult" });

export const ConsoleDeviceRenameResultSchema = z
	.object({
		stored: z.boolean(),
		record: DeviceRecordSchema.optional(),
		reason: z.string().optional(),
		detail: z.string().optional(),
	})
	.meta({ id: "ConsoleDeviceRenameResult" });

export const ConsoleDeviceRemoveResultSchema = z
	.object({
		deleted: z.boolean(),
		record: DeviceRecordSchema.optional(),
		reason: z.string().optional(),
		detail: z.string().optional(),
	})
	.meta({ id: "ConsoleDeviceRemoveResult" });

export const ConsoleDeviceReadResultSchema = z
	.object({
		state: DeviceLiveStateSchema.optional(),
		schedule: DeviceScheduleSchema.optional(),
		reason: DeviceOperationReasonSchema.optional(),
		detail: z.string().optional(),
	})
	.refine((result) => {
		const available = result.state !== undefined && result.schedule !== undefined && result.reason === undefined;
		const unavailable = result.state === undefined && result.schedule === undefined && result.reason !== undefined;
		return available || unavailable;
	})
	.meta({ id: "ConsoleDeviceReadResult" });

export const ConsoleDeviceSetResultSchema = z
	.object({
		state: DeviceLiveStateSchema.optional(),
		reason: DeviceOperationReasonSchema.optional(),
		detail: z.string().optional(),
	})
	.refine((result) => (result.state === undefined) !== (result.reason === undefined))
	.meta({ id: "ConsoleDeviceSetResult" });

export const ConsoleDeviceSchedulePutResultSchema = z
	.object({
		schedule: DeviceScheduleSchema.optional(),
		record: DeviceRecordSchema.optional(),
		reason: z.string().optional(),
		detail: z.string().optional(),
	})
	.refine((result) => (result.schedule === undefined) !== (result.reason === undefined))
	.meta({ id: "ConsoleDeviceSchedulePutResult" });

export const ConsoleDeviceSettingPutResultSchema = z
	.object({
		settings: DeviceSettingsSchema.optional(),
		record: DeviceRecordSchema.optional(),
		reason: z.string().optional(),
		detail: z.string().optional(),
	})
	.refine((result) => (result.settings === undefined) !== (result.reason === undefined))
	.meta({ id: "ConsoleDeviceSettingPutResult" });

export function deviceRefusal(device: DeviceRecord): string | null {
	const supportedKinds: Readonly<Record<DeviceRecord["driver"], readonly DeviceRecord["kind"][]>> = {
		kasa: ["switch"],
	};
	if (!supportedKinds[device.driver].includes(device.kind)) {
		return `${device.driver} does not support ${device.kind}`;
	}
	return null;
}
