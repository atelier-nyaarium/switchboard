import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ANDROID_MAIN = path.join(
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
);

/** A Gateway's answer, as it arrives and as it is held. */
const READ_TYPES = [
	"GatewayList",
	"Lookup",
	"ListAnswer",
	"AssistantWord",
	"AssistantRead",
	"UsedBy",
	"ListEmpty",
	"Served",
	"HomeSources",
	"EditStanding",
];
const TYPES = READ_TYPES.join("|");

/** Where what a Gateway serves is decided. */
const CONTEXT = "assistant/AutomationContext.kt";

/** Exempt files per rule, with reasons. */
const ALLOWED: Record<string, Record<string, string>> = {
	members: {},
	casts: {},
	elses: {},
	deleted: {},
	serves: {},
};

// R1: a member on the interface reads every answer as one.
const SEALED = new RegExp(`^(?:internal\\s+)?sealed interface (${TYPES})\\b`);

// R2: a cast with a default reads every other answer as none.
const CAST = new RegExp(`as\\?\\s*(?:${TYPES})\\.\\w+`, "g");
const VARIANT_IMPORT = new RegExp(`^import\\s+[\\w.]+\\.(?:${TYPES})\\.\\w+`, "gm");

// R3: a branch label naming one of the types.
const TYPED_LABEL = new RegExp(`^(?:!?is\\s+)?(?:${TYPES})\\.`);

// R4: the flattening reads, gone for good.
const DELETED = new RegExp(
	[
		"\\blistedRows\\b",
		"\\.found\\(\\)",
		"\\bassistantOn\\(",
		"\\bofferOn\\(",
		"\\beditorSources\\(",
		`\\bfun\\s+(?:<[^>]*>\\s+)?(?:${TYPES})(?:<[^>]*>)?\\.\\w+\\([^)]*\\)\\s*:\\s*[^=\\n{]*\\?\\s*[={]`,
		"\\boffer:\\s*AutomationOffer\\s*=",
	].join("|"),
	"g",
);

// R5: what a Gateway serves, read anywhere but its context.
const SERVES = /(\bval\s+)?\bautomationServes\b(\s*=(?!=))?/g;

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

/** Source with strings and comments blanked. */
function code(source: string): string {
	return source
		.replace(/"""[\s\S]*?"""/g, '""')
		.replace(/"(?:\\.|[^"\\\n])*"/g, '""')
		.replace(/'(?:\\.|[^'\\\n])'/g, "' '")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");
}

/** Members declared on a read interface itself, not on a variant. */
function sharedMembers(source: string): string[] {
	const lines = code(source).split("\n");
	const members: string[] = [];
	lines.forEach((line, start) => {
		if (!SEALED.test(line) || !line.trimEnd().endsWith("{")) return;
		for (const inner of lines.slice(start + 1)) {
			if (inner.startsWith("}")) break;
			if (/^\t(?:override\s+)?(?:val|var|fun)\b/.test(inner)) members.push(inner.trim());
		}
	});
	return members;
}

function castsIn(source: string): number {
	const text = code(source);
	return [...text.matchAll(CAST)].length + [...text.matchAll(VARIANT_IMPORT)].length;
}

/** Top-level branch labels of each `when` block. */
function whenBlocks(source: string): string[][] {
	const text = code(source);
	const blocks: string[][] = [];
	for (const opened of text.matchAll(/\bwhen\b\s*(?:\([^{}]*\))?\s*\{/g)) {
		let depth = 1;
		let line = "";
		let lineDepth = 1;
		const labels: string[] = [];
		const close = (end: string) => {
			const arrow = end.indexOf("->");
			if (lineDepth === 1 && arrow > 0) labels.push(end.slice(0, arrow).trim());
		};
		for (let at = (opened.index ?? 0) + opened[0].length; at < text.length && depth > 0; at++) {
			const char = text[at];
			if (char === "\n") {
				close(line);
				line = "";
				lineDepth = depth;
				continue;
			}
			if (char === "{") depth++;
			if (char === "}") depth--;
			if (depth > 0 && (depth === 1 || char !== "{")) line += depth === 1 ? char : " ";
		}
		close(line);
		blocks.push(labels);
	}
	return blocks;
}

function typedElses(source: string): number {
	return whenBlocks(source).filter((labels) => {
		const typed = labels.some((label) => label.split(",").some((part) => TYPED_LABEL.test(part.trim())));
		return typed && labels.some((label) => label === "else");
	}).length;
}

function deletedIn(source: string): number {
	return [...code(source).matchAll(DELETED)].length;
}

/** Reads, writes and declarations of `automationServes`. */
function servesIn(source: string): { reads: number; writes: number; declared: number } {
	const all = [...code(source).matchAll(SERVES)];
	const declared = all.filter((hit) => hit[1] !== undefined).length;
	const writes = all.filter((hit) => hit[1] === undefined && hit[2] !== undefined).length;
	return { reads: all.length - writes - declared, writes, declared };
}

describe("A Gateway's answer", () => {
	const files = kotlinFiles(ANDROID_MAIN).map((file) => ({
		name: path.relative(ANDROID_MAIN, file),
		text: fs.readFileSync(file, "utf8"),
	}));
	const offenders = (rule: string, hit: (text: string) => boolean) =>
		files.filter(({ name, text }) => !(name in ALLOWED[rule]) && hit(text)).map(({ name }) => name);

	it("holds its rows and state on a variant alone", () => {
		expect(offenders("members", (text) => sharedMembers(text).length > 0)).toEqual([]);
	});

	it("is never cast to one variant with a default for the rest", () => {
		expect(offenders("casts", (text) => castsIn(text) > 0)).toEqual([]);
	});

	it("is folded with every answer named, never an else", () => {
		expect(offenders("elses", (text) => typedElses(text) > 0)).toEqual([]);
	});

	it("has no flattening read left to come back", () => {
		expect(offenders("deleted", (text) => deletedIn(text) > 0)).toEqual([]);
	});

	it("says what it serves through the automation context alone", () => {
		const misplaced = files
			.filter(({ name }) => !(name in ALLOWED.serves))
			.flatMap(({ name, text }) => {
				const { reads, writes, declared } = servesIn(text);
				return [
					reads > 0 && name !== CONTEXT ? `${name}: read` : null,
					writes > 0 && name !== "AutomationOps.kt" ? `${name}: write` : null,
					declared > 0 && name !== "GatewayRegistry.kt" ? `${name}: declared` : null,
				].filter((line): line is string => line !== null);
			});
		expect(misplaced).toEqual([]);
	});

	it("tells each refused shape from an accepted one", () => {
		expect(
			sharedMembers("sealed interface GatewayList<out T> {\n\tval rows: List<T> get() = emptyList()\n}"),
		).toHaveLength(1);
		expect(
			sharedMembers(
				"internal sealed interface Served {\n\tdata class Known(val offer: AutomationOffer) : Served\n}",
			),
		).toEqual([]);

		expect(castsIn("(entry.peers as? GatewayList.Listed)?.rows.orEmpty()")).toBe(1);
		expect(castsIn("(word as? AssistantRead.Answered)?.state")).toBe(1);
		expect(castsIn("import com.atelier_nyaarium.switchboard.Lookup.Found")).toBe(1);
		expect(castsIn("(read as? GatewayRead.Fresh)?.value")).toBe(0);
		expect(castsIn('val label = "as? Lookup.Found"')).toBe(0);

		expect(typedElses("when (list) {\n\tis GatewayList.Listed -> list.rows\n\telse -> emptyList()\n}")).toBe(1);
		expect(typedElses("when (held) {\n\tnull, Lookup.Gone -> 1\n\telse -> 0\n}")).toBe(1);
		expect(
			typedElses(
				"when (list) {\n\tis GatewayList.Listed -> list.rows\n\tGatewayList.Unread, GatewayList.Unreachable, GatewayList.NotServed -> emptyList()\n}",
			),
		).toBe(0);
		expect(typedElses("when (count) {\n\t1 -> one()\n\telse -> many()\n}")).toBe(0);
		expect(
			typedElses(
				"when (read) {\n\tis AssistantRead.Answered -> rows.map { when (it) { 1 -> a\n else -> b } }\n\tAssistantRead.Reading, AssistantRead.Refused -> none\n}",
			),
		).toBe(0);

		expect(deletedIn("entry.routines.listedRows()")).toBe(1);
		expect(deletedIn("state.gateways.policyOn(g, id).found()?.name")).toBe(1);
		expect(deletedIn("state.gateways.assistantOn(home)?.offered")).toBe(1);
		expect(deletedIn("fun <T> Lookup<T>.row(): T? = null")).toBe(1);
		expect(deletedIn("internal fun editable(row: AutomationRow, offer: AutomationOffer = legacy): Boolean")).toBe(
			1,
		);
		expect(deletedIn("val assistantOn: Boolean get() = roleHeld")).toBe(0);
		expect(deletedIn("fun <T> GatewayList<T>.lookup(match: (T) -> Boolean): Lookup<T> = when (this) {")).toBe(0);

		expect(servesIn("offerOf(entry.automationServes, away)")).toEqual({ reads: 1, writes: 0, declared: 0 });
		expect(servesIn("after.copy(automationServes = listedServes)")).toEqual({ reads: 0, writes: 1, declared: 0 });
		expect(servesIn("val automationServes: AutomationServes? = null,")).toEqual({
			reads: 0,
			writes: 0,
			declared: 1,
		});
		expect(servesIn("if (it.automationServes == null) legacy")).toEqual({ reads: 1, writes: 0, declared: 0 });
	});
});
