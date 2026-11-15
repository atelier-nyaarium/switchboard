import fs from "node:fs";
import path from "node:path";
import { lexConsole } from "../src/shared/live-console-grammar.js";
import { CONSOLE_TOKEN_CASES } from "./lib/consoleTokenCases.js";

const ABOUT =
	"The live console's tokens, as src/shared/live-console-grammar.ts lexes each input. " +
	"The phone's ConsoleTokens.kt replays these cases. Offsets are UTF-16 code units, end-exclusive. " +
	"Regenerate with `bun scripts/gen-console-token-vectors.ts`.";

const out = path.resolve(import.meta.dirname, "../tests/fixtures/live-console-tokens");
const cases = CONSOLE_TOKEN_CASES.map(([name, input]) => ({ name, input, tokens: lexConsole(input) }));
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
