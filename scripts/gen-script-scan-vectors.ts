import fs from "node:fs";
import path from "node:path";
import { scanScript } from "../src/shared/script-scan.js";
import { SCRIPT_SCAN_CASES } from "./lib/scriptScanCases.js";

const ABOUT =
	"A script's pieces, as src/shared/script-scan.ts scans each input. " +
	"The phone's twin replays these cases. Offsets are UTF-16 code units, end-exclusive. " +
	"Regenerate with `bun scripts/gen-script-scan-vectors.ts`.";

const out = path.resolve(import.meta.dirname, "../tests/fixtures/script-scan");
const cases = SCRIPT_SCAN_CASES.map(([name, input]) => ({ name, input, pieces: scanScript(input) }));
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
