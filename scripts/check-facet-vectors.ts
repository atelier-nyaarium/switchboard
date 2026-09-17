// Regenerates the facet corpus into a temp directory and diffs it against the committed one.
//
// The suite replays the committed corpus, which catches a plugin that moved. This catches the other
// direction: authoring inputs edited in scripts/lib/facetVectorCases.ts without regenerating, and a
// generator that no longer runs at all.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const committed = path.join(root, "tests/fixtures/workspace-facets/vectors.json");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "facet-vectors-check-"));
const result = spawnSync("bun", ["scripts/gen-facet-vectors.ts"], {
	cwd: root,
	env: { ...process.env, FACET_VECTOR_DIR: temp },
	encoding: "utf8",
	stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

const fresh = path.join(temp, "vectors.json");
const same = fs.existsSync(committed) && fs.readFileSync(committed).equals(fs.readFileSync(fresh));
fs.rmSync(temp, { recursive: true, force: true });
if (!same) {
	console.error(
		"tests/fixtures/workspace-facets/vectors.json drifted; run bun scripts/gen-facet-vectors.ts and commit",
	);
	process.exit(1);
}
