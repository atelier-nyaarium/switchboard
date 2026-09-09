import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..", "..");
const GATEWAY = path.join(ROOT, "src", "gateway");
const SHARED = path.join(ROOT, "src", "shared");
const ANDROID = path.join(ROOT, "android", "app", "src", "main", "java", "com", "atelier_nyaarium", "switchboard");

function filesUnder(dir: string, ext: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) filesUnder(full, ext, acc);
		else if (entry.endsWith(ext)) acc.push(full);
	}
	return acc;
}

const read = (file: string) => fs.readFileSync(file, "utf8");

describe("what holds a routine's authority", () => {
	// A second writer is how two copies of a record start disagreeing, and nothing in an ordinary
	// gate notices one: it compiles, it passes, and the store's rules are simply not applied.
	it("writes a routine only through its own store", () => {
		const writers = filesUnder(GATEWAY, ".ts").filter((file) => {
			if (file.endsWith(path.join("routines", "store.ts"))) return false;
			const source = read(file);
			return /openDurable\([^)]*["'`]routines["'`]/.test(source) || /"routines"\s*,\s*\(durable\)/.test(source);
		});

		// `composeRoutines` opens it, and hands it to `createRoutineStore` rather than writing itself.
		const opening = writers.filter((file) => !/createRoutineStore/.test(read(file)));
		expect(opening).toEqual([]);
	});

	// Two answers to "when does this next run" is the defect that cannot be seen until a phone and a
	// gateway disagree about a Tuesday.
	it("keeps recurrence in one implementation", () => {
		const callers = filesUnder(path.join(ROOT, "src"), ".ts")
			.filter((file) => !file.includes("__tests__"))
			.filter((file) => /nextOccurrence\(/.test(read(file)))
			.map((file) => path.relative(ROOT, file));

		expect(callers.sort()).toEqual([
			"src/gateway/routines/runner.ts",
			"src/shared/routine-recurrence.ts",
			"src/shared/schemasRoutine.ts",
		]);
	});

	// The gateway learns that it handed a nudge over. It never learns whether the work went well, so
	// no answer it gives may read as if it had.
	it("says a routine dispatched and never that it succeeded", () => {
		const wire = read(path.join(SHARED, "schemasRoutine.ts"));
		for (const claim of ["succeeded", "success", "completed", "failed", "outcome"]) {
			expect(wire.includes(claim), `${claim} in the routine wire`).toBe(false);
		}
	});

	// Every panel's occurrence id is read back with `Number`, so a composite one silently becomes
	// NaN and the owner's tap does nothing. The miss panel and the attention panel must agree.
	it("names an occurrence on the wire by its instant alone", () => {
		const stage = read(path.join(GATEWAY, "compose", "composeRoutines.ts"));
		const minted = [...stage.matchAll(/occurrenceId:\s*([^,\n]+)/g)].map((match) => match[1]?.trim());
		expect(minted.length).toBeGreaterThan(1);
		for (const value of minted) expect(value, "how a panel names its occurrence").toMatch(/^String\(/);
	});
});

describe("what a session is told to call", () => {
	const catalog = read(path.join(SHARED, "session-commands.ts"));
	/** The entry keys, which are what both sides address a command by. */
	const declared = [...catalog.matchAll(/^\t(\w+): \{$/gm)].map((match) => match[1] as string);
	const reads = (dir: string): string[] =>
		filesUnder(path.join(ROOT, "src", dir), ".ts")
			.filter((file) => !file.includes("__tests__"))
			.map(read);

	// The nudge told sessions to call a tool that did not exist for three phases, and every gate was
	// green because both halves were tested apart. A command is only whole with both.
	it("is served by a gateway route and registered as a tool, for every entry", () => {
		expect(declared.length).toBeGreaterThan(0);
		for (const command of declared) {
			const entry = `SESSION_COMMANDS.${command}`;
			expect(
				reads("gateway").some((file) => file.includes(entry)),
				`${command}: no gateway side`,
			).toBe(true);
			expect(
				reads("mcp").some((file) => file.includes(entry)),
				`${command}: no tool side`,
			).toBe(true);
		}
	});

	// A tool name spelled into prose is the same defect wearing different clothes.
	it("spells no tool name into the words it sends", () => {
		const tools = [...catalog.matchAll(/tool:\s*"([^"]+)"/g)].map((match) => match[1] as string);
		const nudge = read(path.join(GATEWAY, "routines", "execution.ts"));
		for (const tool of tools) expect(nudge.includes(`Call ${tool}`), `${tool} spelled out`).toBe(false);
		expect(nudge).toMatch(/SESSION_COMMANDS\.\w+\.tool/);
	});
});

describe("what the phone does not hold", () => {
	const phone = filesUnder(ANDROID, ".kt")
		.filter((file) => !file.includes(`${path.sep}proto${path.sep}`))
		.filter((file) => /[Rr]outine/.test(path.basename(file)) || /routineOps|RoutineState/.test(read(file)));

	// The sandbox stands in for a gateway, so its canned answers are that gateway's word rather
	// than a phone's sum.
	const ALLOWLIST: Record<string, string> = {
		"SandboxGateways.kt": "canned gateway answers, which is the side allowed to decide these",
	};

	// Every one of these is the gateway's answer to read. A phone that computed one would disagree
	// with the gateway on exactly the days that matter.
	it("computes no recurrence, no deadline and no miss of its own", () => {
		const forbidden: Array<[RegExp, string]> = [
			[/GRACE|twelve hours|12 \* 60 \* 60/, "a deadline of its own"],
			[/weekInterval\s*[*%]/, "recurrence arithmetic"],
			[/\bmissed\s*=\s*(?!row\b|it\b|null\b)/, "a miss it decided"],
			[/scheduleNextRun|fireRoutine|runRoutineNow\(/, "a fire it starts"],
		];
		const found: string[] = [];
		for (const file of phone) {
			const name = path.basename(file);
			if (ALLOWLIST[name]) continue;
			const source = read(file);
			for (const [pattern, what] of forbidden) {
				if (pattern.test(source)) found.push(`${name}: ${what}`);
			}
		}
		expect(found).toEqual([]);
	});

	// The schedule is shown as the gateway holds it; only an instant the gateway named is converted.
	// A schedule converted here would read differently in every airport for a rule that did not move.
	it("converts an instant and never the rule", () => {
		const text = read(path.join(ANDROID, "routines", "RoutineText.kt"));
		const scheduleLine = /internal fun scheduleLine[\s\S]*?\n}\n/.exec(text)?.[0];
		expect(scheduleLine).toBeDefined();
		expect(scheduleLine).not.toMatch(/absoluteTimeText|ZoneId/);

		// Converting at all means being handed the zone, so the signature is the whole rule.
		const converting = [...text.matchAll(/internal fun (\w+)\([^)]*java\.time\.ZoneId/g)].map((m) => m[1]);
		expect(converting.sort()).toEqual(["attentionLine", "lastRunLine", "missLine", "nextRunLine", "reviewLine"]);
	});
});
