import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { AssistantHomeSealedSchema, readableSealed } from "../shared/schemasAssistantHome.js";
import { AssistantWatcherRulesSchema } from "../shared/schemasAssistantRules.js";
import { canonicalAutomation } from "../shared/schemasAutomation.js";
import { PHONE_CAPABILITIES } from "../shared/schemasPhoneCapabilities.js";

// Written by PhoneEncodedFixtureTest.kt
const corpus = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/phone-encoded/cases.json"), "utf8"),
) as { cases: { name: string; schema: string; value: unknown }[] };

const SCHEMAS: Record<string, z.ZodType> = {
	AssistantHomeSealed: AssistantHomeSealedSchema,
	PhoneStatusAnswer: PHONE_CAPABILITIES.status.answer,
};

const sealed = corpus.cases.filter((entry) => entry.schema === "AssistantHomeSealed").map((entry) => entry.value);
const carriedOf = (value: unknown) => AssistantHomeSealedSchema.parse(value).carried;

describe("what the Kotlin phone encodes", () => {
	it.each(corpus.cases)("parses as $schema: $name", ({ schema, value }) => {
		expect(SCHEMAS[schema]?.safeParse(value).error?.issues).toBeUndefined();
		expect(Object.keys(SCHEMAS)).toContain(schema);
	});

	it("writes a null only where its field is required", () => {
		const nulls = (value: unknown, at: string): string[] => {
			if (value === null) return [at];
			if (Array.isArray(value)) return value.flatMap((item) => nulls(item, at));
			if (typeof value !== "object") return [];
			return Object.entries(value as Record<string, unknown>).flatMap(([key, held]) => nulls(held, key));
		};

		expect([...new Set(corpus.cases.flatMap((entry) => nulls(entry.value, entry.schema)))].sort()).toEqual([
			"carried",
			"grant",
			"holder",
		]);
	});

	// Remove 2026-11-28 with the carried rules.
	it("names rules for every source, which a Gateway on an older build requires", () => {
		const sources = sealed.flatMap((value) => carriedOf(value)?.watchers ?? []);

		expect(sources.length).toBeGreaterThan(0);
		expect(sources.filter((source) => !AssistantWatcherRulesSchema.safeParse(source.rules).success)).toEqual([]);
	});

	it("drops a carried automation or service a newer build wrote, and keeps the rest of the move", () => {
		const whole = sealed[0] as { carried: Record<string, unknown[]> };
		const { carried, ...rest } = whole;
		const newer = {
			...rest,
			carried: {
				...carried,
				automations: [
					...(carried.automations ?? []),
					{
						id: "newer",
						automation: {
							enabled: true,
							trigger: { kind: "event", source: "github", conditions: [] },
							actions: [{ kind: "switch_device", device: "lamp" }],
						},
					},
				],
				integrations: [...(carried.integrations ?? []), { id: "service-of-a-newer-build", grant: null }],
			},
		};

		const { sealed: readable, dropped } = readableSealed(newer);

		expect(AssistantHomeSealedSchema.safeParse(newer).success).toBe(false);
		expect(dropped).toBe(2);
		expect(carriedOf(readable)).toEqual(carriedOf(whole));
	});

	it("carries each event automation as the store keeps it", () => {
		const carried = carriedOf(sealed[0])?.automations ?? [];

		expect(carried.map(({ id }) => id)).toEqual(["mentions", "everything", "quiet", "off"]);
		expect(carried.map(({ automation }) => canonicalAutomation(automation))).toEqual(
			carried.map(({ automation }) => automation),
		);
	});
});
