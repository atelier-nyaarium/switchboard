import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyWorkdir, resolveWorkdir, type WorkdirContext, workdirOrFallback } from "../../shared/agent-workdir.js";
import {
	ASSISTANT_BUILTIN_TOOLS,
	ASSISTANT_SWITCHBOARD_TOOLS,
	ASSISTANT_TEAM,
	SWITCHBOARD_TOOL_PREFIX,
} from "../../shared/assistant-session.js";
import { type HostListDirsResult, isReservedHostSession, isTmuxName, type TmuxTarget } from "../../shared/host-op.js";
import {
	ASKPASS_EXPORTS,
	agentTypeExport,
	buildHostLaunch,
	isHostSpawn,
	launchPlaceOf,
} from "../../shared/host-spawn.js";
import { HARNESS, launchRefusal, resumableId, type SessionHarness } from "../../shared/session-harness.js";
import { composeSessionName, parseSessionName } from "../../shared/session-id.js";
import { CHANNEL_FILES_DIR } from "../channel/channelFiles.js";

////////////////////////////////
//  Functions & Helpers

const HOME = os.homedir();
let projectDirs: string[] = [path.join(HOME, "projects")];

/** An empty list leaves the current roots. */
export function setProjectDirs(dirs: string[]): void {
	if (dirs.length > 0) projectDirs = dirs;
}

////////////////////////////////
//  Catalog scanner

export function scanDevcontainerProjects(): Array<{ team: string; projectPath: string }> {
	const results: Array<{ team: string; projectPath: string }> = [];
	for (const dir of projectDirs) {
		const resolved = path.isAbsolute(dir) ? dir : path.join(HOME, dir);
		let entries: string[];
		try {
			entries = fs.readdirSync(resolved);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(resolved, entry);
			// A directory named after a host spawn point would make `windows.<session>` mean two
			// different things - a PowerShell shell and a devcontainer - and `isHostSpawn` would win
			// at every resolver while catalog membership disagreed. Refused at the scan so the
			// ambiguity never enters the catalog at all.
			if (isHostSpawn(entry)) continue;
			try {
				if (!fs.statSync(full).isDirectory()) continue;
				if (fs.existsSync(path.join(full, ".devcontainer", "devcontainer.json"))) {
					results.push({ team: entry, projectPath: full });
				}
			} catch {
				// skip inaccessible entries
			}
		}
	}
	return results;
}

////////////////////////////////
//  Workdir resolution

export function findProjectPath(team: string): string {
	for (const dir of projectDirs) {
		const resolved = path.isAbsolute(dir) ? dir : path.join(HOME, dir);
		const candidate = path.join(resolved, team);
		if (fs.existsSync(path.join(candidate, ".devcontainer", "devcontainer.json"))) {
			return candidate;
		}
	}
	return path.join(projectDirs[0], team);
}

/** Null for any other shape, so a label is never treated as a path. */
function expandWorkdirPath(value: string, home: string): string | null {
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return value.startsWith("/") ? value : null;
}

/** This machine's roots and home, for anything asking the shared resolver a question about it. */
export function hostWorkdirContext(dirs: string[] = projectDirs, home: string = HOME): WorkdirContext {
	return { roots: dirs, home };
}

/** The daemon's binding of the shared rule. It contributes the one thing that legitimately differs
 * per machine - which roots a bare label is looked up under - and nothing else: the grammar and the
 * fallback belong to `agent-workdir.ts`, so the daemonless path cannot read the same string
 * differently. Still answers a bare directory, since reporting a refusal instead is a change to a
 * contract `codexTools` documents to callers and ships separately. */
export function resolveHostWorkdir(
	hint: string | undefined,
	dirs: string[] = projectDirs,
	home: string = HOME,
): string {
	return workdirOrFallback(resolveWorkdir(hint, "sessionWorkdirHint", hostWorkdirContext(dirs, home)));
}

// A wire bound, not a UX cap.
const MAX_DIR_ENTRIES = 5000;

/** Immediate subdirectories, sorted case-insensitively. Empty rather than erroring: this feeds an
 * autocomplete, which has no use for the reason.
 *
 * A blank path is this machine's home, and the answer says so: the caller asked for the default
 * directory without knowing its spelling, so the names alone would not tell it where they sit. */
export function listHostDirs(rawPath: string, home: string = HOME): HostListDirsResult {
	const blank = rawPath.length === 0;
	const resolved = blank ? home : expandWorkdirPath(rawPath, home);
	if (resolved == null) return { entries: [] };
	const where = blank ? { path: resolved } : {};
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(resolved, { withFileTypes: true });
	} catch {
		return { entries: [] };
	}
	const entries: string[] = [];
	for (const d of dirents) {
		let isDir = d.isDirectory();
		if (!isDir && d.isSymbolicLink()) {
			try {
				isDir = fs.statSync(path.join(resolved, d.name)).isDirectory();
			} catch {
				// dangling symlink
			}
		}
		if (isDir) entries.push(d.name);
	}
	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
	if (entries.length > MAX_DIR_ENTRIES) {
		return { entries: entries.slice(0, MAX_DIR_ENTRIES), truncated: true, ...where };
	}
	return { entries, ...where };
}

////////////////////////////////
//  Launch command

const CHANNEL_FLAG = "--dangerously-load-development-channels plugin:switchboard@atelier-nyaarium";

/** Files the assistant never edits, at any depth, and secrets it never reads. */
const ASSISTANT_DENY = [
	// Its own root `AGENTS.md` stays writable.
	"Edit(*/**/AGENTS.md)",
	"Edit(CLAUDE.md)",
	"Edit(CLAUDE.local.md)",
	"Edit(.claude/**)",
	"Edit(.mcp.json)",
	"Edit(.git/**)",
	"Edit(package.json)",
	"Read(.env)",
	"Read(.env.*)",
];

/** Inside double quotes in a single-quoted `bash -c`: nothing here may expand or close a quote. */
const PLAIN_ABSOLUTE = /^\/[A-Za-z0-9_./ -]+$/;

/** Home itself, or a folder above it, would grant the assistant edits across all of home. */
function holdsHome(dir: string, home: string): boolean {
	const fromHome = path.relative(path.resolve(dir), home);
	return fromHome === "" || !fromHome.startsWith("..");
}

/**
 * Creates the assistant's folder, parents included, when it is missing. Placing names a folder on
 * a disk the Gateway cannot see, so the launch is where it comes into being. Only a plain path
 * that leaves home out is made; anything else is left to the ordinary resolution and its refusals.
 */
export function ensureAssistantWorkdir(hint: string | undefined, home: string = HOME): void {
	const shape = classifyWorkdir(hint, "sessionWorkdirHint", home);
	if (shape.kind !== "path" || !PLAIN_ABSOLUTE.test(shape.value) || holdsHome(shape.value, home)) return;
	fs.mkdirSync(shape.value, { recursive: true });
}

/**
 * The assistant runs on Claude Code's own permission engine: anything not allowed is denied
 * without asking, and its check and open are one step. Every other session keeps the open profile.
 */
export function assistantPermissionArgs(workdir: string | undefined, home: string = HOME): string {
	if (!workdir || !PLAIN_ABSOLUTE.test(workdir)) {
		throw new Error("refusing to launch the assistant: its workdir is not a plain absolute path");
	}
	// An unresolved workdir falls back to home, which would grant edits across all of it.
	if (holdsHome(workdir, home)) {
		throw new Error("refusing to launch the assistant: its workdir holds the home directory");
	}
	if (!fs.statSync(workdir, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`refusing to launch the assistant: ${workdir} is not a directory`);
	}
	// The settings name the spelled path; a link would grant the place it leads to.
	if (fs.realpathSync(workdir) !== path.resolve(workdir)) {
		throw new Error(`refusing to launch the assistant: ${workdir} is reached through a link`);
	}
	const settings = {
		permissions: {
			allow: [
				`Edit(/${workdir}/**)`,
				`Read(/${CHANNEL_FILES_DIR}/**)`,
				...ASSISTANT_SWITCHBOARD_TOOLS.map((tool) => `${SWITCHBOARD_TOOL_PREFIX}${tool}`),
			],
			deny: [...ASSISTANT_DENY],
			additionalDirectories: [CHANNEL_FILES_DIR],
			disableBypassPermissionsMode: "disable",
		},
	};
	const json = JSON.stringify(settings).replaceAll('"', '\\"');
	return `--permission-mode dontAsk --tools ${ASSISTANT_BUILTIN_TOOLS.join(",")} --settings "${json}"`;
}

/** Where a launcher-run CLI's launcher lives and reports. */
export interface SessionLauncher {
	/** The bun that runs it. */
	runtime: string;
	/** Holds `dist/` and `launch/`. */
	root: string;
	/** Where it writes how the launch went. */
	statusFile: string;
	/** Its first prompt is the greeting. */
	greet: boolean;
}

interface LaunchArgsContext {
	/** Validated; absent starts fresh. */
	resumeSessionId?: string;
	/** Claude's permission flags. */
	permissions: () => string;
	launcher?: SessionLauncher;
}

/** A launch's program and arguments. No program runs the row's binary. */
interface LaunchSpec {
	program?: string;
	args: string;
}

export const OPENCODE_LAUNCH_BUNDLE = "main-opencode-launch.js";

/** Double-quoted inside the launch's single quotes. */
function plainPath(value: string, what: string): string {
	if (!PLAIN_ABSOLUTE.test(value)) throw new Error(`refusing to launch: ${what} is not a plain absolute path`);
	return `"${value}"`;
}

const LAUNCH: Record<SessionHarness, (ctx: LaunchArgsContext) => LaunchSpec> = {
	// The model is quoted: brackets would glob in `bash -c`.
	claude: (ctx) => ({
		args: `--model "opus[1m]" --effort xhigh ${ctx.permissions()} ${CHANNEL_FLAG}${ctx.resumeSessionId ? ` --resume ${ctx.resumeSessionId}` : ""}`,
	}),
	// The launcher starts its server, then its terminal UI.
	opencode: (ctx) => {
		const { launcher, resumeSessionId } = ctx;
		if (!launcher) throw new Error("refusing to launch: no OpenCode launcher on this machine");
		if (!resumeSessionId) throw new Error("refusing to launch: an OpenCode session needs its minted id");
		const root = plainPath(launcher.root, "the launcher's root").slice(1, -1);
		return {
			program: [
				plainPath(launcher.runtime, "the launcher's runtime"),
				// A project's bun settings and env never apply; bundled, so no tsconfig.
				`--config="${root}/launch/bunfig.toml"`,
				"--no-env-file",
				"--no-install",
				`"${root}/dist/${OPENCODE_LAUNCH_BUNDLE}"`,
			].join(" "),
			args: `--session ${resumeSessionId} --status ${plainPath(launcher.statusFile, "the status file")}${launcher.greet ? " --greet" : ""}`,
		};
	},
	// Its id names the session before it exists, so one flag starts and resumes.
	copilot: (ctx) => ({
		args: `--allow-all --no-ask-user${ctx.resumeSessionId ? ` --session-id ${ctx.resumeSessionId}` : ""}`,
	}),
};

// One `bash -c`: the PROJECT_NAME override must run in the same shell as claude, after ~/.bashrc.
// A host target dispatches on its spawn NAME through the registry, which is what lets a machine
// offer more than one shell; `kind` stays the tmux LOCATION (bare tmux here, `docker exec` there)
// and says nothing about which interpreter runs. A second field naming the shell would have to agree
// with the name forever, so there isn't one.
export function buildLaunchCommand(
	target: TmuxTarget,
	opts: {
		harness: SessionHarness;
		resumeSessionId?: string;
		workdir?: string;
		sessionToken?: string;
		pathPrefix?: string;
		launcher?: SessionLauncher;
	},
): string {
	const composite = composeSessionName(target.name, target.sessionName);
	const row = HARNESS[opts.harness];
	const resumeSessionId = resumableId(opts.harness, opts.resumeSessionId);
	// Refused, not dropped: a session that cannot claim its name is harder to diagnose.
	if (opts.sessionToken && !/^[0-9a-f]{16,}$/.test(opts.sessionToken)) {
		throw new Error(`refusing to launch: session token is not the expected hex form`);
	}
	const exportToken = opts.sessionToken ? `export SWITCHBOARD_SESSION_TOKEN=${opts.sessionToken}; ` : "";
	const refusal = launchRefusal(opts.harness, {
		place: target.kind === "host" ? launchPlaceOf(target.name) : "container",
		assistant: composite === ASSISTANT_TEAM,
	});
	if (refusal) throw new Error(`refusing to launch: ${refusal}`);
	const spec = LAUNCH[opts.harness]({
		...(resumeSessionId ? { resumeSessionId } : {}),
		...(opts.launcher ? { launcher: opts.launcher } : {}),
		permissions: () =>
			composite === ASSISTANT_TEAM ? assistantPermissionArgs(opts.workdir) : "--dangerously-skip-permissions",
	});
	if (target.kind === "host") {
		// Either quote would break out of the nesting, so a workdir bearing one is dropped.
		const safeWorkdir = opts.workdir && !opts.workdir.includes("'") && !opts.workdir.includes('"');
		// Dropped unless it is a plain absolute path, for the same reason.
		const safePathPrefix = opts.pathPrefix && /^\/[A-Za-z0-9_./-]+$/.test(opts.pathPrefix);
		return buildHostLaunch(target.name, {
			composite,
			harness: opts.harness,
			agentArgs: spec.args,
			...(spec.program ? { program: spec.program } : {}),
			exportToken,
			workdir: safeWorkdir ? opts.workdir : undefined,
			pathPrefix: safePathPrefix ? opts.pathPrefix : undefined,
		});
	}
	// Keeps the pane peekable after exit.
	return `bash -c 'source ~/.bashrc; export PROJECT_NAME=${composite}; ${agentTypeExport(opts.harness)}${exportToken}${ASKPASS_EXPORTS}cd /workspace/${target.name}; ${spec.program ?? row.binary.posix} ${spec.args}; exec bash'`;
}

////////////////////////////////
//  First-launch greeting

// Wake reports created too.
export function shouldGreetLaunch(opts: {
	created: boolean;
	ready: boolean;
	resumeSessionId?: string;
	/** Its session has never confirmed. */
	fresh?: boolean;
}): boolean {
	// A minted id resumes nothing yet.
	return opts.created && opts.ready && (opts.fresh === true || !opts.resumeSessionId);
}

////////////////////////////////
//  Watch target resolution

// No bring-up: a watched team is already live.
export function resolveWatchTarget(team: string): TmuxTarget | undefined {
	const { project, session } = parseSessionName(team);
	if (!isTmuxName(project) || !isTmuxName(session)) return undefined;
	// Registry-wide, so the daemon's reserved session is refused under EVERY host spawn point
	// (`windows.host-daemon` as much as `host.host-daemon`) rather than only the one named here.
	if (isHostSpawn(project)) {
		if (isReservedHostSession(session)) return undefined;
		return { kind: "host", name: project, sessionName: session };
	}
	return { kind: "devcontainer", name: project, sessionName: session };
}
