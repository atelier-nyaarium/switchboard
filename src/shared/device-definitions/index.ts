import { z } from "zod";
import type { Advert } from "../ble-recognition.js";
import {
	checkExpression,
	ExpressionSchema,
	evaluate,
	type FieldRef,
	known,
	unknown,
	type Value,
} from "../expressions.js";
import { BYTES_MAX, roundTo } from "../field-types.js";
import { AssistantFieldSpecSchema } from "../schemasAssistantRules.js";
import { type BluetoothMatch, INTEGRATIONS } from "../schemasIntegrations.js";
import { neutralizeMarkup } from "../system-reminder.js";
import goveeH5110 from "./govee/h5110.json";

const Key = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]*$/)
	.max(64);
const Hex = z
	.string()
	.regex(/^(?:[0-9a-f]{2})*$/)
	.max(BYTES_MAX * 2);
const Company = z.number().int().min(0).max(0xffff);

export const DefinitionSchema = z.strictObject({
	format: z.literal(1),
	key: Key,
	version: z.number().int().positive(),
	family: z.string().min(1).max(64),
	label: z.string().min(1).max(80),
	models: z.array(z.string().min(1).max(32)).min(1).max(32),
	match: z.strictObject({
		sources: z
			.array(z.strictObject({ company: Company, prefix: Hex, minLength: z.number().int().min(0).max(BYTES_MAX) }))
			.min(1)
			.max(8),
		namePrefix: z.string().max(32).optional(),
		/** Requests scan response. */
		activeScan: z.boolean(),
	}),
	/** Maker data bytes. */
	inputs: z
		.array(z.strictObject({ key: Key, company: Company }))
		.min(1)
		.max(8),
	readings: z
		.array(z.strictObject({ key: Key, spec: AssistantFieldSpecSchema, nodes: ExpressionSchema }))
		.min(1)
		.max(16),
	examples: z
		.array(
			z.strictObject({
				inputs: z.record(Key, Hex),
				readings: z.record(Key, z.union([z.number(), z.string(), z.null()])),
			}),
		)
		.max(32),
	attribution: z.string().max(400).optional(),
});
export type Definition = z.infer<typeof DefinitionSchema>;

export type DefinitionInputs = Readonly<Record<string, string>>;

export function inputsOf(definition: Definition, advert: Advert): DefinitionInputs {
	return Object.fromEntries(
		definition.inputs.flatMap((input) => {
			const data = advert.data[String(input.company)];
			return data === undefined ? [] : [[input.key, data]];
		}),
	);
}

/** Unknown readings never throw. */
export function readingsOf(definition: Definition, inputs: DefinitionInputs): Record<string, Value> {
	const read = (ref: FieldRef): Value => {
		if (ref.source !== "input") return unknown("not an input");
		const value = inputs[ref.key];
		return value === undefined ? unknown("not heard") : known(value);
	};
	return Object.fromEntries(
		definition.readings.map((reading) => {
			const value = evaluate(reading.nodes, read).value;
			const decimals = reading.spec.kind === "number" ? reading.spec.decimals : undefined;
			const rounded =
				value.known && typeof value.value === "number" && decimals !== undefined
					? known(roundTo(value.value, decimals))
					: value;
			return [reading.key, rounded];
		}),
	);
}

export function matches(definition: Definition, advert: Advert): boolean {
	const prefix = definition.match.namePrefix;
	// Present names must match.
	if (prefix !== undefined && advert.name !== undefined && !advert.name.startsWith(prefix)) return false;
	return definition.match.sources.some((source) => {
		const data = advert.data[String(source.company)];
		return data?.startsWith(source.prefix) && data.length / 2 >= source.minLength;
	});
}

const familyMatch = (family: string): BluetoothMatch | undefined =>
	(INTEGRATIONS as Record<string, { bluetooth?: BluetoothMatch }>)[family]?.bluetooth;

export const DEFINITION_MAX_BYTES = 32 * 1024;
const ADDRESS_SHAPED = /(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i;

const stringsOf = (value: unknown): string[] =>
	typeof value === "string"
		? [value]
		: Array.isArray(value)
			? value.flatMap(stringsOf)
			: typeof value === "object" && value !== null
				? Object.values(value).flatMap(stringsOf)
				: [];

/** Validate shipped definitions too. */
function importRefusal(raw: unknown, definition: Definition): string | null {
	if (Buffer.byteLength(JSON.stringify(raw)) > DEFINITION_MAX_BYTES) return "larger than 32 KiB";
	if (stringsOf(raw).some((text) => ADDRESS_SHAPED.test(text))) return "names a device address";
	if (definition.match.namePrefix?.includes("_")) return "a name prefix stops before its last _";
	const labels = [definition.label, ...definition.readings.map((reading) => reading.spec.label)];
	if (labels.some((label) => neutralizeMarkup(label) !== label)) return "a label carries markup";
	return null;
}

export function definitionRefusal(raw: unknown): string | null {
	const parsed = DefinitionSchema.safeParse(raw);
	if (!parsed.success) return parsed.error.issues[0]?.message ?? "not a definition";
	const definition = parsed.data;
	const imported = importRefusal(raw, definition);
	if (imported) return imported;
	const family = familyMatch(definition.family);
	if (!family) return `${definition.family} is not a catalogued family`;
	// Sources narrow family matches.
	for (const source of definition.match.sources) {
		const inside = family.makerData.some(
			(marker) => marker.company === source.company && source.prefix.startsWith(marker.prefix),
		);
		if (!inside) return `source ${source.company} is outside the ${definition.family} family`;
	}
	const inputKeys = new Set(definition.inputs.map((input) => input.key));
	for (const reading of definition.readings) {
		const check = checkExpression(reading.nodes, (ref) =>
			ref.source === "input" && inputKeys.has(ref.key) ? { type: "bytes" } : null,
		);
		if (!check.ok) return `${reading.key}: ${check.issue.message}`;
	}
	for (const [index, example] of definition.examples.entries()) {
		const got = readingsOf(definition, example.inputs);
		for (const [key, want] of Object.entries(example.readings)) {
			const value = got[key];
			const held = value?.known ? value.value : null;
			if (held !== want) return `example ${index}: ${key} reads ${String(held)}, not ${String(want)}`;
		}
	}
	return null;
}

export const SHIPPED_DEFINITIONS: readonly Definition[] = [goveeH5110].map((raw) => {
	const refusal = definitionRefusal(raw);
	if (refusal) throw new Error(`shipped definition refused: ${refusal}`);
	return DefinitionSchema.parse(raw);
});

export function definitionOf(key: string): Definition | null {
	return SHIPPED_DEFINITIONS.find((definition) => definition.key === key) ?? null;
}
