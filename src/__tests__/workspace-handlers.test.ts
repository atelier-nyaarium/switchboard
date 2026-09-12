import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session } from "@nyaa-lexicon/client";
import { afterEach, describe, expect, it } from "vitest";
import { answerWorkspaceOp, type HandlerDeps } from "../mcp/workspace/handlers.js";
import type { TreeAnswer, WorkspaceOp, WorkspaceOpResult } from "../shared/workspace-op.js";

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

/** Deliberately throws: an op needing no index must not open a session. */
const unopened = async (): Promise<Session> => {
	throw new Error("the daemon was asked");
};

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

	it("carries a byte count for a file and a child count for a directory", async () => {
		const answer = tree(await ask(workspace(), { kind: "tree", path: "" }));
		const dir = answer.entries.find((e) => e.name === "src");
		const file = answer.entries.find((e) => e.name === "README.md");

		expect(dir).toMatchObject({ directory: true, children: 1 });
		expect(file?.bytes).toBeGreaterThan(0);
		expect(file?.children).toBeUndefined();
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
	it("answers the text and its line count without an index", async () => {
		expect(await ask(workspace(), { kind: "read", path: "src/app.ts" })).toEqual({
			ok: true,
			answer: { kind: "read", path: "src/app.ts", text: "export const x = 1;\n", lines: 2 },
		});
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
		const session = fakeSession({
			outlineModule: [
				{ symbolId: "id-a", name: "x", kind: "constant", module: "src/app.ts", visibility: "public" },
				{
					symbolId: "id-b",
					name: "inner",
					kind: "function",
					module: "src/app.ts",
					visibility: "public",
					containerId: "id-a",
					signature: "() => void",
					lines: { start: 4, end: 9 },
				},
			],
		});

		const result = await ask(workspace(), { kind: "outline", path: "src/app.ts" }, session);

		expect(result.ok && result.answer.kind === "outline" && result.answer.symbols).toEqual([
			{ symbolId: "id-a", name: "x", symbolKind: "constant" },
			{
				symbolId: "id-b",
				name: "inner",
				symbolKind: "function",
				containerId: "id-a",
				signature: "() => void",
				startLine: 5,
			},
		]);
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
