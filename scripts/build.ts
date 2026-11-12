// The single release ritual: bump the version, bundle dist/, commit both together.
//
//   bun run build patch|minor|major       # bump, build, commit
//   bun run build --build-only            # bundle at the current version; no bump, no commit
//
// dist/ is committed and must match the committed version, so bump and build are one command.
// package.json is bumped; every other target is set to it.
// The APK versionName and the MCP server derive the version; this script verifies they still do.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGENT_BRIDGES, LAUNCHERS } from "../src/shared/launcher-spec.js";

////////////////////////////////
//  Interfaces & Types

export type BumpKind = "patch" | "minor" | "major";

////////////////////////////////
//  Functions & Helpers

const ROOT = path.join(import.meta.dirname, "..");
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const VERSION_FIELD_RE = /"version"\s*:\s*"[^"]*"/g;

/** The console's baked-in plugins, whose manifests ship inside the APK. */
const PLUGIN_MANIFEST_DIR = path.join("android", "app", "src", "main", "assets", "plugins");

export const ENTRYPOINTS = [
	path.join("src", "main-mcp.ts"),
	path.join("src", "main-vault-askpass.ts"),
	path.join("src", "main-session-hook.ts"),
	...[...Object.values(LAUNCHERS), ...Object.values(AGENT_BRIDGES)].map((spec) =>
		path.join(...spec.entry.split("/")),
	),
];
const DIST_DIR = "dist";

/** Fails once a derivation is replaced by a literal. */
const DERIVED_SITES = [
	{
		file: path.join("android", "app", "build.gradle.kts"),
		needle: 'rootProject.file("../package.json")',
		what: "the APK versionName",
	},
	{
		file: path.join("src", "mcp", "index.ts"),
		needle: "version: packageJson.version",
		what: "the MCP server's declared version",
	},
];

export function nextVersion(current: string, kind: BumpKind): string {
	const parts = SEMVER_RE.exec(current);
	if (!parts) throw new Error(`${current} is not a plain major.minor.patch version`);
	const [major, minor, patch] = parts.slice(1, 4).map(Number);
	if (kind === "major") return `${major + 1}.0.0`;
	if (kind === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

/** Textual, to keep hand formatting; exactly one field is required. */
export function setVersion(text: string, version: string): string {
	const found = text.match(VERSION_FIELD_RE) ?? [];
	if (found.length !== 1) {
		throw new Error(`expected exactly one "version" field, found ${found.length}`);
	}
	return text.replace(VERSION_FIELD_RE, `"version": "${version}"`);
}

export function readVersion(text: string): string {
	const found = text.match(VERSION_FIELD_RE) ?? [];
	if (found.length !== 1) throw new Error(`expected exactly one "version" field, found ${found.length}`);
	return found[0].split('"')[3];
}

/** Every file written; package.json first. */
export function versionTargets(root: string): string[] {
	const pluginsDir = path.join(root, PLUGIN_MANIFEST_DIR);
	if (!existsSync(pluginsDir)) {
		throw new Error(`${PLUGIN_MANIFEST_DIR} is gone; this script's target list is out of date`);
	}
	const manifests = readdirSync(pluginsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(PLUGIN_MANIFEST_DIR, entry.name, "manifest.json"))
		.filter((file) => existsSync(path.join(root, file)))
		.sort();
	return [path.join("package.json"), path.join(".claude-plugin", "plugin.json"), ...manifests];
}

/** Throws unless every derived site still recomputes the version from package.json. */
export function checkDerivedSites(root: string): void {
	for (const site of DERIVED_SITES) {
		const text = readFileSync(path.join(root, site.file), "utf8");
		if (text.includes(site.needle)) continue;
		throw new Error(
			`${site.file} no longer derives ${site.what} from package.json (looked for ${site.needle}).\n` +
				`Either restore the derivation or add the file to this script's target list.`,
		);
	}
}

/** Space-separated fields ahead of the path, per porcelain v2 record type. */
const PATH_FIELD_OFFSET: Record<string, number> = { "1": 8, "2": 9, u: 10 };
const LEXICON_DIR = "lexicon";

function isDistPath(file: string): boolean {
	return file.split("/").includes(DIST_DIR);
}

/** Tracked uncommitted files, so a failed build rolls back with a plain checkout. Cut by field offset, since paths hold spaces. */
export function dirtyTrackedFiles(porcelainV2: string): string[] {
	const dirty: string[] = [];
	for (const line of porcelainV2.split("\n")) {
		const offset = PATH_FIELD_OFFSET[line[0] ?? ""];
		if (offset === undefined || line[1] !== " ") continue;
		let cut = 0;
		for (let seen = 0; seen < offset; seen++) {
			const next = line.indexOf(" ", cut);
			if (next === -1) {
				cut = -1;
				break;
			}
			cut = next + 1;
		}
		if (cut === -1) continue;
		const file = (line.slice(cut).split("\t")[0] ?? "").trim();
		const fields = line.split(" ", 4);
		const submoduleState = fields[2] ?? "";
		if (submoduleState.startsWith("S")) {
			if (`${fields[1] ?? ""} ${submoduleState}` === ".M S..U") continue;
			dirty.push(file);
			continue;
		}
		if (file && !isDistPath(file)) dirty.push(file);
	}
	return dirty;
}

function git(args: string[], root: string): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function assertLexiconInputs(root: string): void {
	const status = git(["submodule", "status", "--", LEXICON_DIR], root).trimEnd();
	const record = status.split("\n").find((line) => line.trim().split(/\s+/)[1] === LEXICON_DIR);
	if (!record) throw new Error("lexicon submodule is empty or uninitialized");
	if (record.startsWith("-")) throw new Error("lexicon submodule is uninitialized");

	const subject = git(["-C", LEXICON_DIR, "log", "-1", "--format=%s"], root).trim();
	if (!/^Build \d+\.\d+\.\d+$/.test(subject)) {
		throw new Error(`lexicon submodule must be pinned to a Build x.y.z commit, got: ${subject || "(empty)"}`);
	}
	console.log(`lexicon: ${subject}`);

	const rootManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	const protocol = JSON.parse(readFileSync(path.join(root, LEXICON_DIR, "protocol", "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	for (const [name, version] of Object.entries(protocol.dependencies ?? {})) {
		if (rootManifest.dependencies?.[name] !== version) {
			throw new Error(`root package.json must pin ${name} to ${version}`);
		}
	}

	const client = JSON.parse(readFileSync(path.join(root, LEXICON_DIR, "client", "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	const clientDependencies = Object.entries(client.dependencies ?? {});
	if (
		clientDependencies.length !== 1 ||
		clientDependencies[0]?.[0] !== "@nyaa-lexicon/protocol" ||
		clientDependencies[0]?.[1] !== "workspace:*"
	) {
		throw new Error("lexicon/client/package.json may depend only on @nyaa-lexicon/protocol");
	}

	const lexicon = path.join(root, LEXICON_DIR);
	const installs = [
		path.join(lexicon, "node_modules"),
		...readdirSync(lexicon, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(lexicon, entry.name, "node_modules")),
	];
	for (const nested of installs) {
		if (existsSync(nested)) {
			throw new Error(`Remove ${nested} before building; nested lexicon installs shadow root pins`);
		}
	}
}

////////////////////////////////
//  Main

function main(argv: string[]): void {
	const buildOnly = argv.includes("--build-only");
	const kind = argv.find((arg) => !arg.startsWith("-"));

	if (!buildOnly && kind !== "patch" && kind !== "minor" && kind !== "major") {
		console.error("usage: bun run build patch|minor|major");
		console.error("       bun run build --build-only");
		process.exit(2);
	}

	assertLexiconInputs(ROOT);

	// Before writing anything; half a bump is worse than none.
	checkDerivedSites(ROOT);

	// A tool a GPT host refuses fails every message a Copilot session sends.
	try {
		execFileSync("bun", ["scripts/check-tool-definitions.ts"], { cwd: ROOT, stdio: "inherit" });
	} catch {
		console.error("\nbuild refused: a tool definition is over the limit");
		process.exit(1);
	}

	// A clean tree makes the rollback safe.
	if (!buildOnly) {
		const dirty = dirtyTrackedFiles(git(["status", "--porcelain=v2", "--branch"], ROOT));
		if (dirty.length > 0) {
			console.error("Commit your work before building. Uncommitted changes to tracked files:");
			for (const file of dirty) console.error(`  ${file}`);
			console.error("\n(untracked files are fine; --build-only skips this check)");
			process.exit(1);
		}
	}

	const targets = versionTargets(ROOT);
	const current = readVersion(readFileSync(path.join(ROOT, targets[0]), "utf8"));
	const version = buildOnly ? current : nextVersion(current, kind as BumpKind);

	if (!buildOnly) {
		for (const target of targets) {
			const file = path.join(ROOT, target);
			const text = readFileSync(file, "utf8");
			const was = readVersion(text);
			writeFileSync(file, setVersion(text, version));
			console.log(`set ${target}: ${was} -> ${version}`);
		}
	}
	for (const site of DERIVED_SITES) console.log(`derives ${site.what} from package.json: ${site.file}`);

	// No stale output in the commit.
	rmSync(path.join(ROOT, DIST_DIR), { recursive: true, force: true });

	try {
		execFileSync(
			"bun",
			["build", ...ENTRYPOINTS, "--outdir", DIST_DIR, "--target", "node", "--minify", "--format", "esm"],
			{ cwd: ROOT, stdio: "inherit" },
		);
	} catch {
		// bun already printed the error.
		if (!buildOnly) {
			git(["checkout", "--", ...targets], ROOT);
			console.error(`\nbuild failed; reverted ${targets.length} version file(s) to ${current}`);
		} else {
			console.error("\nbuild failed");
		}
		process.exit(1);
	}

	if (buildOnly) {
		console.log(`\nbuilt ${DIST_DIR}/ at ${version}. Nothing bumped, nothing committed.`);
		return;
	}

	git(["add", "--", ...targets, DIST_DIR], ROOT);
	git(["commit", "-m", `Build ${version}`], ROOT);
	console.log(`\n${current} -> ${version}, committed as "Build ${version}". Push, then reload plugins.`);
}

if (path.basename(process.argv[1] ?? "") === "build.ts") main(process.argv.slice(2));
