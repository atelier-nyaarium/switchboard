import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alertsFor, speaksFor } from "../shared/phone-hold-rules.js";
import { holdStanding } from "../shared/schemasPhoneHold.js";

interface Vector {
	name: string;
	hold: { holder: string; claimedAt: number } | null;
	self: string;
	now: number;
	visible: boolean;
	todayRule: boolean;
	expect: { standing: string; speaks: boolean; alerts: boolean };
}

const corpus = JSON.parse(
	readFileSync(join(import.meta.dirname, "../../tests/fixtures/phone-hold/vectors.json"), "utf8"),
) as { windowMs: number; cases: Vector[] };

describe("phone hold rules", () => {
	for (const vector of corpus.cases) {
		it(vector.name, () => {
			const input = { ...vector, windowMs: corpus.windowMs };
			expect(holdStanding(vector.hold, vector.now, corpus.windowMs)).toBe(vector.expect.standing);
			expect(speaksFor(input)).toBe(vector.expect.speaks);
			expect(alertsFor(input)).toBe(vector.expect.alerts);
		});
	}
});
