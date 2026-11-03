import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConsoleOpResultSchema } from "../shared/schemasConsoleResults.js";

const PROTOCOL = path.join(
	import.meta.dirname,
	"..",
	"..",
	"android",
	"app",
	"src",
	"main",
	"java",
	"com",
	"atelier_nyaarium",
	"switchboard",
	"proto",
	"Protocol.kt",
);

/**
 * The generator works from an explicit root list, so a schema can join this union and never be
 * generated. The phone then sends an operation it cannot read the answer to, and every other gate
 * passes: the generated file matches what the generator was asked for.
 */
/** Answers no phone code asks for, so no phone type is missing. */
const ALLOWLIST = new Map([
	["ConsoleRegisterResult", "registration is answered over the socket, and no phone code parses this"],
]);

const hasType = (kotlin: string, id: string) =>
	kotlin.includes(`data class ${id}`) || kotlin.includes(`sealed class ${id} `);

describe("every console answer the gateway can send", () => {
	it("has a Kotlin type the phone can parse it with", () => {
		const kotlin = fs.readFileSync(PROTOCOL, "utf8");
		const named = ConsoleOpResultSchema.def.options
			.map((option) => (option as { meta?: () => { id?: string } }).meta?.()?.id)
			.filter((id): id is string => typeof id === "string");

		expect(named.length).toBeGreaterThan(20);
		const missing = named.filter((id) => !ALLOWLIST.has(id) && !hasType(kotlin, id));
		expect(missing).toEqual([]);
	});

	it("would notice a type that is not there", () => {
		const kotlin = fs.readFileSync(PROTOCOL, "utf8");
		expect(hasType(kotlin, "ConsoleDeviceListResult")).toBe(true);
		expect(hasType(kotlin, "ConsoleRoutineListResult")).toBe(true);
		expect(hasType(kotlin, "ConsoleNothingResult")).toBe(false);
	});
});
