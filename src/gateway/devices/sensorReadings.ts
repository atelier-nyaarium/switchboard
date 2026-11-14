import type { Advert } from "../../shared/ble-recognition.js";
import { type Definition, definitionOf, inputsOf, readingsOf } from "../../shared/device-definitions/index.js";
import type { ExprType, FieldRef } from "../../shared/expressions.js";
import { unknown } from "../../shared/expressions.js";
import type { DeviceRecord } from "../../shared/schemasDevices.js";
import type { FieldInput } from "../computed/computedFields.js";
import type { SensorReadAnswer, SensorReads } from "./driver.js";

export interface Heard {
	advert: Advert;
	at: number;
}

export interface Extremes {
	low?: { value: number; at: number };
	high?: { value: number; at: number };
}

export interface SensorReadingsDeps {
	record: (mac: string) => DeviceRecord | null;
	latest: (mac: string) => Heard | null;
	now: () => number;
	staleAfterMs: number;
	definitions?: (key: string) => Definition | null;
	extremes?: (mac: string, measure: string) => Extremes;
}

const typeOf = (spec: Definition["readings"][number]["spec"]): ExprType =>
	spec.kind === "number"
		? { type: "number", integral: spec.decimals === 0 }
		: spec.kind === "enumeration"
			? { type: "choice", members: spec.options.map((option) => option.value) }
			: spec.kind === "text" || spec.kind === "bytes"
				? { type: spec.kind }
				: { type: "unknown" };

export function createSensorReadings(deps: SensorReadingsDeps): SensorReads & {
	input(ref: FieldRef): FieldInput | null;
} {
	const definitions = deps.definitions ?? definitionOf;
	const bound = (record: DeviceRecord | null) =>
		record?.kind === "sensor" && record.definition ? definitions(record.definition) : null;

	const staleness = (heard: Heard | null): string | undefined => {
		if (!heard) return "not heard yet";
		const quiet = deps.now() - heard.at;
		return quiet > deps.staleAfterMs ? `not heard for ${Math.round(quiet / 60_000)} minutes` : undefined;
	};

	const read = (record: DeviceRecord): SensorReadAnswer => {
		const definition = bound(record);
		const heard = deps.latest(record.id);
		const stale = staleness(heard);
		const at = heard ? { heardAt: heard.at } : {};
		if (!definition) return { readings: [], ...at, stale: stale ?? "no definition reads this model" };
		const values = heard ? readingsOf(definition, inputsOf(definition, heard.advert)) : {};
		const readings = definition.readings.map((reading) => {
			const value = values[reading.key];
			const held = value?.known && typeof value.value !== "boolean" ? { value: value.value } : {};
			return {
				spec: reading.spec,
				...(reading.alerts ? { alerts: reading.alerts } : {}),
				...held,
				...(deps.extremes?.(record.id, reading.key) ?? {}),
			};
		});
		return { readings, ...at, ...(stale ? { stale } : {}) };
	};

	const input = (ref: FieldRef): FieldInput | null => {
		if (ref.source !== "device") return null;
		const record = deps.record(ref.device);
		const definition = bound(record);
		const reading = definition?.readings.find((entry) => entry.key === ref.key);
		if (!record || !definition || !reading) return null;
		const heard = deps.latest(record.id);
		const stale = staleness(heard);
		const value =
			heard && !stale ? readingsOf(definition, inputsOf(definition, heard.advert))[reading.key] : undefined;
		return {
			type: typeOf(reading.spec),
			value: value ?? unknown(stale ?? "not heard"),
			// Version bump resets baseline.
			basis: `${definition.key}@${definition.version}`,
		};
	};

	return { read, input };
}
