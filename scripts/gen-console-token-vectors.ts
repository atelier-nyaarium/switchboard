import fs from "node:fs";
import path from "node:path";
import { lexConsole, lexConsoleText, lexScript, quoteConsoleString } from "../src/shared/live-console-grammar.js";
import {
	CONSOLE_SCRIPT_CASES,
	CONSOLE_STRING_CASES,
	CONSOLE_TEXT_CASES,
	CONSOLE_TOKEN_CASES,
} from "./lib/consoleTokenCases.js";

const ABOUT =
	"The one lexer's tokens, as src/shared/live-console-grammar.ts reads each input: " +
	"`cases` as an expression, `texts` as a text (a string's body with no quote), `scripts` as a script; " +
	"`strings` is each constant as `quoteConsoleString` writes it. " +
	"The phone's ConsoleTokens.kt replays these cases. Offsets are UTF-16 code units, end-exclusive. " +
	"Regenerate with `bun scripts/gen-console-token-vectors.ts`.";

const out = path.resolve(import.meta.dirname, "../tests/fixtures/live-console-tokens");
const cases = CONSOLE_TOKEN_CASES.map(([name, input]) => ({ name, input, tokens: lexConsole(input) }));
const texts = CONSOLE_TEXT_CASES.map(([name, input]) => ({ name, input, parts: lexConsoleText(input) }));
const scripts = CONSOLE_SCRIPT_CASES.map(([name, input]) => ({ name, input, tokens: lexScript(input) }));
const strings = CONSOLE_STRING_CASES.map(([name, input]) => ({ name, input, quoted: quoteConsoleString(input) }));
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, "vectors.json");
// Keep fixture bytes ASCII.
const ascii = JSON.stringify({ _comment: ABOUT, cases, texts, scripts, strings }, null, "\t").replace(
	/[^\x20-\x7e\n\t]/g,
	(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
);
fs.writeFileSync(file, `${ascii}\n`);
const formatted = Bun.spawnSync(["bunx", "biome", "format", "--write", file]);
if (formatted.exitCode !== 0) {
	process.stderr.write(formatted.stderr.toString());
	process.exit(1);
}
process.stdout.write(`Wrote ${file} (${cases.length + texts.length + scripts.length + strings.length} cases).\n`);
