import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { TemperatureUnitSchema } from "./schemasAssistant.js";
import {
	DEVICE_CONSOLE_REQUESTS,
	DEVICE_CONSOLE_RESULTS,
	DEVICE_MAX_RECORDS,
	type DeviceConsoleOp,
	type DeviceConsoleOpKind,
	type DeviceRecord,
	DeviceRecordSchema,
	DeviceRefusalSchema,
	type DeviceSettingPut,
	DeviceStateSchema,
} from "./schemasDevices.js";
import { DEVICE_CAPABILITIES, INTEGRATIONS, type IntegrationAct } from "./schemasIntegrations.js";

export const DEVICE_TOOL = "device";

/** Which console ops the assistant gets. */
export const DEVICE_TOOL_OFFERS = {
	device_list: true,
	device_read: true,
	device_reading_post: false,
	sensor_threshold_put: false,
	device_scan: false,
	device_home_network: false,
	device_add: false,
	device_rename: true,
	device_remove: false,
	device_set: true,
	device_schedule_put: true,
	device_setting_put: true,
} as const satisfies Record<DeviceConsoleOpKind, boolean>;

export type DeviceToolOpKind = {
	[K in DeviceConsoleOpKind]: (typeof DEVICE_TOOL_OFFERS)[K] extends true ? K : never;
}[DeviceConsoleOpKind];

export type DeviceToolOp = Extract<DeviceConsoleOp, { kind: DeviceToolOpKind }>;

export const DEVICE_TOOL_OP_KINDS: readonly DeviceToolOpKind[] = (
	Object.keys(DEVICE_TOOL_OFFERS) as DeviceConsoleOpKind[]
).filter((kind): kind is DeviceToolOpKind => DEVICE_TOOL_OFFERS[kind]);

type OfferedRequest = z.ZodObject<{ kind: z.ZodLiteral<DeviceToolOpKind> } & z.ZodRawShape>;

/** The console's own request objects. */
export const DEVICE_TOOL_REQUESTS = DEVICE_CONSOLE_REQUESTS.filter((request) =>
	(DEVICE_TOOL_OP_KINDS as readonly string[]).includes(request.shape.kind.value),
) as unknown as [OfferedRequest, ...OfferedRequest[]];

export const DeviceToolOpSchema = z.discriminatedUnion(
	"kind",
	DEVICE_TOOL_REQUESTS,
) as unknown as z.ZodType<DeviceToolOp>;

/** No address. */
export const AssistantDeviceRecordSchema = DeviceRecordSchema.omit({ address: true });

export type AssistantDeviceRecord = z.infer<typeof AssistantDeviceRecordSchema>;

export const AssistantDeviceSchema = AssistantDeviceRecordSchema.extend({
	state: DeviceStateSchema,
	capabilities: z.array(z.enum(DEVICE_CAPABILITIES)),
});

export const AssistantDeviceRefusalSchema = DeviceRefusalSchema.omit({ record: true }).extend({
	record: AssistantDeviceRecordSchema.optional(),
});

export type AssistantDeviceRefusal = z.infer<typeof AssistantDeviceRefusalSchema>;

const Refused = z.object({ kind: z.literal("refused"), refusal: AssistantDeviceRefusalSchema });

type Options = readonly [z.ZodObject<z.ZodRawShape>, ...z.ZodObject<z.ZodRawShape>[]];

/** Console ok answer. */
function okOf<U extends z.ZodDiscriminatedUnion<Options>>(union: U): U["options"][0] {
	const first = union.options[0];
	if ((first.shape.kind as z.ZodLiteral<string>).value !== "ok") throw new Error("the ok answer is not first");
	return first;
}

/** A console answer by its kind. */
function memberOf<U extends z.ZodDiscriminatedUnion<Options>>(union: U, kind: string): U["options"][number] {
	const member = union.options.find((option) => (option.shape.kind as z.ZodLiteral<string>).value === kind);
	if (!member) throw new Error(`no ${kind} answer`);
	return member;
}

export const DEVICE_TOOL_RESULTS = {
	device_list: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("ok"), devices: z.array(AssistantDeviceSchema).max(DEVICE_MAX_RECORDS) }),
		Refused,
	]),
	device_read: z.discriminatedUnion("kind", [
		okOf(DEVICE_CONSOLE_RESULTS.device_read),
		memberOf(DEVICE_CONSOLE_RESULTS.device_read, "sensor").extend({
			// Required starting 2026-11-28.
			temperatureUnit: TemperatureUnitSchema.optional(),
		}),
		Refused,
	]),
	device_rename: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("ok"), record: AssistantDeviceRecordSchema }),
		Refused,
	]),
	device_set: z.discriminatedUnion("kind", [okOf(DEVICE_CONSOLE_RESULTS.device_set), Refused]),
	device_schedule_put: z.discriminatedUnion("kind", [okOf(DEVICE_CONSOLE_RESULTS.device_schedule_put), Refused]),
	device_setting_put: z.discriminatedUnion("kind", [okOf(DEVICE_CONSOLE_RESULTS.device_setting_put), Refused]),
} as const satisfies Record<DeviceToolOpKind, z.ZodType>;

export type DeviceToolResult<K extends DeviceToolOpKind> = z.infer<(typeof DEVICE_TOOL_RESULTS)[K]>;

export function samePut(a: DeviceSettingPut, b: DeviceSettingPut): boolean {
	return canonicalJson(a) === canonicalJson(b);
}

/** Catalogue danger act, if any. */
export function dangerActOf(op: DeviceToolOp, driver: DeviceRecord["driver"] | undefined): IntegrationAct | null {
	if (op.kind !== "device_setting_put" || driver === undefined) return null;
	const acts: readonly IntegrationAct[] = INTEGRATIONS[driver].acts;
	return acts.find((act) => act.tier === "danger" && samePut(act.put, op.setting)) ?? null;
}
