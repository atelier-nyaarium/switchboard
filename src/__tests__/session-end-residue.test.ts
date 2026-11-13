import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const SRC = path.join(import.meta.dirname, "..");
/** A session record's plain removal, which queues no delete of what it leaves. */
const FORGET = /\b(?:presence|sessionStore)\??\.forget\(/;
/** Each plain removal, and why it is not the end. */
const ALLOWED: Record<string, string> = {
	"gateway/composeGateway.ts": "the end's own removal, wired into createSessionEnd",
	"gateway/presence.ts": "the facade the end removes through",
	"gateway/wakeService.ts": "rolls back a record minted in the same call, which nothing launched under",
	"gateway/compose/composeAssistant.ts": "rolls back the assistant's record minted in the same placement",
	"gateway/console/consoleSessionLifecycle.ts": "forgetBlank: an unpicked create's record that names no CLI",
};

describe("a session record is removed through the one end", () => {
	const sources = filesUnder(SRC)
		.filter((file) => file.endsWith(".ts") && !file.includes(`${path.sep}__tests__${path.sep}`))
		.map((file) => ({
			file: path.relative(SRC, file).split(path.sep).join("/"),
			text: readFileSync(file, "utf8"),
		}));
	const removers = sources.filter((source) => FORGET.test(source.text)).map((source) => source.file);

	it("names every file that forgets a record plainly", () => {
		expect(removers.filter((file) => !(file in ALLOWED))).toEqual([]);
	});

	it("allows no file that no longer does", () => {
		expect(Object.keys(ALLOWED).filter((file) => !removers.includes(file))).toEqual([]);
	});
});
