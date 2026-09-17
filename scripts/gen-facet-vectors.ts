// Writes tests/fixtures/workspace-facets/vectors.json: the workspace drill-in rules as the plugin
// answers them, over invented inputs.
//
// src/__tests__/workspace-facet-vectors.test.ts replays the corpus against the plugin, and
// SandboxFacetVectorsTest.kt against the phone's sandbox rules, so neither side can hold a rule the
// other does not.

import fs from "node:fs";
import path from "node:path";
import { facetAnswerOf, removeFacetWorkspaces } from "../src/testing/facetVectors.js";
import { FACET_CASES } from "./lib/facetVectorCases.js";

const ABOUT =
	"The workspace drill-in rules, as the plugin answers them over invented inputs. " +
	"src/mcp/workspace/facets.ts is the authority and the phone's SandboxFacetRules.kt is pinned to it. " +
	"Each case declares its modules, symbols and index rows; `answer` is the structure both sides reach. " +
	"A row's columns, line text and paint are left out, since those come from the file rather than a rule, " +
	"and tests/fixtures/code-spans/vectors.json already pins the paint. " +
	"Regenerate with `bun scripts/gen-facet-vectors.ts`.";

const out = process.env.FACET_VECTOR_DIR ?? path.resolve(import.meta.dirname, "../tests/fixtures/workspace-facets");
const cases = [];
for (const vector of FACET_CASES) cases.push({ ...vector, answer: await facetAnswerOf(vector) });
removeFacetWorkspaces();
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, "vectors.json");
fs.writeFileSync(file, `${JSON.stringify({ _comment: ABOUT, cases }, null, "\t")}\n`);
// Formatted here, or the committed file and a regeneration of it differ by layout alone.
const formatted = Bun.spawnSync(["bunx", "biome", "format", "--write", file]);
if (formatted.exitCode !== 0) {
	console.error(new TextDecoder().decode(formatted.stderr));
	process.exit(formatted.exitCode);
}
console.log(`wrote ${cases.length} facet vectors to ${out}`);
