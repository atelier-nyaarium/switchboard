import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { frame, unframe } from "../gateway/devices/kasa/codec.js";
import { type KasaVector, kasaVectors } from "../gateway/devices/kasa/vectors.js";

const FIXTURE = path.resolve(import.meta.dirname, "../../tests/fixtures/kasa-codec/vectors.json");

describe("the Kasa vectors the phone replays", () => {
	it("match what the codec frames now, so an edit regenerates them", () => {
		const committed = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as { vectors: KasaVector[] };
		expect(committed.vectors).toEqual(kasaVectors());
	});

	it("round-trip through the codec", () => {
		for (const vector of kasaVectors()) {
			const bytes = Uint8Array.from(Buffer.from(vector.frame, "hex"));
			expect(Buffer.from(frame(vector.plaintext)).toString("hex")).toBe(vector.frame);
			expect(unframe(bytes)).toBe(vector.plaintext);
		}
	});
});
