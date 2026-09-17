import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session } from "@nyaa-lexicon/client";
import { afterEach, describe, expect, it } from "vitest";
import { answerWorkspaceOp } from "../mcp/workspace/handlers.js";
import { MAX_HISTORY_COMMITS } from "../mcp/workspace/history.js";
import type { WorkspaceOpResult } from "../shared/workspace-op.js";

////////////////////////////////
//  Functions & Helpers

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SYMBOL = "lexicon typescript src/app.ts f().";

const FACET_RULES = path.join(
	__dirname,
	"../../android/app/src/main/java/com/atelier_nyaarium/switchboard/FacetRules.kt",
);

function directory(): string {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wshistory-")));
	roots.push(root);
	fs.mkdirSync(path.join(root, "src"));
	return root;
}

function git(root: string, ...args: string[]): void {
	execFileSync(
		"git",
		["-c", "user.name=Owner", "-c", "user.email=owner@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd: root, stdio: "ignore" },
	);
}

/** `f` is lines 3 to 5. */
function repository(): string {
	const root = directory();
	git(root, "init", "-q");
	const file = path.join(root, "src", "app.ts");
	fs.writeFileSync(file, "// head\n\nfunction f() {\n\treturn 1;\n}\n\nconst other = 2;\n");
	git(root, "add", ".");
	git(root, "commit", "-qm", "Add f");
	fs.writeFileSync(file, "// head\n\nfunction f() {\n\treturn 2;\n}\n\nconst other = 3;\n");
	git(root, "commit", "-qam", "Return two from f");
	fs.writeFileSync(file, "// head changed\n\nfunction f() {\n\treturn 2;\n}\n\nconst other = 3;\n");
	git(root, "commit", "-qam", "Touch only the head");
	return root;
}

/** Git alone decides these. */
const unopened = async (): Promise<Session> => {
	throw new Error("the daemon was asked");
};

function sessionOf(methods: Record<string, () => unknown>): () => Promise<Session> {
	return async () =>
		Object.fromEntries(
			Object.entries(methods).map(([name, answer]) => [name, async () => answer()]),
		) as unknown as Session;
}

const declaredF = sessionOf({
	declarationOf: () => ({
		symbolId: SYMBOL,
		range: { start: { line: 2, character: 0 }, end: { line: 4, character: 1 } },
	}),
});

function history(result: WorkspaceOpResult) {
	if (!result.ok || result.answer.kind !== "symbolFacet" || result.answer.facet.kind !== "history") {
		throw new Error(`not a history: ${JSON.stringify(result)}`);
	}
	return result.answer.facet;
}

const symbolHistory = (root: string, session = declaredF, budgetMs?: number) =>
	answerWorkspaceOp(
		{ root: () => root, session, ...(budgetMs === undefined ? {} : { budgetMs }) },
		{ kind: "symbolFacet", symbolId: SYMBOL, facet: { kind: "history" } },
	);

////////////////////////////////
//  Tests

describe("the commits that touched a symbol's lines", () => {
	it("lists them newest first with their line counts, leaving out commits elsewhere in the file", async () => {
		const facet = history(await symbolHistory(repository()));

		expect(facet).toMatchObject({
			outcome: "commits",
			module: "src/app.ts",
			startLine: 3,
			endLine: 5,
			truncated: false,
		});
		expect(
			facet.commits.map(({ subject, author, added, removed }) => ({ subject, author, added, removed })),
		).toEqual([
			{ subject: "Return two from f", author: "Owner", added: 1, removed: 1 },
			{ subject: "Add f", author: "Owner", added: 3, removed: 0 },
		]);
		expect(facet.commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
	});

	it("answers untracked, not a repository, and no history as outcomes rather than failures", async () => {
		const untracked = repository();
		fs.rmSync(path.join(untracked, "src", "app.ts"));
		git(untracked, "commit", "-qam", "Remove app");
		fs.writeFileSync(path.join(untracked, "src", "app.ts"), "a\nb\nc\nd\ne\n");

		const staged = directory();
		git(staged, "init", "-q");
		fs.writeFileSync(path.join(staged, "src", "app.ts"), "a\nb\nc\nd\ne\n");
		git(staged, "add", ".");

		const bare = directory();
		fs.writeFileSync(path.join(bare, "src", "app.ts"), "a\nb\nc\nd\ne\n");

		expect(history(await symbolHistory(untracked)).outcome).toBe("untracked");
		expect(history(await symbolHistory(staged)).outcome).toBe("none");
		expect(history(await symbolHistory(bare))).toMatchObject({ outcome: "notRepository", commits: [] });
	});

	it("fails rather than waiting past the deadline", async () => {
		const result = await symbolHistory(repository(), declaredF, 1);
		expect(result).toMatchObject({ ok: false, failure: "failed" });
	});

	it("lists its own bound and says there are more, so a count reads as a floor", async () => {
		const root = repository();
		const file = path.join(root, "src", "app.ts");
		for (let turn = 0; turn < MAX_HISTORY_COMMITS; turn++) {
			fs.writeFileSync(file, `// head\n\nfunction f() {\n\treturn ${turn};\n}\n\nconst other = 3;\n`);
			git(root, "commit", "-qam", `Return ${turn} from f`);
		}

		const facet = history(await symbolHistory(root));

		expect(facet).toMatchObject({ outcome: "commits", truncated: true });
		expect(facet.commits.length).toBe(MAX_HISTORY_COMMITS);
	});

	it("answers within its budget when git leaves a descendant holding the pipes", async () => {
		const root = repository();
		const bin = path.join(root, "fake-bin");
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, "git"), '#!/bin/sh\nsleep 30 &\necho $! > "$GIT_PROBE_PID"\nwait\n');
		fs.chmodSync(path.join(bin, "git"), 0o755);
		const pidFile = path.join(root, "descendant.pid");
		const path0 = process.env.PATH;
		process.env.PATH = `${bin}:${path0}`;
		process.env.GIT_PROBE_PID = pidFile;

		try {
			const started = Date.now();
			const result = await symbolHistory(root, declaredF, 60);
			const elapsed = Date.now() - started;
			await new Promise((settled) => setTimeout(settled, 500));
			let alive = false;
			try {
				process.kill(Number(fs.readFileSync(pidFile, "utf8").trim()), 0);
				alive = true;
			} catch {}

			expect(result).toMatchObject({ ok: false, failure: "failed" });
			expect(elapsed).toBeLessThan(2_000);
			expect(alive).toBe(false);
		} finally {
			process.env.PATH = path0;
			delete process.env.GIT_PROBE_PID;
		}
	});
});

describe("a file's history", () => {
	it("answers from Lexicon's read once git tracks the file", async () => {
		const root = repository();
		const session = sessionOf({
			fileHistory: () => ({
				module: "src/app.ts",
				commits: 3,
				linesAdded: 9,
				linesDeleted: 3,
				recent: [{ hash: "abc", at: 20, added: 2, deleted: 2, subject: "Touch" }],
				firstSeen: 10,
				lastTouched: 20,
				truncated: false,
			}),
		});

		const result = await answerWorkspaceOp(
			{ root: () => root, session },
			{ kind: "fileHistory", path: "src/app.ts" },
		);

		expect(result.ok && result.answer).toEqual({
			kind: "fileHistory",
			path: "src/app.ts",
			outcome: "commits",
			commits: [{ hash: "abc", at: 20, subject: "Touch", added: 2, removed: 2 }],
			count: 3,
			added: 9,
			removed: 3,
			firstSeen: 10,
			lastTouched: 20,
			truncated: false,
		});
	});

	it("answers untracked and not a repository without asking Lexicon, and refuses a withheld path", async () => {
		const root = repository();
		fs.writeFileSync(path.join(root, "src", "new.ts"), "x\n");
		fs.writeFileSync(path.join(root, ".env"), "TOKEN=1\n");
		const bare = directory();
		fs.writeFileSync(path.join(bare, "src", "app.ts"), "x\n");

		const ask = (at: string, file: string) =>
			answerWorkspaceOp({ root: () => at, session: unopened }, { kind: "fileHistory", path: file });

		expect(await ask(root, "src/new.ts")).toMatchObject({ ok: true, answer: { outcome: "untracked", count: 0 } });
		expect(await ask(bare, "src/app.ts")).toMatchObject({ ok: true, answer: { outcome: "notRepository" } });
		expect(await ask(root, ".env")).toMatchObject({ ok: false, failure: "refused" });
	});
});

// The wire carries no total, so the phone names this cap rather than counting the rows it was sent.
describe("the cut a truncated symbol history is named by", () => {
	it("is the bound this handler stops at, as the phone declares it", () => {
		const kotlin = fs.readFileSync(FACET_RULES, "utf8");
		const declared = kotlin.match(/HISTORY_COMMIT_CAP\s*=\s*([\d_]+)\b/);

		expect(declared, "FacetRules.HISTORY_COMMIT_CAP is no longer declared as a literal").not.toBeNull();
		expect(Number((declared?.[1] ?? "").replaceAll("_", ""))).toBe(MAX_HISTORY_COMMITS);
	});
});
