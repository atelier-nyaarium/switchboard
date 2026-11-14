import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Advert } from "../shared/ble-recognition.js";
import {
	identifies as identifiesDefinition,
	matches as matchesDefinition,
	SHIPPED_DEFINITIONS,
} from "../shared/device-definitions/index.js";

const VECTORS = JSON.parse(
	fs.readFileSync(path.join(__dirname, "../../tests/fixtures/definition-match/vectors.json"), "utf8"),
) as {
	cases: { case: string; advert: Advert; definition: string | null; identifies: string | null }[];
};

describe("definition matcher vectors", () => {
	it.each(VECTORS.cases)("$case", ({ advert, definition, identifies }) => {
		const matched = SHIPPED_DEFINITIONS.find((entry) => matchesDefinition(entry, advert))?.key ?? null;
		const identified = SHIPPED_DEFINITIONS.find((entry) => identifiesDefinition(entry, advert))?.key ?? null;
		expect(matched).toBe(definition);
		expect(identified).toBe(identifies);
	});
});
