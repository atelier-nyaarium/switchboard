import type { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import type {
	DeviceLanded,
	DeviceReadingSchema,
	DeviceRecord,
	DeviceScheduleSchema,
	DeviceSettingPutSchema,
	DeviceSettingsSchema,
	DeviceVerbSchema,
} from "../../shared/schemasDevices.js";

export type DeviceVerb = z.infer<typeof DeviceVerbSchema>;

/** Marked while any attempt is undenied. */
export interface EffectLatch {
	readonly marked: boolean;
	/** Returns a one-shot deny. */
	attempt(): () => void;
}

export function effectLatch(): EffectLatch {
	let open = 0;
	return {
		get marked() {
			return open > 0;
		},
		attempt() {
			open += 1;
			let denied = false;
			return () => {
				if (denied) return;
				denied = true;
				open -= 1;
			};
		},
	};
}

export interface DeviceOperationContext {
	ambient: Ambient;
	signal: AbortSignal;
	effect: EffectLatch;
}

// Sent means command written.
export type DeviceDriverError = (
	| { kind: "unreachable"; detail: string; sent?: boolean }
	| { kind: "refused"; code: number; message: string }
	| { kind: "timeout"; detail: string; sent?: boolean }
	| { kind: "invalid"; detail: string }
	| { kind: "wrong_device"; detail: string }
) & { landed?: DeviceLanded };

export class DeviceDriverFailure extends Error {
	constructor(readonly failure: DeviceDriverError) {
		super(failure.kind === "refused" ? failure.message : failure.detail);
		this.name = "DeviceDriverFailure";
	}
}

export function withLanded(error: unknown, landed: DeviceLanded): unknown {
	if (!(error instanceof DeviceDriverFailure)) return error;
	return new DeviceDriverFailure({ ...error.failure, landed });
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

export interface SensorReadAnswer {
	readings: z.infer<typeof DeviceReadingSchema>[];
	heardAt?: number;
	stale?: string;
}

/** A sensor's held readings; no device I/O. */
export interface SensorReads {
	read(record: DeviceRecord): SensorReadAnswer;
}

export const NOT_HEARD: SensorReads = { read: () => ({ readings: [], stale: "not heard yet" }) };

/** A switch's driver; identity before every mutation. */
export interface DeviceDriver {
	kinds(): readonly DeviceRecord["kind"][];
	identify(address: string, ctx: DeviceOperationContext): Promise<string>;
	read(record: DeviceRecord, ctx: DeviceOperationContext): Promise<DeviceReadAnswer>;
	set(record: DeviceRecord, verb: DeviceVerb, ctx: DeviceOperationContext): Promise<DeviceConfirmedState>;
	rename(record: DeviceRecord, name: string, ctx: DeviceOperationContext): Promise<{ previous: string | null }>;
	schedule(record: DeviceRecord, ctx: DeviceOperationContext): DeviceScheduleAccess;
	settings(record: DeviceRecord, ctx: DeviceOperationContext): DeviceSettingsAccess;
}
