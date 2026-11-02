import type { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import type {
	DeviceRecord,
	DeviceScheduleSchema,
	DeviceSettingPutSchema,
	DeviceSettingsSchema,
	DeviceVerbSchema,
} from "../../shared/schemasDevices.js";

export type DeviceVerb = z.infer<typeof DeviceVerbSchema>;

export interface DeviceOperationContext {
	ambient: Ambient;
	signal: AbortSignal;
}

// Sent means unconfirmed outcome.
export type DeviceDriverError =
	| { kind: "unreachable"; detail: string; sent?: boolean }
	| { kind: "refused"; code: number; message: string }
	| { kind: "timeout"; detail: string; sent?: boolean };

export class DeviceDriverFailure extends Error {
	constructor(readonly failure: DeviceDriverError) {
		super(failure.kind === "refused" ? failure.message : failure.detail);
		this.name = "DeviceDriverFailure";
	}
}

export function sentOf(failure: DeviceDriverError): boolean {
	return failure.kind !== "refused" && failure.sent === true;
}

/** Drops a sent mark from a pre-mutation failure. */
export function knownOutcome(error: unknown): unknown {
	if (!(error instanceof DeviceDriverFailure) || !sentOf(error.failure)) return error;
	const { sent: _sent, ...rest } = error.failure as Extract<DeviceDriverError, { detail: string }>;
	return new DeviceDriverFailure(rest);
}

/** Appends what landed before the failure. */
export function noteLanding(error: unknown, note: string): unknown {
	if (!(error instanceof DeviceDriverFailure)) return error;
	const failure = error.failure;
	if (failure.kind === "refused") {
		return new DeviceDriverFailure({ ...failure, message: `${failure.message}; ${note}` });
	}
	const { sent, ...rest } = failure;
	return new DeviceDriverFailure({
		...rest,
		detail: `${failure.detail}; ${note}`,
		...(sent === true ? { sent } : {}),
	});
}

export type DeviceConfirmedState = {
	state: "on" | "off";
	readAt: number;
};

export type DeviceReadAnswer = {
	state: DeviceConfirmedState;
	schedule: z.infer<typeof DeviceScheduleSchema>;
};

export type DeviceSchedule = z.infer<typeof DeviceScheduleSchema>;
export type DeviceSettings = z.infer<typeof DeviceSettingsSchema>;
export type DeviceSetting = z.infer<typeof DeviceSettingPutSchema>;

export interface DeviceScheduleAccess {
	read(): Promise<DeviceSchedule>;
	put(schedule: DeviceSchedule): Promise<DeviceSchedule>;
}

export interface DeviceSettingsAccess {
	read(): Promise<DeviceSettings>;
	put(setting: DeviceSetting): Promise<DeviceSettings>;
}

export interface DeviceDriver {
	kinds(): readonly DeviceRecord["kind"][];
	identify(address: string, ctx: DeviceOperationContext): Promise<string>;
	read(record: DeviceRecord, ctx: DeviceOperationContext): Promise<DeviceReadAnswer>;
	set(record: DeviceRecord, verb: DeviceVerb, ctx: DeviceOperationContext): Promise<DeviceConfirmedState>;
	rename(record: DeviceRecord, name: string, ctx: DeviceOperationContext): Promise<{ previous: string | null }>;
	schedule(record: DeviceRecord, ctx: DeviceOperationContext): DeviceScheduleAccess;
	settings(record: DeviceRecord, ctx: DeviceOperationContext): DeviceSettingsAccess;
}
