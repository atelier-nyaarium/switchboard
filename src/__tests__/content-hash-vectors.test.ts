import fs from "node:fs";
import path from "node:path";
import { hashContent } from "@nyaa-lexicon/protocol";
import { describe, expect, it } from "vitest";

type Vector = { text: string; hash: string };

const vectors = (
	JSON.parse(
		fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/content-hash/vectors.json"), "utf8"),
	) as { cases: Vector[] }
).cases;

// The phone's ContentHash.kt reads the same file, so the two cannot disagree on a ref's span hash.
describe("Lexicon's content hash, against the shared corpus", () => {
	it.each(vectors.map((v) => [JSON.stringify(v.text), v] as const))("hashes %s", (_name, vector) => {
		expect(hashContent(vector.text)).toBe(vector.hash);
	});
});
