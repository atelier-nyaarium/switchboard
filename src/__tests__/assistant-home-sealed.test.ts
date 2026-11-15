import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AssistantHomeSealedSchema, readableSealed } from "../shared/schemasAssistantHome.js";
import { AssistantWatcherRulesSchema } from "../shared/schemasAssistantRules.js";
import { canonicalAutomation } from "../shared/schemasAutomation.js";

// Written by the phone's own encoder: `AssistantHomeSealedFixtureTest.kt`.
const corpus = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/assistant-home/sealed.json"), "utf8"),
) as { cases: { name: string; sealed: unknown }[] };

const carriedOf = (sealed: unknown) => AssistantHomeSealedSchema.parse(sealed).carried;

describe("the sealed home payload as the Kotlin phone encodes it", () => {
	it.each(corpus.cases)("parses: $name", ({ sealed }) => {
		expect(AssistantHomeSealedSchema.safeParse(sealed).error?.issues).toBeUndefined();
	});

	// Remove 2026-11-28 with the carried rules.
	it("names rules for every source, which a Gateway on an older build requires", () => {
		const sources = corpus.cases.flatMap(({ sealed }) => carriedOf(sealed)?.watchers ?? []);

		expect(sources.length).toBeGreaterThan(0);
		expect(sources.filter((source) => !AssistantWatcherRulesSchema.safeParse(source.rules).success)).toEqual([]);
	});

	it("drops a carried automation or service a newer build wrote, and keeps the rest of the move", () => {
		const whole = corpus.cases[0]?.sealed as { carried: Record<string, unknown[]> };
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

		const { sealed, dropped } = readableSealed(newer);

		expect(AssistantHomeSealedSchema.safeParse(newer).success).toBe(false);
		expect(dropped).toBe(2);
		expect(carriedOf(sealed)).toEqual(carriedOf(whole));
	});

	it("carries each event automation, stored without the null the phone sealed for its label", () => {
		const carried = carriedOf(corpus.cases[0]?.sealed)?.automations ?? [];

		expect(carried.map(({ id }) => id)).toEqual(["mentions", "everything", "quiet", "off"]);
		expect(carried.filter(({ automation }) => "label" in canonicalAutomation(automation))).toEqual([]);
	});
});
