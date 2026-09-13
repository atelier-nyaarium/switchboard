import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session } from "@nyaa-lexicon/client";
import { afterEach, describe, expect, it } from "vitest";
import { answerWorkspaceOp } from "../mcp/workspace/handlers.js";
import type { WorkspaceOp, WorkspaceOpResult } from "../shared/workspace-op.js";

////////////////////////////////
//  Interfaces & Types

type Step =
	| { bind: string; path: string }
	| { put: string; text: string }
	| { edit: string; text: string }
	| { remove: string }
	| { op: WorkspaceOp; expect: Record<string, unknown> };

interface Case {
	name: string;
	folders: string[];
	files: Record<string, string>;
	steps: Step[];
	after: Record<string, string>;
}

////////////////////////////////
//  Functions & Helpers

const VECTORS: { cases: Case[] } = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/workspace-file-ops/vectors.json"), "utf8"),
);

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	dirs.push(dir);
	return dir;
}

/** Every key an expectation may name; any other is a typo nothing would check. */
const EXPECT_KEYS = new Set(["refused", "state", "outcome", "path", "hash", "identity", "gone", "names"]);

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Deliberately throws: no file op opens an index session. */
const unopened = async (): Promise<Session> => {
	throw new Error("the daemon was asked");
};

function filesUnder(root: string, dir = root): Record<string, string> {
	const found: Record<string, string> = {};
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const absolute = path.join(dir, entry.name);
		if (entry.isDirectory()) Object.assign(found, filesUnder(root, absolute));
		else found[path.relative(root, absolute).split(path.sep).join("/")] = fs.readFileSync(absolute, "utf8");
	}
	return found;
}

////////////////////////////////
//  Tests

describe("workspace file op vectors, against the plugin's handlers", () => {
	it.each(VECTORS.cases.map((c) => [c.name, c] as const))("%s", async (_name, vector) => {
		const root = tempDir("wsvectors-");
		// Holds replaced inodes, so none is reused.
		const holder = tempDir("wsvectors-held-");
		for (const folder of vector.folders) fs.mkdirSync(path.join(root, folder), { recursive: true });
		for (const [file, text] of Object.entries(vector.files)) fs.writeFileSync(path.join(root, file), text);

		const bound = new Map<string, { hash?: string; identity?: string }>();
		const resolve = (value: unknown): unknown => {
			if (typeof value === "string") {
				if (value.startsWith("sha256:")) return sha256(value.slice("sha256:".length));
				if (value.startsWith("#")) return bound.get(value.slice(1))?.hash;
				if (value.startsWith("@")) return bound.get(value.slice(1))?.identity;
				return value;
			}
			if (Array.isArray(value)) return value.map(resolve);
			if (value && typeof value === "object") {
				return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, resolve(inner)]));
			}
			return value;
		};
		const ask = (op: WorkspaceOp): Promise<WorkspaceOpResult> =>
			answerWorkspaceOp({ root: () => root, session: unopened }, op);

		for (const [index, step] of vector.steps.entries()) {
			const at = `step ${index}`;
			if ("bind" in step) {
				const result = await ask({ kind: "fileState", path: step.path });
				if (!result.ok || result.answer.kind !== "fileState") throw new Error(`${at}: no state`);
				bound.set(step.bind, { hash: result.answer.hash, identity: result.answer.identity });
			} else if ("put" in step) {
				const file = path.join(root, step.put);
				if (fs.existsSync(file)) {
					fs.linkSync(file, path.join(holder, `${index}`));
					fs.rmSync(file);
				}
				fs.writeFileSync(file, step.text);
			} else if ("edit" in step) {
				fs.writeFileSync(path.join(root, step.edit), step.text);
			} else if ("remove" in step) {
				fs.rmSync(path.join(root, step.remove));
			} else {
				const expected = resolve(step.expect) as Record<string, unknown>;
				const unknown = Object.keys(expected).filter((key) => !EXPECT_KEYS.has(key));
				if (unknown.length > 0)
					throw new Error(`${at}: expect names ${unknown.join(", ")}, which nothing checks`);
				if (!["refused", "state", "outcome", "names"].some((key) => key in expected)) {
					throw new Error(`${at}: expect names no result`);
				}
				const result = await ask(resolve(step.op) as WorkspaceOp);
				if (expected.refused) {
					expect(result, at).toMatchObject({ ok: false, failure: "refused" });
					continue;
				}
				if (!result.ok) throw new Error(`${at}: ${result.failure}: ${result.detail}`);
				const answer = result.answer as Record<string, unknown>;
				for (const key of ["state", "outcome", "path", "hash", "identity"]) {
					if (key in expected) expect(answer[key], `${at} ${key}`).toBe(expected[key]);
				}
				if ("names" in expected) {
					const entries = (answer.entries ?? []) as { name: string }[];
					expect(
						entries.map((entry) => entry.name),
						`${at} names`,
					).toEqual(expected.names);
				}
				if (answer.kind === "mutateFile")
					expect(Boolean(answer.gone), `${at} gone`).toBe(Boolean(expected.gone));
			}
		}

		expect(filesUnder(root)).toEqual(vector.after);
	});
});
