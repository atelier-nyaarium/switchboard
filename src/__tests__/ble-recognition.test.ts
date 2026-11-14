import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Advert, familyOf } from "../shared/ble-recognition.js";

const vectors = JSON.parse(
	fs.readFileSync(path.join(__dirname, "../../tests/fixtures/ble-recognition/vectors.json"), "utf8"),
) as { cases: Array<{ case: string; advert: Advert; family: string | null }> };

describe("Bluetooth recognition", () => {
	it("replays the shared recognition vectors", () => {
		for (const row of vectors.cases) expect(familyOf(row.advert), row.case).toBe(row.family);
	});
});
