// Projections, never secrets.

import { z } from "zod";
import type { Advert } from "../../shared/ble-recognition.js";
import { familyOf, unsupported } from "../../shared/ble-recognition.js";
import {
	definitionOf,
	inputsOf,
	matches,
	readingsOf,
	SHIPPED_DEFINITIONS,
} from "../../shared/device-definitions/index.js";
import type { Value } from "../../shared/expressions.js";
import { bandToDisplay, toDisplay } from "../../shared/field-types.js";
import { readingInDisplay } from "../../shared/field-values.js";
import { HostBleScanResultSchema, type HostOpResult } from "../../shared/host-op.js";
import type { ConsoleAssistantStateResult, TemperatureUnit } from "../../shared/schemasAssistant.js";
import { decideEvent, firstMatch } from "../../shared/schemasAssistantRules.js";
import type { DeviceReadingSchema, DeviceRecord } from "../../shared/schemasDevices.js";
import { CONSOLE_LISTEN_DEFAULT_S, CONSOLE_LISTEN_MAX_S, type ConsoleIds } from "../../shared/schemasLiveConsole.js";
import type { DeviceStage } from "../compose/composeDevices.js";
import type { Automations } from "../computed/automations.js";
import type { ComputedFields } from "../computed/computedFields.js";
import type { SensorThresholds } from "../devices/sensorThresholds.js";
import { ConsoleError } from "./builtins.js";
import type { ConsoleAudience, ConsoleEntity, ConsoleParam } from "./registry.js";

type DeviceReading = z.infer<typeof DeviceReadingSchema>;

export interface ConsoleReaders {
	gateway: () => {
		id: string;
		version: string;
		router: { connected: boolean; registered: boolean; incarnation: number | null } | null;
	};
	devices: () => Pick<DeviceStage, "records" | "sensorRead"> | undefined;
	fields: () => Pick<ComputedFields, "list" | "get" | "value" | "stateOf" | "invalidOf"> | undefined;
	automations: () =>
		| Pick<Automations, "list" | "runs" | "invalidOf" | "checkpoint" | "queued" | "sentenceOf">
		| undefined;
	thresholds: () => Pick<SensorThresholds, "list"> | undefined;
	assistant: () => ConsoleAssistantStateResult;
	temperatureUnit: () => TemperatureUnit;
	/** Read-only daemon scan. */
	bluetoothListen: (windowMs: number) => Promise<HostOpResult>;
}

const AUDIENCE: readonly ConsoleAudience[] = ["host", "owner"];

const deviceParam: ConsoleParam = {
	name: "device",
	schema: z.string(),
	type: "Text",
	description: "Id or name.",
	completes: "devices",
};
const sensorParam: ConsoleParam = { ...deviceParam, completes: "sensors" };
const idOf = (completes: NonNullable<ConsoleParam["completes"]>, description: string): ConsoleParam => ({
	name: "id",
	schema: z.string(),
	type: "Text",
	description,
	completes,
});
const fieldParam = idOf("fields", "Field id, as fields.list shows it.");
const automationParam = idOf("automations", "Automation id, as automations.list shows it.");
const sourceParam = idOf("sources", "Source id, as sources.list shows it.");
const definitionParam: ConsoleParam = {
	name: "key",
	schema: z.string(),
	type: "Text",
	description: "Definition key.",
	completes: "definitions",
};
const AdvertSchema = z.object({
	name: z.string().optional(),
	data: z.record(z.string(), z.string()),
	services: z.array(z.string()),
});
const advertParam: ConsoleParam = {
	name: "advert",
	schema: AdvertSchema,
	type: "{name?, data, services}",
	description: "An advert, as a payload shows it.",
};

const plainOf = (value: Value) => (value.known ? value.value : { unknown: value.reason });

export function consoleIds(readers: ConsoleReaders): ConsoleIds {
	const devices = readers.devices();
	return {
		devices: (devices?.records() ?? []).map((record) => ({
			id: record.id,
			name: record.name,
			readings: devices?.sensorRead(record.id)?.readings.map((reading) => reading.spec.field) ?? [],
		})),
		fields: (readers.fields()?.list() ?? []).map((record) => ({ id: record.id, label: record.body.label })),
		automations: (readers.automations()?.list() ?? []).map((record) => ({
			id: record.id,
			label: readers.automations()?.sentenceOf(record.id) ?? record.id,
		})),
		sources: readers.assistant().watchers.map((entry) => ({ id: entry.id, label: entry.label })),
		definitions: SHIPPED_DEFINITIONS.map((definition) => definition.key),
	};
}

export function consoleEntities(readers: ConsoleReaders): ConsoleEntity[] {
	const stage = (): Pick<DeviceStage, "records" | "sensorRead"> => {
		const devices = readers.devices();
		if (!devices) throw new ConsoleError("not_ready", "devices are not loaded yet");
		return devices;
	};

	const resolve = (device: string): DeviceRecord => {
		const records = stage().records();
		const wanted = device.toLowerCase();
		const found =
			records.find((record) => record.id === wanted) ??
			records.find((record) => record.name.toLowerCase() === wanted);
		if (!found) throw new ConsoleError("not_found", `no device ${device}`);
		return found;
	};

	const sensorOf = (device: string) => {
		const record = resolve(device);
		const answer = stage().sensorRead(record.id);
		if (!answer) throw new ConsoleError("not_a_sensor", `${record.name} is not a sensor`);
		return { record, answer };
	};

	const readingOf = (reading: DeviceReading) => {
		const shown = readingInDisplay(reading, readers.temperatureUnit());
		return {
			label: reading.spec.label,
			key: reading.spec.field,
			value: shown.value ?? null,
			...(shown.shown === undefined ? {} : { shown: shown.shown }),
			...(shown.low ? { low: { shown: shown.low.shown, at: shown.low.at } } : {}),
			...(shown.high ? { high: { shown: shown.high.shown, at: shown.high.at } } : {}),
			...(reading.alerts ? { alerts: reading.alerts } : {}),
		};
	};

	const sensorView = (device: string) => {
		const { record, answer } = sensorOf(device);
		return {
			name: record.name,
			id: record.id,
			radio: record.radio ?? null,
			model: answer.model ?? null,
			heardAt: answer.heardAt ?? null,
			stale: answer.stale ?? null,
			readings: answer.readings.map(readingOf),
		};
	};

	const thresholdsOf = (device: string) => {
		const { record, answer } = sensorOf(device);
		return (answer.thresholds ?? []).map((threshold) => {
			const spec = answer.readings.find((reading) => reading.spec.field === threshold.measure)?.spec;
			const named = { device: record.name, ...threshold };
			if (spec?.kind !== "number" || !spec.unit) return named;
			const unit = readers.temperatureUnit();
			return { ...bandToDisplay(named, spec.unit, unit), unit: toDisplay(0, spec.unit, unit).unit };
		});
	};

	const fields = () => {
		const held = readers.fields();
		if (!held) throw new ConsoleError("not_ready", "computed fields are not loaded yet");
		return held;
	};
	const automations = () => {
		const held = readers.automations();
		if (!held) throw new ConsoleError("not_ready", "automations are not loaded yet");
		return held;
	};
	const source = (id: string) => {
		const found = readers.assistant().watchers.find((entry) => entry.id === id);
		if (!found) throw new ConsoleError("not_found", `no source ${id}`);
		return found;
	};
	const automation = (id: string) => {
		const found = automations()
			.list()
			.find((record) => record.id === id);
		if (!found) throw new ConsoleError("not_found", `no automation ${id}`);
		return found;
	};
	const definition = (key: string) => {
		const found = definitionOf(key);
		if (!found) throw new ConsoleError("not_found", `no definition ${key}`);
		return found;
	};
	const labelOf = (automationId: string) => automations().sentenceOf(automationId);

	return [
		{
			name: "gateway",
			description: "This Gateway.",
			audiences: AUDIENCE,
			members: {
				id: { kind: "property", description: "Its id.", type: "Text", get: () => readers.gateway().id },
				version: {
					kind: "property",
					description: "Its build.",
					type: "Text",
					get: () => readers.gateway().version,
				},
				router: {
					kind: "property",
					description: "Its Router link.",
					type: "{connected, registered, incarnation}",
					get: () => readers.gateway().router,
				},
				temperatureUnit: {
					kind: "property",
					description: "The owner's display unit.",
					type: "Text",
					get: () => readers.temperatureUnit(),
				},
			},
		},
		{
			name: "devices",
			description: "Paired devices.",
			audiences: AUDIENCE,
			members: {
				list: {
					kind: "property",
					description: "Every paired device.",
					type: "List<Device>",
					get: () => stage().records(),
				},
				get: {
					kind: "method",
					description: "One device.",
					params: [deviceParam],
					returns: "Device",
					call: ([device]) => resolve(device as string),
				},
			},
		},
		{
			name: "sensors",
			description: "Paired sensors, readings in the owner's unit.",
			audiences: AUDIENCE,
			members: {
				list: {
					kind: "property",
					description: "Every sensor, its main reading and when heard.",
					type: "List<SensorSummary>",
					get: () =>
						stage()
							.records()
							.filter((record) => record.kind === "sensor")
							.map((record) => {
								const view = sensorView(record.id);
								const main = view.readings.find((reading) => reading.shown !== undefined);
								return {
									name: view.name,
									id: view.id,
									radio: view.radio,
									model: view.model,
									main: main ? `${main.label} ${main.shown}` : null,
									heardAt: view.heardAt,
									stale: view.stale,
								};
							}),
				},
				read: {
					kind: "method",
					description: "Readings now, with 24-hour lows and highs.",
					params: [sensorParam],
					returns: "Sensor",
					call: ([device]) => sensorView(device as string),
				},
				payloads: {
					kind: "method",
					description: "The last distinct adverts, newest first, with the radio that heard each.",
					params: [sensorParam],
					returns: "List<Payload>",
					call: ([device]) => sensorOf(device as string).answer.payloads,
				},
				extremes: {
					kind: "method",
					description: "A reading's 24-hour low and high.",
					params: [
						sensorParam,
						{
							name: "key",
							schema: z.string(),
							type: "Text",
							description: "Reading key.",
							completes: "readings",
						},
					],
					returns: "{low, high}",
					call: ([device, key]) => {
						const reading = sensorView(device as string).readings.find((entry) => entry.key === key);
						if (!reading) throw new ConsoleError("not_found", `no reading ${key}`);
						return { low: reading.low ?? null, high: reading.high ?? null };
					},
				},
			},
		},
		{
			name: "thresholds",
			description: "Sensor alerts as set, in the owner's unit.",
			audiences: AUDIENCE,
			members: {
				list: {
					kind: "property",
					description: "Every sensor's thresholds.",
					type: "List<Threshold>",
					get: () =>
						stage()
							.records()
							.filter((record) => record.kind === "sensor")
							.flatMap((record) => thresholdsOf(record.id)),
				},
				get: {
					kind: "method",
					description: "One sensor's thresholds.",
					params: [sensorParam],
					returns: "List<Threshold>",
					call: ([device]) => thresholdsOf(device as string),
				},
			},
		},
		{
			name: "fields",
			description: "Computed fields and their values.",
			audiences: AUDIENCE,
			members: {
				list: {
					kind: "property",
					description: "Every field, its value, and why invalid.",
					type: "List<Field>",
					get: () =>
						fields()
							.list()
							.map((record) => ({
								id: record.id,
								label: record.body.label,
								value: plainOf(fields().value(record.id)),
								invalid: fields().invalidOf(record.id),
							})),
				},
				get: {
					kind: "method",
					description: "One field as set, and why invalid.",
					params: [fieldParam],
					returns: "Field",
					call: ([id]) => {
						const record = fields().get(id as string);
						if (!record) throw new ConsoleError("not_found", `no field ${id}`);
						return { ...record, invalid: fields().invalidOf(record.id) };
					},
				},
				read: {
					kind: "method",
					description: "Its value now, or why unknown, with its last transitions.",
					params: [fieldParam],
					returns: "FieldReading",
					call: ([id]) => {
						if (!fields().get(id as string)) throw new ConsoleError("not_found", `no field ${id}`);
						return { ...fields().stateOf(id as string), value: plainOf(fields().value(id as string)) };
					},
				},
			},
		},
		{
			name: "automations",
			description: "Automations, where each stands, their runs and what they queued.",
			audiences: AUDIENCE,
			members: {
				list: {
					kind: "property",
					description: "Every automation and why invalid.",
					type: "List<Automation>",
					get: () =>
						automations()
							.list()
							.map((record) => ({
								id: record.id,
								...record.body,
								label: labelOf(record.id),
								invalid: automations().invalidOf(record.id),
							})),
				},
				runs: {
					kind: "property",
					description: "The run log, newest first.",
					type: "List<Run>",
					get: () =>
						[...automations().runs()].reverse().map((run) => ({ label: labelOf(run.automation), ...run })),
				},
				queue: {
					kind: "property",
					description: "Events waiting for the assistant, newest first.",
					type: "List<Event>",
					get: () => [...automations().queued().events].reverse(),
				},
				get: {
					kind: "method",
					description: "One automation as set, and why invalid.",
					params: [automationParam],
					returns: "Automation",
					call: ([id]) => {
						const record = automation(id as string);
						return {
							id: record.id,
							...record.body,
							label: labelOf(record.id),
							invalid: automations().invalidOf(record.id),
						};
					},
				},
				read: {
					kind: "method",
					description: "Where it stands: its revision, field epoch and handled seq.",
					params: [automationParam],
					returns: "Checkpoint",
					call: ([id]) => automations().checkpoint(automation(id as string).id),
				},
			},
		},
		{
			name: "sources",
			description: "Where the assistant's events come from.",
			audiences: AUDIENCE,
			members: {
				list: {
					kind: "property",
					description: "Every source and its health.",
					type: "List<SourceSummary>",
					get: () =>
						readers.assistant().watchers.map((entry) => ({
							id: entry.id,
							label: entry.label,
							enabled: entry.enabled,
							unread: entry.unread,
							lastSuccessAt: entry.lastSuccessAt ?? null,
							nextPollAt: entry.nextPollAt ?? null,
							stopped: entry.stopped ?? null,
						})),
				},
				get: {
					kind: "method",
					description: "One source as set: its fields, rules and commands. Never its secret.",
					params: [sourceParam],
					returns: "Source",
					call: ([id]) => {
						const found = source(id as string);
						return {
							id: found.id,
							label: found.label,
							enabled: found.enabled ?? null,
							fieldSpecs: found.fieldSpecs ?? [],
							rules: found.rules
								? [...found.rules.rules, { id: "otherwise", action: found.rules.otherwise.action }]
								: [],
							invalid: found.invalid ?? [],
							actions: found.actions ?? [],
						};
					},
				},
				read: {
					kind: "method",
					description: "Its health now: unread, polls, backoff, and values it did not expect.",
					params: [sourceParam],
					returns: "SourceHealth",
					call: ([id]) => {
						const found = source(id as string);
						return {
							id: found.id,
							label: found.label,
							unread: found.unread,
							capped: found.capped ?? null,
							lastSuccessAt: found.lastSuccessAt ?? null,
							nextPollAt: found.nextPollAt ?? null,
							backoff: found.backoff ?? null,
							stopped: found.stopped ?? null,
							unexpected: found.unexpected ?? null,
						};
					},
				},
				test: {
					kind: "method",
					description: "Which rule an event with these fields meets, and its action.",
					params: [
						sourceParam,
						{
							name: "fields",
							schema: z.record(z.string(), z.string()),
							type: "{field: text}",
							description: "The event's fields.",
						},
					],
					returns: "{rule, action}",
					call: ([id, fields]) => {
						const found = source(id as string);
						if (!found.rules) throw new ConsoleError("not_found", `${id} has no rules`);
						const specs = found.fieldSpecs ?? [];
						const given = fields as Record<string, string>;
						return {
							rule: firstMatch(found.rules.rules, specs, given)?.id ?? "otherwise",
							action: decideEvent(found.rules, specs, given),
						};
					},
				},
			},
		},
		{
			name: "bluetooth",
			description: "The host's radio.",
			// Exceeds phone wait cap.
			audiences: ["host"],
			members: {
				listen: {
					kind: "method",
					slow: true,
					description: `Everything heard for some seconds, loudest first. Writes nothing. Default ${CONSOLE_LISTEN_DEFAULT_S}.`,
					params: [
						{
							name: "seconds",
							schema: z.number().int().min(1).max(CONSOLE_LISTEN_MAX_S),
							type: `Number up to ${CONSOLE_LISTEN_MAX_S}`,
							description: "How long to listen.",
							optional: true,
						},
					],
					returns: "List<Heard>",
					call: async ([seconds]) => {
						const answer = await readers.bluetoothListen(
							((seconds as number | undefined) ?? CONSOLE_LISTEN_DEFAULT_S) * 1000,
						);
						if (!answer.ok)
							throw new ConsoleError(
								"host_failed",
								`the host daemon could not listen: ${answer.error ?? "no answer"}`,
							);
						const parsed = HostBleScanResultSchema.safeParse(answer.result);
						if (!parsed.success)
							throw new ConsoleError(
								"host_failed",
								"the host daemon answered something unreadable; restart it on a newer build",
							);
						if ("reason" in parsed.data)
							throw new ConsoleError(
								parsed.data.reason,
								parsed.data.reason === "no_radio"
									? "this host has no Bluetooth radio"
									: "the scan failed",
							);
						return parsed.data.devices
							.map((device) => {
								const advert: Advert = {
									...(device.name ? { name: device.name } : {}),
									data: device.data,
									services: device.services,
								};
								return {
									mac: device.mac,
									name: device.name ?? null,
									signal: device.signal,
									family: familyOf(advert),
									...(unsupported(advert) ? { unsupported: true } : {}),
									data: device.data,
									services: device.services,
								};
							})
							.sort((left, right) => right.signal - left.signal);
					},
				},
			},
		},
		{
			name: "definitions",
			description: "Device definitions shipped with this build.",
			catalogue: true,
			audiences: AUDIENCE,
			members: {
				list: {
					kind: "property",
					description: "Every definition.",
					type: "List<Definition>",
					get: () =>
						SHIPPED_DEFINITIONS.map(({ key, family, label, version, models }) => ({
							key,
							family,
							label,
							version,
							models,
						})),
				},
				get: {
					kind: "method",
					description: "One definition in full.",
					params: [definitionParam],
					returns: "Definition",
					call: ([key]) => definition(key as string),
				},
				match: {
					kind: "method",
					description: "Keys of the definitions that read an advert.",
					params: [advertParam],
					returns: "List<Text>",
					call: ([advert]) =>
						SHIPPED_DEFINITIONS.filter((entry) => matches(entry, advert as Advert)).map(
							(entry) => entry.key,
						),
				},
				decode: {
					kind: "method",
					description: "An advert read through one definition.",
					params: [definitionParam, advertParam],
					returns: "Readings",
					call: ([key, advert]) => {
						const found = definition(key as string);
						return Object.fromEntries(
							Object.entries(readingsOf(found, inputsOf(found, advert as Advert))).map(
								([name, value]) => [name, plainOf(value)],
							),
						);
					},
				},
			},
		},
	];
}
