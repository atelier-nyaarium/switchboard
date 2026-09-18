import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session } from "@nyaa-lexicon/client";
import { composeSymbolId, hashContent } from "@nyaa-lexicon/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerWorkspaceOp, type HandlerDeps } from "../mcp/workspace/handlers.js";
import { CODE_TOKENS } from "../shared/schemasWorkspace.js";
import {
	type FileDestination,
	type FileMutation,
	type FileStateAnswer,
	MAX_RAW_EDIT_BYTES,
	type TreeAnswer,
	type WorkspaceOp,
	type WorkspaceOpResult,
} from "../shared/workspace-op.js";

////////////////////////////////
//  Functions & Helpers

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wshandlers-")));
	roots.push(root);
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.writeFileSync(path.join(root, "src", "app.ts"), "export const x = 1;\n");
	fs.writeFileSync(path.join(root, ".env"), "TOKEN=secret\n");
	fs.writeFileSync(path.join(root, ".env.example"), "TOKEN=\n");
	fs.writeFileSync(path.join(root, "README.md"), "# hi\n");
	return root;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** "hi" as UTF-16LE behind its byte order mark, built from bytes so no invisible character sits in source. */
const UTF16_HI = Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);

/** Deliberately throws: an op needing no index must not open a session. */
const unopened = async (): Promise<Session> => {
	throw new Error("the daemon was asked");
};

const SPAN = { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } };

const SERVED_ID = "lexicon typescript src/app.ts f().";
const WITHHELD_ID = "lexicon typescript .env f().";

function deps(root: string, session: () => Promise<Session> = unopened): HandlerDeps {
	return { root: () => root, session };
}

function ask(root: string, op: WorkspaceOp, session?: () => Promise<Session>): Promise<WorkspaceOpResult> {
	return answerWorkspaceOp(deps(root, session), op);
}

function tree(result: WorkspaceOpResult): TreeAnswer {
	if (!result.ok || result.answer.kind !== "tree") throw new Error(`not a tree: ${JSON.stringify(result)}`);
	return result.answer;
}

/** Only the methods a handler reaches, so an unused one throwing proves it was not reached. */
function fakeSession(answers: Partial<Record<string, unknown>>): () => Promise<Session> {
	return async () =>
		({
			outlineModule: async () => answers.outlineModule ?? [],
			symbolSource: async () => answers.symbolSource,
			describe: async () => answers.describe ?? null,
			recallAnswer: async () => answers.recallAnswer ?? [],
			findReferences: async () => answers.findReferences ?? { references: [], total: 0, truncated: false },
			usesFrom: async () => answers.usesFrom ?? { references: [], total: 0, truncated: false },
			findComments: async () => answers.findComments ?? { comments: [], total: 0, truncated: false },
			moduleFacts: async () => answers.moduleFacts,
			parseFacts: async () => answers.parseFacts,
		}) as unknown as Session;
}

////////////////////////////////
//  Tests

describe("listing a directory", () => {
	it("lists the root without an index, directories first", async () => {
		const answer = tree(await ask(workspace(), { kind: "tree", path: "" }));

		expect(answer.path).toBe("");
		expect(answer.entries.map((e) => e.name)).toEqual(["src", ".env.example", "README.md"]);
		expect(answer.entries[0]).toMatchObject({ directory: true });
		expect(answer.truncated).toBe(false);
	});

	// A row the read road would refuse is a row that should not be offered.
	it("does not list a link to something withheld or outside", async () => {
		const root = workspace();
		const outside = path.join(root, "..", `outside-${path.basename(root)}.ts`);
		fs.writeFileSync(outside, "export const secret = 1;\n");
		roots.push(outside);
		fs.symlinkSync(path.join(root, ".env"), path.join(root, "secrets.ts"));
		fs.symlinkSync(outside, path.join(root, "outside.ts"));
		fs.symlinkSync(path.join(root, "README.md"), path.join(root, "readme-link.md"));

		const names = tree(await ask(root, { kind: "tree", path: "" })).entries.map((e) => e.name);

		expect(names).not.toContain("secrets.ts");
		expect(names).not.toContain("outside.ts");
		expect(names).toContain("readme-link.md");
	});

	// A count of what a tap cannot list would say a withheld name is in there.
	it("counts only the children it would list", async () => {
		const root = workspace();
		fs.mkdirSync(path.join(root, "src", ".git"));
		fs.writeFileSync(path.join(root, "src", ".env"), "TOKEN=x\n");

		const answer = tree(await ask(root, { kind: "tree", path: "" }));

		expect(answer.entries.find((e) => e.name === "src")).toMatchObject({ children: 1 });
	});

	// The exclusions are confine's, not a second list here.
	it("hides withheld names and dependency bulk", async () => {
		const answer = tree(await ask(workspace(), { kind: "tree", path: "" }));
		const names = answer.entries.map((e) => e.name);

		expect(names).not.toContain(".git");
		expect(names).not.toContain(".env");
		expect(names).not.toContain("node_modules");
	});

	// Ordered before the cap, or which thousand the owner sees is whatever the filesystem said first.
	it("keeps the first entries by name when there are more than it will answer", async () => {
		const root = workspace();
		for (let i = 0; i < 1_100; i++) fs.writeFileSync(path.join(root, `f${String(i).padStart(4, "0")}.ts`), "x");

		const answer = tree(await ask(root, { kind: "tree", path: "" }));
		const files = answer.entries.filter((e) => !e.directory).map((e) => e.name);

		expect(answer.truncated).toBe(true);
		expect(answer.entries.length).toBe(1_000);
		expect(files[0]).toBe(".env.example");
		expect(files.at(-1)).toBe("f0997.ts");
	});

	it("carries a child count for a directory, and a size and line count for a text file", async () => {
		const root = workspace();
		fs.writeFileSync(path.join(root, "big.txt"), "x\n".repeat(200_000));
		fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([1, 0, 2]));
		fs.symlinkSync(path.join(root, "README.md"), path.join(root, "readme-link.md"));

		const answer = tree(await ask(root, { kind: "tree", path: "" }));
		const entry = (name: string) => answer.entries.find((e) => e.name === name);

		expect(answer.root).toMatch(new RegExp(`/${path.basename(root)}$`));
		expect(entry("src")).toMatchObject({ directory: true, children: 1 });
		expect(entry("src")?.lines).toBeUndefined();
		expect(entry("README.md")).toMatchObject({ bytes: 5, lines: 2 });
		for (const uncounted of ["big.txt", "blob.bin", "readme-link.md"]) {
			expect(entry(uncounted)?.bytes).toBeGreaterThan(0);
			expect(entry(uncounted)?.lines).toBeUndefined();
		}
	});

	it.each([
		["a path that leaves the workspace", "../elsewhere"],
		["a withheld directory", ".git"],
	])("refuses %s", async (_name, written) => {
		expect(await ask(workspace(), { kind: "tree", path: written })).toMatchObject({
			ok: false,
			failure: "refused",
		});
	});

	it("refuses a file asked for as a directory", async () => {
		expect(await ask(workspace(), { kind: "tree", path: "src/app.ts" })).toMatchObject({
			ok: false,
			failure: "refused",
		});
	});

	it("refuses a directory that is not there", async () => {
		expect(await ask(workspace(), { kind: "tree", path: "nope" })).toMatchObject({ ok: false, failure: "refused" });
	});
});

describe("reading a file", () => {
	it("answers the text, its line count and the hash a write names, without an index", async () => {
		expect(await ask(workspace(), { kind: "read", path: "src/app.ts" })).toEqual({
			ok: true,
			answer: {
				kind: "read",
				path: "src/app.ts",
				text: "export const x = 1;\n",
				lines: 2,
				hash: sha256("export const x = 1;\n"),
			},
		});
	});

	// A hash means writable; otherwise writes are refused.
	it("offers no hash for a file too large to edit or read through transcoding, and says why", async () => {
		const root = workspace();
		fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(MAX_RAW_EDIT_BYTES + 1));
		fs.writeFileSync(path.join(root, "wide.txt"), UTF16_HI);

		for (const file of ["big.txt", "wide.txt"]) {
			const read = await ask(root, { kind: "read", path: file });
			expect(read).toMatchObject({ ok: true, answer: { readOnly: expect.any(String) } });
			expect(read.ok && read.answer.kind === "read" && read.answer.hash).toBeFalsy();
		}
	});

	it("serves a committed env example and refuses the real one", async () => {
		const root = workspace();
		expect(await ask(root, { kind: "read", path: ".env.example" })).toMatchObject({ ok: true });
		expect(await ask(root, { kind: "read", path: ".env" })).toMatchObject({ ok: false, failure: "refused" });
	});

	it("refuses a directory, since it has no bytes", async () => {
		expect(await ask(workspace(), { kind: "read", path: "src" })).toMatchObject({ ok: false, failure: "refused" });
	});

	it("refuses a file that is not there", async () => {
		expect(await ask(workspace(), { kind: "read", path: "src/gone.ts" })).toMatchObject({
			ok: false,
			failure: "refused",
		});
	});
});

describe("the index-backed reads", () => {
	it("renumbers an outline's lines from one, the way an editor shows them", async () => {
		const outer = "lexicon typescript src/app.ts x.";
		const inner = "lexicon typescript src/app.ts x.inner().";
		const session = fakeSession({
			outlineModule: [
				{ symbolId: outer, name: "x", kind: "constant", module: "src/app.ts", visibility: "public" },
				{
					symbolId: inner,
					name: "inner",
					kind: "function",
					module: "src/app.ts",
					visibility: "public",
					containerId: outer,
					signature: "() => void",
					lines: { start: 4, end: 9 },
				},
			],
		});

		const result = await ask(workspace(), { kind: "outline", path: "src/app.ts" }, session);

		expect(result.ok && result.answer.kind === "outline" && result.answer.lines).toBe(2);
		expect(result.ok && result.answer.kind === "outline" && result.answer.symbols).toEqual([
			{ symbolId: outer, name: "x", symbolKind: "constant" },
			{
				symbolId: inner,
				name: "inner",
				symbolKind: "function",
				containerId: outer,
				signature: "() => void",
				startLine: 5,
			},
		]);
	});

	it("drops an outline symbol whose id names a withheld module, and a container it may not name", async () => {
		const served = "lexicon typescript src/app.ts x.";
		const session = fakeSession({
			outlineModule: [
				{ symbolId: WITHHELD_ID, name: "Secret", kind: "constant", module: "src/app.ts", visibility: "public" },
				{
					symbolId: served,
					name: "x",
					kind: "constant",
					module: "src/app.ts",
					visibility: "public",
					containerId: WITHHELD_ID,
				},
			],
		});

		const result = await ask(workspace(), { kind: "outline", path: "src/app.ts" }, session);
		const symbols = result.ok && result.answer.kind === "outline" ? result.answer.symbols : [];

		expect(symbols.map((symbol) => symbol.symbolId)).toEqual([served]);
		expect(symbols[0]?.containerId).toBeUndefined();
	});

	// Opening a FIFO blocks until a writer arrives, which would hold the plugin's only thread.
	it.skipIf(process.platform === "win32")("answers an outline of a FIFO without counting it", async () => {
		const root = workspace();
		execFileSync("mkfifo", [path.join(root, "src", "pipe.ts")]);

		const result = await ask(root, { kind: "outline", path: "src/pipe.ts" }, fakeSession({}));

		expect(result).toMatchObject({ ok: true, answer: { kind: "outline", symbols: [] } });
		expect(result.ok && result.answer.kind === "outline" && result.answer.lines).toBeUndefined();
	});

	it("refuses an outline of the root, which names no module", async () => {
		expect(await ask(workspace(), { kind: "outline", path: "" })).toMatchObject({ ok: false, failure: "refused" });
	});

	it("hashes the SPAN, so an edit elsewhere in the file leaves it alone", async () => {
		const text = "function f() {}\n";
		const session = fakeSession({
			symbolSource: {
				found: true,
				module: "src/app.ts",
				name: "f",
				text,
				range: { start: { line: 3, column: 0 }, end: { line: 3, column: 16 } },
				contentHash: "whole-file-hash",
			},
		});

		const result = await ask(workspace(), { kind: "symbolSource", symbolId: SERVED_ID }, session);

		expect(result.ok && result.answer.kind === "symbolSource" && result.answer).toMatchObject({
			module: "src/app.ts",
			startLine: 4,
			endLine: 4,
		});
		// Not the file hash the daemon handed back.
		expect(result.ok && result.answer.kind === "symbolSource" && result.answer.spanHash).not.toBe(
			"whole-file-hash",
		);
	});

	it("paints a source from Lexicon's facts, and drops the spans rather than the source when both do not fit", async () => {
		const wholeRange = (text: string) => {
			const lines = text.split("\n");
			return {
				start: { line: 0, character: 0 },
				end: { line: lines.length - 1, character: (lines.at(-1) ?? "").length },
			};
		};
		const sourceOf = async (text: string, parseFacts: Record<string, unknown>) => {
			const root = workspace();
			fs.writeFileSync(path.join(root, "src", "app.ts"), text);
			const session = fakeSession({
				symbolSource: {
					found: true,
					module: "src/app.ts",
					name: "f",
					text,
					range: wholeRange(text),
					contentHash: hashContent(text),
					spanHash: "h",
				},
				moduleFacts: { module: "src/app.ts", known: false, reason: "notIndexed" },
				parseFacts: {
					ok: true,
					contentHash: hashContent(text),
					words: { keywords: [], builtins: [], literals: [] },
					depth: "full",
					declarations: [],
					references: [],
					literals: [],
					comments: [],
					...parseFacts,
				},
			});
			const result = await ask(root, { kind: "symbolSource", symbolId: SERVED_ID }, session);
			return result.ok && result.answer.kind === "symbolSource" ? result.answer : undefined;
		};

		expect(
			(
				await sourceOf("function f() {\n\treturn 1;\n}", {
					words: { keywords: ["function", "return"], builtins: [], literals: [] },
					declarations: [
						{
							kind: "function",
							range: { start: { line: 0, character: 9 }, end: { line: 0, character: 10 } },
						},
					],
					literals: [
						{ kind: "number", range: { start: { line: 1, character: 8 }, end: { line: 1, character: 9 } } },
					],
				})
			)?.spans,
		).toEqual([
			[0, 8, CODE_TOKENS.indexOf("keyword"), 9, 1, CODE_TOKENS.indexOf("function")],
			[1, 6, CODE_TOKENS.indexOf("keyword"), 8, 1, CODE_TOKENS.indexOf("number")],
			[],
		]);

		const crowded = "1\n".repeat(450_000);
		const crowdedLiterals = Array.from({ length: 450_000 }, (_, line) => ({
			kind: "number",
			range: { start: { line, character: 0 }, end: { line, character: 1 } },
		}));
		const answer = await sourceOf(crowded, { literals: crowdedLiterals });
		expect(answer?.text).toBe(crowded);
		expect(answer).not.toHaveProperty("spans");
	});

	it("keeps a stale index apart from a missing symbol", async () => {
		const stale = fakeSession({ symbolSource: { found: false, reason: "the file moved", stale: true } });
		const gone = fakeSession({ symbolSource: { found: false, reason: "no such symbol" } });

		expect(await ask(workspace(), { kind: "symbolSource", symbolId: SERVED_ID }, stale)).toMatchObject({
			failure: "stale",
		});
		expect(await ask(workspace(), { kind: "symbolSource", symbolId: SERVED_ID }, gone)).toMatchObject({
			failure: "refused",
		});
	});

	it("answers its kind's questions in order, with each recorded answer's health and the symbol's facts", async () => {
		const summary = (name: string) => ({
			symbolId: `lexicon typescript src/app.ts ${name}#`,
			name,
			kind: "class",
			module: "src/app.ts",
		});
		const recalled = (question: string, extra: Record<string, unknown> = {}) => ({
			answer: {
				symbolId: SERVED_ID,
				question,
				factId: `f ${question}`,
				prose: `${question} prose`,
				citations: [],
				thin: false,
				createdAt: 1,
			},
			stale: [],
			inheritedStale: [],
			doubtedUpstream: [],
			...extra,
		});
		const session = fakeSession({
			describe: {
				symbol: {
					...summary("f"),
					signature: "class F",
					docComment: "What F is.",
					lines: { start: 2, end: 9 },
				},
				members: [summary("a"), summary("b")],
				comments: [{ form: "inline", placement: "body", line: 4, text: "note" }],
				moreComments: 2,
				referenceCount: 7,
				graph: { symbolId: SERVED_ID, fanIn: 5, fanOut: 3 },
				hierarchy: {
					symbolId: SERVED_ID,
					supertypes: [summary("base")],
					subtypes: [],
					ancestors: [],
					unboundSupertypes: [],
				},
				tier: "bound",
			},
			recallAnswer: [
				recalled("effects"),
				recalled("why", { stale: ["fact gone"] }),
				{ ...recalled("describe"), answer: { ...recalled("describe").answer, thin: true } },
				{
					...recalled("usage"),
					answer: { ...recalled("usage").answer, doubt: { factId: "d", reason: "r", at: 1 } },
				},
			],
		});

		const result = await ask(workspace(), { kind: "symbolKnowledge", symbolId: SERVED_ID }, session);

		expect(result.ok && result.answer).toEqual({
			kind: "symbolKnowledge",
			symbolId: SERVED_ID,
			name: "f",
			symbolKind: "class",
			module: "src/app.ts",
			startLine: 3,
			endLine: 10,
			signature: "class F",
			documentation: "What F is.",
			answers: [
				{
					question: "describe",
					prose: "describe prose",
					thin: true,
					stale: false,
					doubted: false,
					stranded: false,
				},
				{ question: "why", prose: "why prose", thin: false, stale: true, doubted: false, stranded: false },
				{ question: "relate" },
				// A class takes no effects, so a stored one stays hidden.
				{ question: "contract" },
				{ question: "usage", prose: "usage prose", thin: false, stale: false, doubted: true, stranded: false },
			],
			facts: {
				members: 2,
				references: 7,
				fanIn: 5,
				fanOut: 3,
				supertypes: 1,
				subtypes: 0,
				comments: 3,
				counts: {
					uses: 0,
					useFiles: 0,
					dependents: 0,
					dependentFiles: 0,
					targets: 0,
					boundTargets: 0,
					references: 0,
					members: 2,
					supertypes: 1,
					subtypes: 0,
					comments: 0,
				},
			},
			text: "What F is.\n\ndescribe: describe prose\n\nwhy: why prose\n\nusage: usage prose",
		});
	});

	it("refuses knowledge from a Lexicon that cannot recall answers", async () => {
		const { DaemonError } = await import("@nyaa-lexicon/client");
		const session = async () =>
			({
				describe: async () => ({ symbol: { name: "f" } }),
				recallAnswer: async () => {
					throw new DaemonError("unknown method: recallAnswer", "unknownMethod");
				},
			}) as unknown as Session;

		expect(await ask(workspace(), { kind: "symbolKnowledge", symbolId: SERVED_ID }, session)).toMatchObject({
			ok: false,
			failure: "refused",
		});
	});

	it("refuses knowledge for a symbol the index does not hold", async () => {
		const session = fakeSession({ describe: null });
		expect(await ask(workspace(), { kind: "symbolKnowledge", symbolId: SERVED_ID }, session)).toMatchObject({
			ok: false,
			failure: "refused",
		});
	});

	// A symbol id embeds a module, and nothing but this confines one. Lexicon would answer.
	it.each(["symbolSource", "symbolKnowledge"] as const)("refuses a %s id naming a withheld module", async (kind) => {
		const served = fakeSession({
			symbolSource: {
				found: true,
				module: ".env",
				name: "f",
				text: "TOKEN=secret\n",
				range: { start: { line: 0, column: 0 }, end: { line: 0, column: 5 } },
				contentHash: "h",
			},
			describe: { anything: true },
		});

		// The session would answer, so a refusal here is this rule and not a missing symbol.
		expect(await ask(workspace(), { kind, symbolId: WITHHELD_ID }, served)).toMatchObject({
			ok: false,
			failure: "refused",
		});
	});

	it.each(["symbolSource", "symbolKnowledge"] as const)("refuses an unparseable %s id", async (kind) => {
		expect(await ask(workspace(), { kind, symbolId: "not-an-id" })).toMatchObject({
			ok: false,
			failure: "refused",
		});
	});

	it("answers a thrown op as a failure rather than throwing", async () => {
		const result = await ask(workspace(), { kind: "outline", path: "src/app.ts" }, unopened);
		expect(result).toMatchObject({ ok: false, failure: "failed", detail: "the daemon was asked" });
	});

	it("carries Lexicon's own span hash when the daemon answers one", async () => {
		const session = fakeSession({
			symbolSource: { found: true, module: "src/app.ts", name: "f", text: "x", range: SPAN, spanHash: "lexicon" },
		});
		const result = await ask(workspace(), { kind: "symbolSource", symbolId: SERVED_ID }, session);
		expect(result.ok && result.answer.kind === "symbolSource" && result.answer.spanHash).toBe("lexicon");
	});

	it("names a member's enclosing declaration, and none for a top-level one", async () => {
		const session = fakeSession({
			symbolSource: { found: true, module: "src/app.ts", name: "weekdays", text: "x", range: SPAN },
		});
		const member = composeSymbolId({
			language: "typescript",
			module: "src/app.ts",
			descriptors: [
				{ kind: "type", name: "RoutineSchema" },
				{ kind: "term", name: "weekdays" },
			],
		});
		const answerOf = async (symbolId: string) => {
			const result = await ask(workspace(), { kind: "symbolSource", symbolId }, session);
			return result.ok && result.answer.kind === "symbolSource" ? result.answer : null;
		};

		const parameter = composeSymbolId({
			language: "typescript",
			module: "src/app.ts",
			descriptors: [
				{ kind: "typeParameter", name: "T" },
				{ kind: "term", name: "value" },
			],
		});

		expect((await answerOf(member))?.container).toBe("RoutineSchema");
		expect(await answerOf(SERVED_ID)).not.toHaveProperty("container");
		expect(await answerOf(parameter)).not.toHaveProperty("container");
	});
});

describe("painting held text", () => {
	const paint = (path: string, text: string) => ({ kind: "paintText", path, text }) as const;

	it("paints the phone's own held text, whether or not it matches disk", async () => {
		const text = "return 1;";
		const session = fakeSession({
			moduleFacts: { module: "src/app.ts", known: false, reason: "notIndexed" },
			parseFacts: {
				ok: true,
				contentHash: sha256(text),
				words: { keywords: ["return"], builtins: [], literals: [] },
				depth: "full",
				declarations: [],
				references: [],
				literals: [
					{ kind: "number", range: { start: { line: 0, character: 7 }, end: { line: 0, character: 8 } } },
				],
				comments: [],
			},
		});

		const result = await ask(workspace(), paint("src/app.ts", text), session);

		expect(result).toEqual({
			ok: true,
			answer: {
				kind: "paintText",
				path: "src/app.ts",
				textHash: sha256(text),
				spans: [[0, 6, CODE_TOKENS.indexOf("keyword"), 7, 1, CODE_TOKENS.indexOf("number")]],
			},
		});
	});

	it("answers null spans with a reason when nothing paints, never a guess", async () => {
		const session = fakeSession({
			moduleFacts: { module: "a.zzz", known: false, reason: "notIndexed" },
			parseFacts: { ok: false, reason: "no provider owns a.zzz" },
		});

		const result = await ask(workspace(), paint("a.zzz", "plain words"), session);

		expect(result).toEqual({
			ok: true,
			answer: {
				kind: "paintText",
				path: "a.zzz",
				textHash: sha256("plain words"),
				spans: null,
				reason: "no provider owns a.zzz",
			},
		});
	});

	it("refuses text over the raw-editing limit before asking the daemon anything", async () => {
		expect(await ask(workspace(), paint("src/app.ts", "x".repeat(MAX_RAW_EDIT_BYTES + 1)), unopened)).toMatchObject(
			{ ok: false, failure: "refused" },
		);
	});

	it("refuses a path outside the workspace, before asking the daemon anything", async () => {
		expect(await ask(workspace(), paint("../elsewhere.ts", "x"), unopened)).toMatchObject({
			ok: false,
			failure: "refused",
		});
	});
});

describe("saving a span", () => {
	const save = (text = "after") =>
		({ kind: "saveSpan", symbolId: SERVED_ID, expectedSpanHash: "seen", text }) as const;

	/** Records what the daemon was asked, in order, so a test reads the sequence the save took. */
	function daemon(replaced: Record<string, unknown> | Error, after?: Record<string, unknown>) {
		const asked: string[] = [];
		const session = async () =>
			({
				indexFile: async ({ module }: { module: string }) => {
					asked.push(`indexFile ${module}`);
					return { module, action: "current" };
				},
				refactorReplaceSpan: async (params: Record<string, unknown>) => {
					asked.push(`refactorReplaceSpan ${params.expectedSpanHash} standalone=${params.standalone}`);
					if (replaced instanceof Error) throw replaced;
					return replaced;
				},
				symbolSource: async () => after ?? { found: false, reason: "gone" },
			}) as unknown as Session;
		return { asked, session };
	}

	const now = { found: true, module: "src/app.ts", name: "f", text: "after", range: SPAN, spanHash: "new" };

	it("reindexes first, saves standalone, and answers the span as it now stands", async () => {
		const { asked, session } = daemon({ replaced: true, issues: [], transaction: "own" }, now);

		const result = await ask(workspace(), save(), session);

		expect(asked).toEqual(["indexFile src/app.ts", "refactorReplaceSpan seen standalone=true"]);
		expect(result).toEqual({
			ok: true,
			answer: {
				kind: "saveSpan",
				symbolId: SERVED_ID,
				outcome: "saved",
				joined: false,
				current: {
					kind: "symbolSource",
					symbolId: SERVED_ID,
					module: "src/app.ts",
					name: "f",
					text: "after",
					startLine: 2,
					endLine: 2,
					spanHash: "new",
				},
			},
		});
	});

	it("says a save joined another session's transaction, with what it broke", async () => {
		const issue = { kind: "UnboundReference", detail: "g no longer binds", module: "src/b.ts", line: 3 };
		const { session } = daemon({ replaced: true, issues: [issue], transaction: "joined" }, now);

		expect(await ask(workspace(), save(), session)).toMatchObject({
			ok: true,
			answer: { outcome: "saved", joined: true, issues: [issue] },
		});
	});

	it("answers a changed span as stale with what it holds now, and a refusal with its reason", async () => {
		const stale = daemon({ replaced: false, issues: [], stale: true, reason: "changed" }, now);
		const broken = daemon({ replaced: false, issues: [], reason: "the replacement does not parse" });

		expect(await ask(workspace(), save(), stale.session)).toMatchObject({
			ok: true,
			answer: { outcome: "stale", current: { text: "after" } },
		});
		const refused = await ask(workspace(), save(), broken.session);
		expect(refused).toMatchObject({
			ok: true,
			answer: { outcome: "rejected", reason: "the replacement does not parse" },
		});
		expect(refused.ok && refused.answer.kind === "saveSpan" && refused.answer.current).toBeUndefined();
	});

	// A failed read back says nothing about the span; only the index saying it is gone does.
	it("tells a span that no longer resolves from one it could not read back", async () => {
		const gone = daemon({ replaced: true, issues: [], transaction: "own" });
		const unread = daemon({ replaced: true, issues: [], transaction: "own" });
		const throwing = async () => {
			const held = await unread.session();
			return {
				...held,
				symbolSource: async () => Promise.reject(new Error("socket closed")),
			} as unknown as Session;
		};

		const vanished = await ask(workspace(), save(), gone.session);
		const unknown = await ask(workspace(), save(), throwing);

		expect(vanished).toMatchObject({ ok: true, answer: { outcome: "saved", gone: true } });
		expect(unknown.ok && unknown.answer.kind === "saveSpan" && unknown.answer).toEqual({
			kind: "saveSpan",
			symbolId: SERVED_ID,
			outcome: "saved",
			joined: false,
		});
	});

	it("refuses a Lexicon too old to check the span, rather than failing", async () => {
		const { DaemonError } = await import("@nyaa-lexicon/client");
		const { session } = daemon(new DaemonError("unknown method: refactorReplaceSpan", "unknownMethod"));

		expect(await ask(workspace(), save(), session)).toMatchObject({ ok: false, failure: "refused" });
	});

	it("refuses a span in a withheld module before asking the daemon anything", async () => {
		const { asked, session } = daemon({ replaced: true, issues: [] }, now);

		expect(
			await ask(
				workspace(),
				{ kind: "saveSpan", symbolId: WITHHELD_ID, expectedSpanHash: "h", text: "x" },
				session,
			),
		).toMatchObject({ ok: false, failure: "refused" });
		expect(asked).toEqual([]);
	});

	it("answers a save that ran out of time as unknown, since it may still land", async () => {
		const hangs = async () =>
			({
				indexFile: async () => ({ action: "current" }),
				refactorReplaceSpan: () => new Promise(() => {}),
			}) as unknown as Session;

		const result = await answerWorkspaceOp({ root: () => workspace(), session: hangs, budgetMs: 50 }, save());

		expect(result).toMatchObject({ ok: true, answer: { kind: "saveSpan", outcome: "unknown" } });
	});

	// The schema bounds characters; the answer cap is bytes, and would refuse only after the write.
	it("refuses a span too large to carry back before writing anything", async () => {
		const { asked, session } = daemon({ replaced: true, issues: [] }, now);

		expect(await ask(workspace(), save("😀".repeat(600_000)), session)).toMatchObject({
			ok: false,
			failure: "refused",
		});
		expect(asked).toEqual([]);
	});
});

describe("writing a file", () => {
	const write = (filePath: string, expectedHash: string, text: string): WorkspaceOp => ({
		kind: "mutateFile",
		mutation: { kind: "write", path: filePath, expectedHash, text },
	});
	const shown = "export const x = 1;\n";

	afterEach(() => vi.restoreAllMocks());

	it("writes over the text the owner was shown, keeps its mode, and answers the hash a read then answers", async () => {
		const root = workspace();
		const file = path.join(root, "src", "app.ts");
		fs.chmodSync(file, 0o640);

		const result = await ask(root, write("src/app.ts", sha256(shown), "export const x = 2;\n"));

		expect(result).toEqual({
			ok: true,
			answer: { kind: "mutateFile", path: "src/app.ts", outcome: "done", hash: sha256("export const x = 2;\n") },
		});
		expect(fs.readFileSync(file, "utf8")).toBe("export const x = 2;\n");
		expect(fs.statSync(file).mode & 0o777).toBe(0o640);
		expect(await ask(root, { kind: "read", path: "src/app.ts" })).toMatchObject({
			answer: { hash: sha256("export const x = 2;\n") },
		});
		expect(fs.readdirSync(path.join(root, "src"))).toEqual(["app.ts"]);
	});

	it("writes nothing over a file that moved since it was read, and says when it is gone", async () => {
		const root = workspace();
		const file = path.join(root, "src", "app.ts");
		fs.writeFileSync(file, "export const x = 3;\n");

		expect(await ask(root, write("src/app.ts", sha256(shown), "mine"))).toEqual({
			ok: true,
			answer: { kind: "mutateFile", path: "src/app.ts", outcome: "stale" },
		});
		expect(fs.readFileSync(file, "utf8")).toBe("export const x = 3;\n");

		fs.rmSync(file);
		expect(await ask(root, write("src/app.ts", sha256(shown), "mine"))).toMatchObject({
			answer: { outcome: "stale", gone: true },
		});
		expect(fs.existsSync(file)).toBe(false);
	});

	// Rehashing catches changes during temp-file writes.
	it("writes nothing when the file changes while the new text is on its way to disk", async () => {
		const root = workspace();
		const file = path.join(root, "src", "app.ts");
		const original = fs.writeFileSync.bind(fs);
		vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
			original(target, data, options);
			if (String(target) !== file) original(file, "export const x = 4;\n");
		});

		expect(await ask(root, write("src/app.ts", sha256(shown), "mine"))).toMatchObject({
			answer: { outcome: "stale" },
		});
		vi.restoreAllMocks();
		expect(fs.readFileSync(file, "utf8")).toBe("export const x = 4;\n");
		expect(fs.readdirSync(path.join(root, "src"))).toEqual(["app.ts"]);
	});

	it("writes through a link to the file it names, leaving the link a link", async () => {
		const root = workspace();
		fs.symlinkSync("app.ts", path.join(root, "src", "alias.ts"));

		await ask(root, write("src/alias.ts", sha256(shown), "through"));

		expect(fs.lstatSync(path.join(root, "src", "alias.ts")).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(path.join(root, "src", "app.ts"), "utf8")).toBe("through");
	});

	it("writes nothing through a link retargeted outside the workspace after it was read", async () => {
		const root = workspace();
		const link = path.join(root, "src", "alias.ts");
		fs.symlinkSync("app.ts", link);
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wsoutside-"));
		roots.push(outside);
		fs.writeFileSync(path.join(outside, "theirs.ts"), shown);
		const original = fs.readFileSync.bind(fs);
		vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
			const read = original(target, options as undefined);
			if (target === link) {
				fs.unlinkSync(link);
				fs.symlinkSync(path.join(outside, "theirs.ts"), link);
			}
			return read;
		}) as typeof fs.readFileSync);

		expect(await ask(root, write("src/alias.ts", sha256(shown), "mine"))).toMatchObject({
			ok: false,
			failure: "refused",
		});
		vi.restoreAllMocks();
		expect(fs.readFileSync(path.join(outside, "theirs.ts"), "utf8")).toBe(shown);
	});

	it("refuses what a read would not offer, before writing anything", async () => {
		const root = workspace();
		fs.writeFileSync(path.join(root, "wide.txt"), UTF16_HI);
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wsoutside-"));
		roots.push(outside);
		fs.writeFileSync(path.join(outside, "theirs.ts"), shown);
		fs.symlinkSync(path.join(outside, "theirs.ts"), path.join(root, "src", "away.ts"));

		const refusedWrites = [
			write(".env", sha256("TOKEN=secret\n"), "TOKEN=mine\n"),
			write("src", "h", "x"),
			write(".", "h", "x"),
			write("src/away.ts", sha256(shown), "mine"),
			write("wide.txt", createHash("sha256").update(UTF16_HI).digest("hex"), "narrow"),
		];
		for (const op of refusedWrites) expect(await ask(root, op)).toMatchObject({ ok: false, failure: "refused" });
		expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe("TOKEN=secret\n");
		expect(fs.readFileSync(path.join(outside, "theirs.ts"), "utf8")).toBe(shown);
		expect(fs.readFileSync(path.join(root, "wide.txt"))).toEqual(UTF16_HI);
	});
});

describe("file state and whole-file mutations", () => {
	const shown = "export const x = 1;\n";

	afterEach(() => vi.restoreAllMocks());

	async function stateOf(root: string, filePath: string): Promise<FileStateAnswer> {
		const result = await ask(root, { kind: "fileState", path: filePath });
		if (!result.ok || result.answer.kind !== "fileState") throw new Error(`no state: ${JSON.stringify(result)}`);
		return result.answer;
	}

	const mutate = (root: string, mutation: FileMutation) => ask(root, { kind: "mutateFile", mutation });

	/** The preconditions a phone arms from a state read. */
	async function armed(root: string, filePath: string) {
		const state = await stateOf(root, filePath);
		return { path: filePath, expectedHash: state.hash ?? "", expectedIdentity: state.identity ?? "" };
	}

	async function replacing(root: string, filePath: string) {
		const { expectedHash, expectedIdentity } = await armed(root, filePath);
		return { kind: "replace" as const, expectedHash, expectedIdentity };
	}

	const outcome = (result: WorkspaceOpResult) =>
		result.ok && result.answer.kind === "mutateFile" ? result.answer : null;

	it("names what a mutation would: nothing, a folder, or a file by size, hash and inode", async () => {
		const root = workspace();
		fs.symlinkSync("app.ts", path.join(root, "src", "alias.ts"));

		expect(await stateOf(root, "src/new.ts")).toEqual({ kind: "fileState", path: "src/new.ts", state: "absent" });
		expect(await stateOf(root, "src")).toMatchObject({ state: "directory" });
		const file = await stateOf(root, "src/app.ts");
		expect(file).toMatchObject({ state: "file", bytes: shown.length, hash: sha256(shown) });
		const alias = await stateOf(root, "src/alias.ts");
		expect(alias.hash).toBe(file.hash);
		expect(alias.identity).not.toBe(file.identity);
		expect(await ask(root, { kind: "fileState", path: ".env" })).toMatchObject({ ok: false, failure: "refused" });
	});

	it("creates a file only where nothing is, and a read then answers the hash it gave", async () => {
		const root = workspace();
		const create = (filePath: string, text: string): FileMutation => ({ kind: "create", path: filePath, text });

		expect(outcome(await mutate(root, create("src/new.ts", "fresh\n")))).toEqual({
			kind: "mutateFile",
			path: "src/new.ts",
			outcome: "done",
			hash: sha256("fresh\n"),
		});
		expect(await ask(root, { kind: "read", path: "src/new.ts" })).toMatchObject({
			answer: { hash: sha256("fresh\n") },
		});

		fs.symlinkSync("nowhere.ts", path.join(root, "src", "dangling.ts"));
		for (const taken of ["src/app.ts", "src/dangling.ts"]) {
			expect(outcome(await mutate(root, create(taken, "mine")))?.outcome).toBe("destinationChanged");
		}
		expect(fs.readFileSync(path.join(root, "src", "app.ts"), "utf8")).toBe(shown);
		expect(fs.existsSync(path.join(root, "src", "nowhere.ts"))).toBe(false);

		for (const refusedPath of ["missing/new.ts", ".env.local", ".", "README.md/child.ts"]) {
			expect(await mutate(root, create(refusedPath, "x"))).toMatchObject({ ok: false, failure: "refused" });
		}
		expect(fs.readdirSync(path.join(root, "src")).sort()).toEqual(["app.ts", "dangling.ts", "new.ts"]);
	});

	it("deletes only the file the owner was shown, and a link rather than what it names", async () => {
		const root = workspace();
		const file = path.join(root, "src", "app.ts");
		fs.symlinkSync("app.ts", path.join(root, "src", "alias.ts"));

		const alias = await armed(root, "src/alias.ts");
		expect(outcome(await mutate(root, { kind: "delete", ...alias }))?.outcome).toBe("done");
		expect(fs.existsSync(path.join(root, "src", "alias.ts"))).toBe(false);
		expect(fs.readFileSync(file, "utf8")).toBe(shown);

		const before = await armed(root, "src/app.ts");
		// Held, or the recreated file may be handed the freed inode.
		fs.linkSync(file, path.join(root, "held.ts"));
		fs.rmSync(file);
		fs.writeFileSync(file, shown);
		expect(outcome(await mutate(root, { kind: "delete", ...before }))?.outcome).toBe("stale");

		const recreated = await armed(root, "src/app.ts");
		fs.appendFileSync(file, "// more\n");
		expect(outcome(await mutate(root, { kind: "delete", ...recreated }))?.outcome).toBe("stale");
		expect(fs.existsSync(file)).toBe(true);

		fs.rmSync(file);
		expect(outcome(await mutate(root, { kind: "delete", ...recreated }))).toMatchObject({
			outcome: "stale",
			gone: true,
		});
		const folder = { kind: "delete" as const, path: "src", expectedHash: "h", expectedIdentity: "i" };
		expect(await mutate(root, folder)).toMatchObject({ ok: false, failure: "refused" });
	});

	it("moves a file to a free name keeping its inode, and never onto a name that was taken meanwhile", async () => {
		const root = workspace();
		const source = await armed(root, "src/app.ts");
		const move = (to: string, destination: FileDestination): FileMutation => ({
			kind: "move",
			...source,
			to,
			destination,
		});

		fs.writeFileSync(path.join(root, "src", "taken.ts"), "theirs");
		expect(outcome(await mutate(root, move("src/taken.ts", { kind: "absent" })))?.outcome).toBe(
			"destinationChanged",
		);
		expect(fs.readFileSync(path.join(root, "src", "taken.ts"), "utf8")).toBe("theirs");

		expect(outcome(await mutate(root, move("moved.ts", { kind: "absent" })))).toEqual({
			kind: "mutateFile",
			path: "src/app.ts",
			outcome: "done",
			hash: sha256(shown),
		});
		expect(fs.existsSync(path.join(root, "src", "app.ts"))).toBe(false);
		expect((await stateOf(root, "moved.ts")).identity).toBe(source.expectedIdentity);
	});

	it("replaces a destination only while it is the one the owner was shown", async () => {
		const root = workspace();
		const target = path.join(root, "README.md");
		const source = await armed(root, "src/app.ts");
		const named = await replacing(root, "README.md");
		const move: FileMutation = { kind: "move", ...source, to: "README.md", destination: named };

		fs.appendFileSync(target, "edited\n");
		expect(outcome(await mutate(root, move))?.outcome).toBe("destinationChanged");
		expect(fs.existsSync(path.join(root, "src", "app.ts"))).toBe(true);

		const renamed: FileMutation = { ...move, destination: await replacing(root, "README.md") };
		expect(outcome(await mutate(root, renamed))?.outcome).toBe("done");
		expect(fs.readFileSync(target, "utf8")).toBe(shown);
		expect(fs.existsSync(path.join(root, "src", "app.ts"))).toBe(false);
	});

	it("refuses a move onto a folder, a withheld name, a missing folder, or another name for the same file", async () => {
		const root = workspace();
		const file = path.join(root, "src", "app.ts");
		fs.symlinkSync("app.ts", path.join(root, "src", "alias.ts"));
		fs.linkSync(file, path.join(root, "src", "hard.ts"));
		const source = await armed(root, "src/app.ts");
		const onto = async (to: string, destination: FileDestination = { kind: "absent" }) =>
			mutate(root, { kind: "move", ...source, to, destination });

		for (const refusedMove of [
			await onto("src"),
			await onto(".env"),
			await onto("missing/app.ts"),
			await onto("src/app.ts"),
			await onto("src/alias.ts", await replacing(root, "src/alias.ts")),
			await onto("src/hard.ts", await replacing(root, "src/hard.ts")),
		]) {
			expect(refusedMove).toMatchObject({ ok: false, failure: "refused" });
		}
		expect(fs.readFileSync(file, "utf8")).toBe(shown);
		expect(fs.lstatSync(path.join(root, "src", "alias.ts")).isSymbolicLink()).toBe(true);
	});

	it("copies the bytes the owner saw with the source's mode, leaving the source alone", async () => {
		const root = workspace();
		const file = path.join(root, "src", "app.ts");
		fs.chmodSync(file, 0o640);
		const { path: from, expectedHash } = await armed(root, "src/app.ts");

		const copied = await mutate(root, {
			kind: "copy",
			path: from,
			expectedHash,
			to: "src/copy.ts",
			destination: { kind: "absent" },
		});
		expect(outcome(copied)?.outcome).toBe("done");
		expect(fs.readFileSync(path.join(root, "src", "copy.ts"), "utf8")).toBe(shown);
		expect(fs.statSync(path.join(root, "src", "copy.ts")).mode & 0o777).toBe(0o640);
		expect(fs.readFileSync(file, "utf8")).toBe(shown);

		const over = await mutate(root, {
			kind: "copy",
			path: from,
			expectedHash,
			to: "README.md",
			destination: await replacing(root, "README.md"),
		});
		expect(outcome(over)?.outcome).toBe("done");
		expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe(shown);
	});

	// The hash is checked on the copied bytes, so a change between the state read and the copy lands nothing.
	it("lands nothing when the source changes during the copy, or the destination appears during it", async () => {
		const root = workspace();
		const file = path.join(root, "src", "app.ts");
		const copy: FileMutation = {
			kind: "copy",
			path: "src/app.ts",
			expectedHash: sha256(shown),
			to: "src/copy.ts",
			destination: { kind: "absent" },
		};
		const original = fs.copyFileSync.bind(fs);

		vi.spyOn(fs, "copyFileSync").mockImplementationOnce((from, to, mode) => {
			fs.writeFileSync(file, "changed\n");
			original(from, to, mode);
		});
		expect(outcome(await mutate(root, copy))?.outcome).toBe("stale");
		expect(fs.readdirSync(path.join(root, "src"))).toEqual(["app.ts"]);

		fs.writeFileSync(file, shown);
		vi.spyOn(fs, "copyFileSync").mockImplementationOnce((from, to, mode) => {
			original(from, to, mode);
			fs.writeFileSync(path.join(root, "src", "copy.ts"), "theirs");
		});
		expect(outcome(await mutate(root, copy))?.outcome).toBe("destinationChanged");
		expect(fs.readFileSync(path.join(root, "src", "copy.ts"), "utf8")).toBe("theirs");
		expect(fs.readdirSync(path.join(root, "src")).sort()).toEqual(["app.ts", "copy.ts"]);
	});
});

describe("the index deadline", () => {
	// BOTH calls slow is the defect condition: a budget each would spend the budget twice.
	it("spends ONE deadline across both index calls, not a budget each", async () => {
		const slowThenHangs = async (): Promise<Session> => {
			await new Promise((resolve) => setTimeout(resolve, 150));
			return { outlineModule: () => new Promise(() => {}) } as unknown as Session;
		};
		const started = Date.now();

		const result = await answerWorkspaceOp(
			{ root: () => workspace(), session: slowThenHangs, budgetMs: 200 },
			{ kind: "outline", path: "src/app.ts" },
		);

		// Shared: 150 then 50. Per call: 150 then 200.
		expect(Date.now() - started).toBeLessThan(300);
		expect(result).toMatchObject({ ok: false, failure: "failed" });
	});
});
