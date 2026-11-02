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

/** Marked before a write; none once denied. */
export interface EffectLatch {
	readonly marked: boolean;
	mark(): void;
	none(): void;
}

export function effectLatch(): EffectLatch {
	return {
		marked: false,
		mark() {
			(this as { marked: boolean }).marked = true;
		},
		none() {
			(this as { marked: boolean }).marked = false;
		},
	};
}

export interface DeviceOperationContext {
	ambient: Ambient;
	signal: AbortSignal;
	effect: EffectLatch;
}

// Sent means command written.
export type DeviceDriverError =
	| { kind: "unreachable"; detail: string; sent?: boolean }
	| { kind: "refused"; code: number; message: string; note?: string }
	| { kind: "timeout"; detail: string; sent?: boolean };

export class DeviceDriverFailure extends Error {
	constructor(readonly failure: DeviceDriverError) {
		super(failure.kind === "refused" ? failure.message : failure.detail);
		this.name = "DeviceDriverFailure";
	}
}

/** Appends a landing note. */
export function noteLanding(error: unknown, note: string): unknown {
	if (!(error instanceof DeviceDriverFailure)) return error;
	const failure = error.failure;
	if (failure.kind === "refused") {
		return new DeviceDriverFailure({ ...failure, note: failure.note ? `${failure.note}; ${note}` : note });
	}
	return new DeviceDriverFailure({ ...failure, detail: `${failure.detail}; ${note}` });
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

/** Identity before every mutation. */
export interface DeviceDriver {
	kinds(): readonly DeviceRecord["kind"][];
	identify(address: string, ctx: DeviceOperationContext): Promise<string>;
	read(record: DeviceRecord, ctx: DeviceOperationContext): Promise<DeviceReadAnswer>;
	set(record: DeviceRecord, verb: DeviceVerb, ctx: DeviceOperationContext): Promise<DeviceConfirmedState>;
	rename(record: DeviceRecord, name: string, ctx: DeviceOperationContext): Promise<{ previous: string | null }>;
	schedule(record: DeviceRecord, ctx: DeviceOperationContext): DeviceScheduleAccess;
	settings(record: DeviceRecord, ctx: DeviceOperationContext): DeviceSettingsAccess;
}
