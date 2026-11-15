import fs from "node:fs";
import path from "node:path";
import { lexConsole } from "../src/shared/live-console-grammar.js";

const ABOUT =
	"The live console's tokens, as src/shared/live-console-grammar.ts lexes each input. " +
	"The phone's ConsoleTokens.kt is pinned to it. Offsets are UTF-16 code units, end-exclusive. " +
	"Regenerate with `bun scripts/gen-console-token-vectors.ts`.";

const INPUTS: [string, string][] = [
	["a path, a call and an index", 'sensors.read("Freezer").readings[0]'],
	["a minus is never part of a number", "5-3 -(2-5)"],
	["a fraction needs a digit after its point", "1.5.x 3. .5"],
	["both quotes, and an escaped quote", '\'single\' + "dbl\\"q"'],
	["known escapes decode, an unknown one keeps its letter", '"a\\nb\\tc\\\\d\\x"'],
	["an open string runs to the end", '"Free'],
	["a backslash at the end stays", '"ab\\'],
	["every operator", "== != ! = + - * /"],
	["a dict of a list of keywords", "{k: [1, true, null]}"],
	["names take digits after the first letter", "a_b9 _x 9ab"],
	["an unknown character is an error token", "x # y"],
	["a surrogate pair inside a string, and outside one", '"\u{1F600}" \u{1F600}'],
	["only space, tab, return and newline are whitespace", `\t\r\n a${String.fromCharCode(0xa0)}b`],
	["a keyword must stand alone", "trueish true_ null"],
	["an assignment reads as tokens", "outside = sensors.list"],
	["a semicolon separates statements", "a = 1; a + 2;\n b"],
];

const out = path.resolve(import.meta.dirname, "../tests/fixtures/live-console-tokens");
const cases = INPUTS.map(([name, input]) => ({ name, input, tokens: lexConsole(input) }));
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
