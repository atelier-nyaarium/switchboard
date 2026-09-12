import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { confine, fileIdentity, listable, sameFile } from "../mcp/workspace/confine.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "confine-")));
	roots.push(root);
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.writeFileSync(path.join(root, "src", "app.ts"), "export const x = 1;\n");
	return root;
}

function refusalOf(root: string, written: string, platform?: string): string {
	const answer = confine(root, written, platform);
	if (answer.ok) throw new Error(`${written} was admitted`);
	return answer.refusal.kind;
}

describe("what the phone's file road will serve", () => {
	it("admits a file and answers a POSIX module path", () => {
		const root = workspace();
		expect(confine(root, "src/app.ts")).toEqual({
			ok: true,
			absolute: path.join(root, "src", "app.ts"),
			relative: "src/app.ts",
		});
	});

	it("admits the root itself", () => {
		const root = workspace();
		expect(confine(root, "")).toEqual({ ok: true, absolute: root, relative: "" });
		expect(confine(root, ".")).toEqual({ ok: true, absolute: root, relative: "" });
	});

	it("admits a path that does not exist yet, since creating one is a mutation it gates", () => {
		const root = workspace();
		expect(confine(root, "src/new/deep.ts")).toMatchObject({ ok: true, relative: "src/new/deep.ts" });
	});

	it.each([
		["a parent walk", "../outside.ts"],
		["a bare parent", ".."],
		["a parent walk mid-path", "src/../../outside.ts"],
		["an absolute path", "/etc/passwd"],
		["a drive-letter path", "C:/Windows/System32/config"],
	])("refuses %s", (_name, written) => {
		expect(refusalOf(workspace(), written)).toBe("outside");
	});

	it("refuses a path whose parent is a symlink out of the workspace", () => {
		const root = workspace();
		const elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "confine-out-")));
		roots.push(elsewhere);
		fs.writeFileSync(path.join(elsewhere, "secret.txt"), "sensitive\n");
		fs.symlinkSync(elsewhere, path.join(root, "escape"));

		expect(refusalOf(root, "escape/secret.txt")).toBe("outside");
	});

	// Links that stay inside must not be refused.
	it("admits a symlink that stays inside, keeping the written path", () => {
		const root = workspace();
		fs.symlinkSync(path.join(root, "src"), path.join(root, "alias"));
		expect(confine(root, "alias/app.ts")).toEqual({
			ok: true,
			absolute: path.join(root, "alias", "app.ts"),
			relative: "alias/app.ts",
		});
	});
});

describe("what it withholds from a read", () => {
	it.each([
		["the git directory", ".git"],
		["git internals", ".git/config"],
		[".env", ".env"],
		["a secret-bearing .env sibling", ".env.local"],
		["a nested .env", "deploy/.env.production"],
	])("refuses %s", (_name, written) => {
		expect(refusalOf(workspace(), written)).toBe("excluded");
	});

	// A case-folding filesystem aliases these.
	it.each([".ENV", ".Git/config"])("refuses %s regardless of case", (written) => {
		expect(refusalOf(workspace(), written)).toBe("excluded");
	});

	// Committed and secretless.
	it.each([".env.example", ".env.sample", ".env.template"])("serves %s", (written) => {
		expect(confine(workspace(), written)).toMatchObject({ ok: true });
	});

	it("still serves a file that merely mentions a withheld name", () => {
		expect(confine(workspace(), "src/dotenv-loader.ts")).toMatchObject({ ok: true });
	});

	// Location passes; the resolved name must not.
	it.each([
		["a served .env suffix", ".env.example"],
		["an innocent name", "src/notes.txt"],
	])("refuses %s when it links to .env", (_name, written) => {
		const root = workspace();
		fs.writeFileSync(path.join(root, ".env"), "TOKEN=secret\n");
		fs.symlinkSync(path.join(root, ".env"), path.join(root, written));

		expect(refusalOf(root, written)).toBe("excluded");
	});

	it("refuses a link into git internals", () => {
		const root = workspace();
		fs.mkdirSync(path.join(root, ".git"), { recursive: true });
		fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n");
		fs.symlinkSync(path.join(root, ".git", "config"), path.join(root, "src", "gitcfg.txt"));

		expect(refusalOf(root, "src/gitcfg.txt")).toBe("excluded");
	});

	it("serves a real .env.example that links nowhere", () => {
		const root = workspace();
		fs.writeFileSync(path.join(root, ".env.example"), "TOKEN=\n");
		expect(confine(root, ".env.example")).toMatchObject({ ok: true });
	});

	// The leaf rule spares directories.
	it("admits creating a file inside a directory named like an env leaf", () => {
		const root = workspace();
		fs.mkdirSync(path.join(root, ".env.d"), { recursive: true });
		expect(confine(root, ".env.d/notes.txt")).toMatchObject({ ok: true, relative: ".env.d/notes.txt" });
	});

	it("admits a directory whose name would be withheld as a file", () => {
		const root = workspace();
		fs.mkdirSync(path.join(root, ".env.d"), { recursive: true });
		expect(confine(root, ".env.d")).toMatchObject({ ok: true, relative: ".env.d" });
	});

	it("refuses the same name when it is a file", () => {
		const root = workspace();
		fs.writeFileSync(path.join(root, ".env.d"), "TOKEN=1\n");
		expect(refusalOf(root, ".env.d")).toBe("excluded");
	});

	it("refuses creating a .env that does not exist yet", () => {
		expect(refusalOf(workspace(), ".env")).toBe("excluded");
	});

	// Hidden from a tree, served when named.
	it("serves a named file under node_modules", () => {
		expect(confine(workspace(), "node_modules/typescript/lib/typescript.js")).toMatchObject({ ok: true });
	});
});

describe("spellings canonicalization cannot settle, on Windows", () => {
	it.each([
		["an alternate data stream", "src/app.ts:hidden"],
		["a reserved device name", "src/NUL"],
		["a reserved name wearing an extension", "src/con.txt"],
		["a reserved name hidden by a trailing space", "src/CON "],
		["a reserved name hidden by a trailing dot", "src/con."],
	])("refuses %s", (_name, written) => {
		expect(refusalOf(workspace(), written, "win32")).toBe("unspellable");
	});

	// Both are legal filenames off Windows.
	it.each(["src/foo:bar.ts", "src/aux.ts"])("serves %s on linux", (written) => {
		expect(confine(workspace(), written, "linux")).toMatchObject({ ok: true });
	});

	it("refuses a control character on every platform", () => {
		expect(refusalOf(workspace(), "src/ap\u0007p.ts", "linux")).toBe("unspellable");
		expect(refusalOf(workspace(), "src/ap\u0007p.ts", "win32")).toBe("unspellable");
	});

	// Resolved spellings stay valid.
	it("admits spellings that resolve", () => {
		const root = workspace();
		fs.writeFileSync(path.join(root, "src", "backup~1.ts"), "old\n");
		expect(confine(root, "src/backup~1.ts", "win32")).toMatchObject({ ok: true, relative: "src/backup~1.ts" });
	});
});

describe("identity, which is what a hardlink defeats", () => {
	it("reads two names for one inode as the same file", () => {
		const root = workspace();
		const original = path.join(root, "src", "app.ts");
		const linked = path.join(root, "src", "linked.ts");
		fs.linkSync(original, linked);

		expect(sameFile(fileIdentity(original), fileIdentity(linked))).toBe(true);
	});

	it("reads two separate files as different, even with identical bytes", () => {
		const root = workspace();
		const copy = path.join(root, "src", "copy.ts");
		fs.writeFileSync(copy, fs.readFileSync(path.join(root, "src", "app.ts")));

		expect(sameFile(fileIdentity(path.join(root, "src", "app.ts")), fileIdentity(copy))).toBe(false);
	});

	// Nothing must never read as a match.
	it("never matches when a side cannot be statted", () => {
		const root = workspace();
		const held = fileIdentity(path.join(root, "src", "app.ts"));
		expect(sameFile(held, fileIdentity(path.join(root, "src", "gone.ts")))).toBe(false);
	});
});

describe("a listing hides bulk as well as what a read refuses", () => {
	it.each([".git", ".env", ".env.local", "node_modules"])("hides %s", (name) => {
		expect(listable(name, true)).toBe(false);
	});

	it.each(["src", "app.ts", ".env.example"])("shows %s", (name) => {
		expect(listable(name, true)).toBe(true);
	});

	it("hides a reserved name only on Windows", () => {
		expect(listable("NUL", true, "win32")).toBe(false);
		expect(listable("NUL", true, "linux")).toBe(true);
	});

	// The leaf rule applies to leaves.
	it("applies the leaf rule only to a leaf", () => {
		expect(listable(".env.d", false)).toBe(true);
		expect(listable(".env.d", true)).toBe(false);
	});
});
