import { z } from "zod";

export const DEVICE_WATCH_MAX = 64;
export const DEVICE_ADVERTISEMENT_BATCH_MAX = 32;
const DEVICE_ADVERTISEMENT_DATA_MAX = 32;
const DEVICE_ADVERTISEMENT_BYTES_MAX = 64;
const DEVICE_ADVERTISEMENT_SERVICES_MAX = 64;
const BluetoothMacSchema = z.string().regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/);
const CompanyIdSchema = z
	.string()
	.regex(/^(?:0|[1-9][0-9]{0,4})$/)
	.refine((value) => Number(value) <= 0xffff);

export const DeviceWatchEntrySchema = z.strictObject({
	mac: BluetoothMacSchema,
	activeScan: z.boolean(),
});

export const DeviceWatchFrameSchema = z
	.strictObject({
		type: z.literal("device_watch"),
		watch: z.array(DeviceWatchEntrySchema).max(DEVICE_WATCH_MAX),
	})
	.refine((frame) => new Set(frame.watch.map((entry) => entry.mac)).size === frame.watch.length);

export const DeviceAdvertSchema = z
	.strictObject({
		name: z.string().max(64).optional(),
		data: z
			.record(
				CompanyIdSchema,
				z
					.string()
					.max(DEVICE_ADVERTISEMENT_BYTES_MAX * 2)
					.regex(/^(?:[0-9a-f]{2}){0,64}$/),
			)
			.refine((data) => Object.keys(data).length <= DEVICE_ADVERTISEMENT_DATA_MAX),
		services: z.array(z.string().regex(/^[0-9a-f]{4}$/)).max(DEVICE_ADVERTISEMENT_SERVICES_MAX),
	})
	.meta({ id: "DeviceAdvert" });

export const DeviceAdvertObservationSchema = z.strictObject({
	mac: BluetoothMacSchema,
	advert: DeviceAdvertSchema,
	at: z.number().int().nonnegative(),
});

export const DeviceAdvertFrameSchema = z.strictObject({
	type: z.literal("device_advert"),
	observations: z.array(DeviceAdvertObservationSchema).max(DEVICE_ADVERTISEMENT_BATCH_MAX),
});

export type DeviceWatchEntry = z.infer<typeof DeviceWatchEntrySchema>;
export type DeviceAdvert = z.infer<typeof DeviceAdvertSchema>;
export type DeviceAdvertObservation = z.infer<typeof DeviceAdvertObservationSchema>;
export type DeviceAdvertFrame = z.infer<typeof DeviceAdvertFrameSchema>;
