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

/** The one re-provision. */
const CLEAR = "ChatRepositoryDomainLink.kt";

/** Allowed fence constructors. */
const CONSTRUCTS: Record<string, string> = {
	"ChatRepository.kt": "the repository's one fence",
};

// A defaulted generation never refuses.
const DEFAULTED = /\bgeneration:\s*Long\s*=\s*this\.generation\b/;

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

function code(source: string): string {
	return source
		.split("\n")
		.filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
		.join("\n");
}

/** The clearAll body. */
function clearBody(source: string): string | null {
	const lines = code(source).split("\n");
	const open = lines.findIndex((line) => line.startsWith("suspend fun ChatRepository.clearAll()"));
	if (open < 0) return null;
	const close = lines.findIndex((line, at) => at > open && line === "}");
	return close < 0 ? null : lines.slice(open, close).join("\n");
}

/** Wipe steps in run order. */
const STEPS = [
	/\bNonCancellable\b/,
	/^wipes\.withLock \{$/,
	/^provision\.advance\(\)$/,
	/^try \{$/,
	/\bforgetHome \{ identity\.clear\(\) \}/,
	/\bin clearedOnReprovision\b/,
	/\bpurgeAll\(/,
	/\bChatState\(provisioned = false\)/,
	/^identity\.clear\(\)$/,
	/^\} finally \{$/,
	/^provision\.settle\(\)$/,
];

// Another coroutine outlives the fence.
const DETACHED = /\b(?:launch|async)\s*[({]/;

/** Unfenced wipe reason, or null. */
function clearFault(source: string): string | null {
	const body = clearBody(source);
	if (body === null) return "clearAll not found";
	const lines = body.split("\n").map((line) => line.trim());
	const first = STEPS.map((step) => lines.findIndex((line) => step.test(line)));
	const last = STEPS.map((step) => lines.findLastIndex((line) => step.test(line)));
	if (first.some((at) => at < 0)) return "a step is missing";
	// Each step ends before the next begins.
	for (let at = 1; at < STEPS.length; at++) if (last[at - 1] >= first[at]) return "steps out of order";
	if (DETACHED.test(body)) return "a step runs detached";
	// Nothing runs between the lock and the fence, nor after the fence reopens.
	if (first[2] !== first[1] + 1) return "the fence is not closed first";
	const after = lines.slice(last[STEPS.length - 1] + 1);
	if (after.some((line) => line !== "}" && line !== "linkChanged()")) return "work follows the fence";
	return null;
}

function relative(file: string): string {
	return path.relative(ANDROID_MAIN, file);
}

describe("A re-provision", () => {
	const files = kotlinFiles(ANDROID_MAIN).map((file) => ({ file, text: code(fs.readFileSync(file, "utf8")) }));

	it("closes the fence first, wipes whole and one at a time, and reopens it last", () => {
		expect(clearFault(fs.readFileSync(path.join(ANDROID_MAIN, CLEAR), "utf8"))).toBeNull();
	});

	it("is the only thing that moves the fence", () => {
		const movers = files
			.filter(({ text }) => /\bprovision\.(?:advance|settle)\(\)/.test(text))
			.map(({ file }) => relative(file));
		expect(movers).toEqual([CLEAR]);
	});

	it("fences every class with the repository's one fence", () => {
		const builders = files
			.filter(({ text }) => /\bProvisionFence\(\)/.test(text))
			.map(({ file }) => relative(file));
		expect(builders.sort()).toEqual(Object.keys(CONSTRUCTS).sort());
	});

	it("is never checked against a generation the callee read for itself", () => {
		const offenders = files.filter(({ text }) => DEFAULTED.test(text)).map(({ file }) => relative(file));
		expect(offenders).toEqual([]);
	});

	it("tells a fenced wipe from an unfenced one", () => {
		const fenced = [
			"suspend fun ChatRepository.clearAll() = withContext(Dispatchers.IO + NonCancellable) {",
			"\twipes.withLock {",
			"\t\tprovision.advance()",
			"\t\ttry {",
			"\t\t\tassistantOps.forgetHome { identity.clear() }",
			"\t\t\tfor (cache in clearedOnReprovision) cache.clearInMemory()",
			"\t\t\tstts.purgeAll()",
			"\t\t\t_state.update { ChatState(provisioned = false) }",
			"\t\t\tidentity.clear()",
			"\t\t} finally {",
			"\t\t\tprovision.settle()",
			"\t\t}",
			"\t}",
			"}",
		];
		const moved = (from: number, to: number) => {
			const lines = [...fenced];
			lines.splice(to, 0, ...lines.splice(from, 1));
			return lines.join("\n");
		};
		const added = (at: number, line: string) => [...fenced.slice(0, at), line, ...fenced.slice(at)].join("\n");
		expect(clearFault(fenced.join("\n"))).toBeNull();
		expect(clearFault(moved(5, 7))).toBe("steps out of order");
		expect(clearFault(added(2, "\t\tdrain.stopAndJoin()"))).toBe("the fence is not closed first");
		expect(clearFault(added(11, "\t\t\tstts.purgeAll()"))).toBe("steps out of order");
		expect(clearFault(added(12, "\t\tboard.clearInMemory()"))).toBe("work follows the fence");
		expect(clearFault(added(5, "\t\t\trepoScope.launch { vault.wipe() }"))).toBe("a step runs detached");
		expect(clearFault(fenced.filter((line) => !line.includes("finally")).join("\n"))).toBe("a step is missing");
		expect(clearFault(fenced.join("\n").replace(" + NonCancellable", ""))).toBe("a step is missing");
		// Excludes text after the function.
		expect(clearFault(`${fenced.join("\n")}\nfun other() { board.clearInMemory() }`)).toBeNull();
		expect(DEFAULTED.test("generation: Long = this.generation,")).toBe(true);
		expect(DEFAULTED.test("generation: Long,")).toBe(false);
	});
});
