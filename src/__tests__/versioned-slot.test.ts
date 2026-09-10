import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { foldVersionedSlot, type HeldLineage, type PlaneLineage } from "../shared/versioned-slot.js";

type Vector = {
	name: string;
	held: HeldLineage;
	incoming: PlaneLineage;
	observedAt: number;
	expected: { kind: string; lineageChanged?: boolean };
};

const vectors = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/versioned-slot/vectors.json"), "utf8"),
) as { cases: Vector[] };

describe("versioned slot fold", () => {
	for (const vector of vectors.cases) {
		it(vector.name, () => {
			const fold = foldVersionedSlot(vector.held, vector.incoming, vector.observedAt);
			expect(fold.kind).toBe(vector.expected.kind);
			if (fold.kind === "take") expect(fold.lineageChanged).toBe(vector.expected.lineageChanged);
		});
	}
});
