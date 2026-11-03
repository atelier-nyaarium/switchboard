import { z } from "zod";
import { REVISION_CEILING } from "./schemasRunbook.js";

export const DEVICE_KINDS = ["switch"] as const;
export const DEVICE_DRIVERS = ["kasa"] as const;
export const DEVICE_STATES = ["on", "off", "unknown", "unreachable"] as const;
export const DEVICE_ACTIONS = ["on", "off"] as const;
export const DEVICE_VERBS = ["on", "off", "toggle"] as const;
export const DEVICE_CLOUD_STATES = ["bound", "disconnected"] as const;
export const KASA_SETTING_KEYS = ["led", "cloud"] as const;
export const DEVICE_REFUSAL_CODES = [
	"not_found",
	"stale",
	"exists",
	"full",
	"invalid",
	"wrong_device",
	"not_supported",
	"toggle_unknown",
	"unreachable",
	"timeout",
	"device_error",
	"write_failed",
	"daemon_away",
	"scan_failed",
] as const;
/** Plug may have changed. */
export const DEVICE_EFFECTS = ["none", "unknown"] as const;
export const DEVICE_MAX_RULES = 32;
export const DEVICE_MAX_RECORDS = 64;

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

type ScheduleValue = z.infer<typeof DeviceScheduleSchema>;

/** Rule order matters. */
export function sameSchedule(a: ScheduleValue, b: ScheduleValue): boolean {
	if (a.enabled !== b.enabled || a.rules.length !== b.rules.length) return false;
	return a.rules.every((rule, index) => {
		const other = b.rules[index]!;
		return (
			(rule.id ?? null) === (other.id ?? null) &&
			rule.time === other.time &&
			rule.action === other.action &&
			rule.enabled === other.enabled &&
			rule.days.length === other.days.length &&
			rule.days.every((on, day) => on === other.days[day])
		);
	});
}

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

export const DeviceRefusalCodeSchema = z.enum(DEVICE_REFUSAL_CODES).meta({ id: "DeviceRefusalCode" });
export const DeviceEffectSchema = z.enum(DEVICE_EFFECTS).meta({ id: "DeviceEffect" });

export const DeviceLandedSchema = z
	.object({ done: z.number().int().nonnegative(), total: z.number().int().positive() })
	.meta({ id: "DeviceLanded" });

export const DeviceRefusalSchema = z
	.object({
		code: DeviceRefusalCodeSchema,
		effect: DeviceEffectSchema,
		landed: DeviceLandedSchema.optional(),
		detail: z.string().max(400).optional(),
		record: DeviceRecordSchema.optional(),
	})
	.meta({ id: "DeviceRefusal" });

export type DeviceRefusalCode = z.infer<typeof DeviceRefusalCodeSchema>;
export type DeviceRefusal = z.infer<typeof DeviceRefusalSchema>;
export type DeviceLanded = z.infer<typeof DeviceLandedSchema>;

const RefusedAnswerSchema = z.object({ kind: z.literal("refused"), refusal: DeviceRefusalSchema });

export const DeviceAddFieldsSchema = z.object({
	mac: DeviceIdSchema,
	address: DeviceAddressSchema,
	name: DeviceNameSchema,
});

export const DeviceListRequestSchema = z.object({ kind: z.literal("device_list") });
export const DeviceReadRequestSchema = z.object({ kind: z.literal("device_read"), id: DeviceIdSchema });
export const DeviceScanRequestSchema = z.object({ kind: z.literal("device_scan") });
export const DeviceHomeNetworkRequestSchema = z.object({ kind: z.literal("device_home_network") });
export const DeviceAddRequestSchema = DeviceAddFieldsSchema.extend({ kind: z.literal("device_add") });
export const DeviceRenameRequestSchema = z.object({
	kind: z.literal("device_rename"),
	id: DeviceIdSchema,
	name: DeviceNameSchema,
	revision: DeviceRevisionSchema,
});
export const DeviceRemoveRequestSchema = z.object({
	kind: z.literal("device_remove"),
	id: DeviceIdSchema,
	revision: DeviceRevisionSchema,
});
export const DeviceSetRequestSchema = z.object({
	kind: z.literal("device_set"),
	id: DeviceIdSchema,
	verb: DeviceVerbSchema,
});
export const DeviceSchedulePutRequestSchema = z.object({
	kind: z.literal("device_schedule_put"),
	id: DeviceIdSchema,
	revision: DeviceRevisionSchema,
	/** Edit's starting schedule. */
	base: DeviceScheduleSchema,
	schedule: DeviceScheduleSchema,
});
export const DeviceSettingPutRequestSchema = z.object({
	kind: z.literal("device_setting_put"),
	id: DeviceIdSchema,
	revision: DeviceRevisionSchema,
	setting: DeviceSettingPutSchema,
});

export const ConsoleDeviceListResultSchema = z
	.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("ok"),
			records: z.array(DeviceRecordSchema).max(DEVICE_MAX_RECORDS),
			revision: z.number().int().nonnegative().max(REVISION_CEILING),
		}),
		RefusedAnswerSchema,
	])
	.meta({ id: "ConsoleDeviceListResult" });

export const ConsoleDeviceReadResultSchema = z
	.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("ok"),
			state: DeviceLiveStateSchema,
			schedule: DeviceScheduleSchema,
			/** Absent if read failed. */
			settings: DeviceSettingsSchema.optional(),
		}),
		RefusedAnswerSchema,
	])
	.meta({ id: "ConsoleDeviceReadResult" });

export const ConsoleDeviceScanResultSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("ok"), candidates: z.array(DeviceCandidateSchema).max(DEVICE_MAX_RECORDS) }),
		RefusedAnswerSchema,
	])
	.meta({ id: "ConsoleDeviceScanResult" });

/** Null when the host is not on WiFi or cannot tell. */
export const ConsoleDeviceHomeNetworkResultSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("ok"), ssid: z.string().min(1).max(32).nullable() }),
		RefusedAnswerSchema,
	])
	.meta({ id: "ConsoleDeviceHomeNetworkResult" });

export const ConsoleDeviceAddResultSchema = z
	.discriminatedUnion("kind", [z.object({ kind: z.literal("ok"), record: DeviceRecordSchema }), RefusedAnswerSchema])
	.meta({ id: "ConsoleDeviceAddResult" });

export const ConsoleDeviceRenameResultSchema = z
	.discriminatedUnion("kind", [z.object({ kind: z.literal("ok"), record: DeviceRecordSchema }), RefusedAnswerSchema])
	.meta({ id: "ConsoleDeviceRenameResult" });

export const ConsoleDeviceRemoveResultSchema = z
	.discriminatedUnion("kind", [z.object({ kind: z.literal("ok") }), RefusedAnswerSchema])
	.meta({ id: "ConsoleDeviceRemoveResult" });

export const ConsoleDeviceSetResultSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("ok"), state: DeviceLiveStateSchema }),
		RefusedAnswerSchema,
	])
	.meta({ id: "ConsoleDeviceSetResult" });

export const ConsoleDeviceSchedulePutResultSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("ok"), schedule: DeviceScheduleSchema }),
		RefusedAnswerSchema,
	])
	.meta({ id: "ConsoleDeviceSchedulePutResult" });

export const ConsoleDeviceSettingPutResultSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("ok"), settings: DeviceSettingsSchema }),
		RefusedAnswerSchema,
	])
	.meta({ id: "ConsoleDeviceSettingPutResult" });

export const DEVICE_CONSOLE_REQUESTS = [
	DeviceListRequestSchema,
	DeviceReadRequestSchema,
	DeviceScanRequestSchema,
	DeviceHomeNetworkRequestSchema,
	DeviceAddRequestSchema,
	DeviceRenameRequestSchema,
	DeviceRemoveRequestSchema,
	DeviceSetRequestSchema,
	DeviceSchedulePutRequestSchema,
	DeviceSettingPutRequestSchema,
] as const;

export type DeviceConsoleOp = z.infer<(typeof DEVICE_CONSOLE_REQUESTS)[number]>;
export type DeviceConsoleOpKind = DeviceConsoleOp["kind"];

export const DEVICE_CONSOLE_RESULTS = {
	device_list: ConsoleDeviceListResultSchema,
	device_read: ConsoleDeviceReadResultSchema,
	device_scan: ConsoleDeviceScanResultSchema,
	device_home_network: ConsoleDeviceHomeNetworkResultSchema,
	device_add: ConsoleDeviceAddResultSchema,
	device_rename: ConsoleDeviceRenameResultSchema,
	device_remove: ConsoleDeviceRemoveResultSchema,
	device_set: ConsoleDeviceSetResultSchema,
	device_schedule_put: ConsoleDeviceSchedulePutResultSchema,
	device_setting_put: ConsoleDeviceSettingPutResultSchema,
} as const satisfies Record<DeviceConsoleOpKind, z.ZodType>;

export type DeviceConsoleResult<K extends DeviceConsoleOpKind> = z.infer<(typeof DEVICE_CONSOLE_RESULTS)[K]>;

export const DEVICE_CONSOLE_OP_KINDS: readonly DeviceConsoleOpKind[] = DEVICE_CONSOLE_REQUESTS.map(
	(request) => request.shape.kind.value,
);

export function isDeviceConsoleOp<T extends { kind: string }>(op: T): op is Extract<T, { kind: DeviceConsoleOpKind }> {
	return (DEVICE_CONSOLE_OP_KINDS as readonly string[]).includes(op.kind);
}

export function deviceRefusal(device: DeviceRecord): string | null {
	const supportedKinds: Readonly<Record<DeviceRecord["driver"], readonly DeviceRecord["kind"][]>> = {
		kasa: ["switch"],
	};
	if (!supportedKinds[device.driver].includes(device.kind)) {
		return `${device.driver} does not support ${device.kind}`;
	}
	return null;
}
