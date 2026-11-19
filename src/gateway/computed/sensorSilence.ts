// When paired sensors stop being heard, and are heard again.

import { z } from "zod";
import type { TellWhen } from "../../shared/schemasAutomation.js";
import { DEVICE_RADIOS, type DeviceRadio } from "../../shared/schemasDevices.js";
import { clip } from "./automationOutbox.js";

/** Stale this long before it is told. */
export const SILENCE_HOLD_MS = 10 * 60_000;

/** A paired sensor as its page judges it. */
export interface HeardSensor {
	id: string;
	name: string;
	radio: DeviceRadio;
	/** Absent until first heard. */
	heardAt?: number;
	/** When its page turns stale. */
	staleAt?: number;
}

const ToldSchema = z.object({
	since: z.number(),
	radio: z.enum(DEVICE_RADIOS),
	/** Sensor ids it covers. */
	members: z.array(z.string()),
});

export const SilencesSchema = z.object({
	/** By `radio:<radio>` or `sensor:<id>`. */
	told: z.record(z.string(), ToldSchema),
	/** When each radio was told heard again. */
	recovered: z.record(z.string(), z.number()),
});
export type Silences = z.infer<typeof SilencesSchema>;
type Told = z.infer<typeof ToldSchema>;

export const NO_SILENCES: Silences = { told: {}, recovered: {} };

/** One outbox entry, and the state once it is queued. */
export interface SilenceNotice {
	member: string;
	when: TellWhen;
	sentence: string;
	fields: Record<string, string>;
	settle: (held: Silences) => Silences;
}

const without = <T>(held: Record<string, T>, key: string): Record<string, T> =>
	Object.fromEntries(Object.entries(held).filter(([id]) => id !== key));

/** Drops unpaired sensors' silences. */
const paired = (held: Silences, ids: ReadonlySet<string>): Silences => ({
	...held,
	told: Object.fromEntries(
		Object.entries(held.told).flatMap(([key, told]) => {
			const members = told.members.filter((id) => ids.has(id));
			return members.length > 0 ? [[key, { ...told, members }]] : [];
		}),
	),
});

const silentWords = (gateway: string, radio: DeviceRadio, subject: { count: number } | { name: string }) => {
	const who = radio === "gateway" ? gateway : "No phone";
	if ("count" in subject) {
		return radio === "gateway"
			? `${who} has heard none of its ${subject.count} sensors`
			: `The phones have heard none of their ${subject.count} sensors`;
	}
	return radio === "gateway" ? `${who} has not heard ${subject.name}` : `${who} has heard ${subject.name}`;
};

const heardWords = (gateway: string, radio: DeviceRadio, name: string | null) => {
	if (name === null)
		return radio === "gateway" ? `${gateway} hears its sensors again` : "The phones hear their sensors again";
	return radio === "gateway" ? `${gateway} hears ${name} again` : `A phone hears ${name} again`;
};

/** A radio silent as a whole is one notice; none inside the hold after it was heard. */
export function silenceNotices(
	stored: Silences,
	sensors: readonly HeardSensor[],
	now: number,
	gateway: string,
	/** Silence counts only time listened since this. */
	startedAt: number,
): { held: Silences; notices: SilenceNotice[] } {
	const held = paired(stored, new Set(sensors.map((sensor) => sensor.id)));
	const byId = new Map(sensors.map((sensor) => [sensor.id, sensor]));
	const notices: SilenceNotice[] = [];
	const recovering = new Set<DeviceRadio>();
	const told = new Set<string>();

	for (const [key, entry] of Object.entries(held.told)) {
		const members = entry.members.flatMap((id) => byId.get(id) ?? []);
		const back = members.some((sensor) => sensor.heardAt !== undefined && sensor.heardAt > entry.since);
		if (!back) {
			for (const id of entry.members) told.add(id);
			continue;
		}
		const radioWide = key.startsWith("radio:");
		if (radioWide) recovering.add(entry.radio);
		const name = radioWide ? null : (members[0]?.name ?? null);
		notices.push(heardNotice(key, entry, name, gateway, now));
	}

	for (const radio of DEVICE_RADIOS) {
		const onRadio = sensors.filter(
			(sensor) => sensor.radio === radio && sensor.heardAt !== undefined && sensor.staleAt !== undefined,
		);
		const silent = onRadio.filter((sensor) => {
			const staleAt = sensor.staleAt as number;
			const limit = staleAt - (sensor.heardAt as number);
			return now > staleAt + SILENCE_HOLD_MS && now > startedAt + limit + SILENCE_HOLD_MS;
		});
		const fresh = silent.filter((sensor) => !told.has(sensor.id));
		if (fresh.length === 0) continue;
		if (onRadio.length > 1 && fresh.length === onRadio.length) {
			const since = Math.max(...onRadio.map((sensor) => sensor.heardAt as number));
			const members = onRadio.map((sensor) => sensor.id);
			notices.push(silentNotice(`radio:${radio}`, { since, radio, members }, { count: members.length }, gateway));
			continue;
		}
		const graceFrom = recovering.has(radio) ? now : held.recovered[radio];
		if (graceFrom !== undefined && now - graceFrom <= SILENCE_HOLD_MS) continue;
		for (const sensor of fresh) {
			const since = sensor.heardAt as number;
			const entry = { since, radio, members: [sensor.id] };
			notices.push(silentNotice(`sensor:${sensor.id}`, entry, { name: sensor.name }, gateway));
		}
	}
	return { held, notices };
}

function silentNotice(
	key: string,
	entry: Told,
	subject: { count: number } | { name: string },
	gateway: string,
): SilenceNotice {
	const count: Record<string, string> =
		"count" in subject ? { sensors: String(subject.count) } : { sensor: clip(subject.name) };
	return {
		member: `sensors:silent:${key}:${entry.since}`,
		when: "now",
		sentence: silentWords(gateway, entry.radio, subject),
		fields: { radio: entry.radio, ...count, since: new Date(entry.since).toISOString() },
		settle: (held) => ({ ...held, told: { ...held.told, [key]: entry } }),
	};
}

function heardNotice(key: string, entry: Told, name: string | null, gateway: string, now: number): SilenceNotice {
	const subject: Record<string, string> =
		name === null ? { sensors: String(entry.members.length) } : { sensor: clip(name) };
	return {
		member: `sensors:heard:${key}:${entry.since}`,
		when: "quietly",
		sentence: heardWords(gateway, entry.radio, name),
		fields: { radio: entry.radio, ...subject, since: new Date(entry.since).toISOString() },
		settle: (held) => ({
			told: without(held.told, key),
			recovered: key.startsWith("radio:") ? { ...held.recovered, [entry.radio]: now } : held.recovered,
		}),
	};
}
