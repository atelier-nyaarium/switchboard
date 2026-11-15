import fs from "node:fs";
import path from "node:path";
import { scanHoles } from "../src/shared/text-holes.js";
import { TEXT_HOLE_CASES } from "./lib/textHoleCases.js";

const ABOUT =
	"Text with holes, as src/shared/text-holes.ts scans each input. " +
	"The phone's twin replays these cases. Offsets are UTF-16 code units, end-exclusive. " +
	"Regenerate with `bun scripts/gen-text-hole-vectors.ts`.";

const out = path.resolve(import.meta.dirname, "../tests/fixtures/text-holes");
const cases = TEXT_HOLE_CASES.map(([name, input]) => ({ name, input, parts: scanHoles(input) }));
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, "vectors.json");
// Keep fixture bytes ASCII.
const ascii = JSON.stringify({ _comment: ABOUT, cases }, null, "\t").replace(
	/[^\x20-\x7e\n\t]/g,
	(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
);
fs.writeFileSync(file, `${ascii}\n`);
const formatted = Bun.spawnSync(["bunx", "biome", "format", "--write", file]);
if (formatted.exitCode !== 0) {
	process.stderr.write(formatted.stderr.toString());
	process.exit(1);
}
process.stdout.write(`Wrote ${file} (${cases.length} cases).\n`);
