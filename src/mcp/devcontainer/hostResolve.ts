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
import { LAUNCHERS } from "../../shared/launcher-spec.js";
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
	return scanProjectFolders().projects;
}

/** No address segment, no project. */
export function scanProjectFolders(): {
	projects: Array<{ team: string; projectPath: string }>;
	unaddressable: string[];
} {
	const results: Array<{ team: string; projectPath: string }> = [];
	const unaddressable: string[] = [];
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
			// A host spawn name would be ambiguous in the catalog.
			if (isHostSpawn(entry)) continue;
			try {
				if (!fs.statSync(full).isDirectory()) continue;
				if (!fs.existsSync(path.join(full, ".devcontainer", "devcontainer.json"))) continue;
				if (isTmuxName(entry)) results.push({ team: entry, projectPath: full });
				else unaddressable.push(entry);
			} catch {
				// skip inaccessible entries
			}
		}
	}
	return { projects: results, unaddressable };
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

/** Only the roots differ per machine; grammar lives in `agent-workdir.ts`. */
export function resolveHostWorkdir(
	hint: string | undefined,
	dirs: string[] = projectDirs,
	home: string = HOME,
): string {
	return workdirOrFallback(resolveWorkdir(hint, "sessionWorkdirHint", hostWorkdirContext(dirs, home)));
}

// A wire bound, not a UX cap.
const MAX_DIR_ENTRIES = 5000;

/** Sorted subdirectories; empty on error. A blank path is home, and the answer names it. */
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

/** Creates the assistant's folder when missing; only plain paths outside home. */
export function ensureAssistantWorkdir(hint: string | undefined, home: string = HOME): void {
	const shape = classifyWorkdir(hint, "sessionWorkdirHint", home);
	if (shape.kind !== "path" || !PLAIN_ABSOLUTE.test(shape.value) || holdsHome(shape.value, home)) return;
	fs.mkdirSync(shape.value, { recursive: true });
}

/** Anything not allowed is denied without asking. */
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

/** Double-quoted inside the launch's single quotes. */
function plainPath(value: string, what: string): string {
	if (!PLAIN_ABSOLUTE.test(value)) throw new Error(`refusing to launch: ${what} is not a plain absolute path`);
	return `"${value}"`;
}

/** Its launcher starts its server, then its terminal UI. */
function viaLauncher(harness: SessionHarness, ctx: LaunchArgsContext): LaunchSpec {
	const row = HARNESS[harness];
	if (row.road.kind !== "api") throw new Error(`refusing to launch: ${row.label} has no launcher`);
	const { launcher, resumeSessionId } = ctx;
	if (!launcher) throw new Error(`refusing to launch: no ${row.label} launcher on this machine`);
	if (!resumeSessionId) throw new Error(`refusing to launch: a ${row.label} session needs its minted id`);
	const spec = LAUNCHERS[row.road.server];
	const root = plainPath(launcher.root, "the launcher's root").slice(1, -1);
	return {
		program: [
			plainPath(launcher.runtime, "the launcher's runtime"),
			// A project's bun settings and env never apply; bundled, so no tsconfig.
			`--config="${root}/launch/bunfig.toml"`,
			"--no-env-file",
			"--no-install",
			`"${root}/dist/${spec.bundle}"`,
		].join(" "),
		args: spec
			.argv({
				sessionId: resumeSessionId,
				statusFile: plainPath(launcher.statusFile, "the status file"),
				greet: launcher.greet,
			})
			.join(" "),
	};
}

const LAUNCH: Record<SessionHarness, (ctx: LaunchArgsContext) => LaunchSpec> = {
	// The model is quoted: brackets would glob in `bash -c`.
	claude: (ctx) => ({
		args: `--model "opus[1m]" --effort xhigh ${ctx.permissions()} ${CHANNEL_FLAG}${ctx.resumeSessionId ? ` --resume ${ctx.resumeSessionId}` : ""}`,
	}),
	opencode: (ctx) => viaLauncher("opencode", ctx),
	// Its id names the session before it exists, so one flag starts and resumes.
	copilot: (ctx) => ({
		args: `--allow-all --no-ask-user${ctx.resumeSessionId ? ` --session-id ${ctx.resumeSessionId}` : ""}`,
	}),
};

// One `bash -c`: PROJECT_NAME must be set in claude's shell, after ~/.bashrc.
// A host target dispatches on spawn name; `kind` is only the tmux location.
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
		// A quote would break the nesting.
		const safeWorkdir = opts.workdir && !opts.workdir.includes("'") && !opts.workdir.includes('"');
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
	// Reserved session is refused under every host spawn point.
	if (isHostSpawn(project)) {
		if (isReservedHostSession(session)) return undefined;
		return { kind: "host", name: project, sessionName: session };
	}
	return { kind: "devcontainer", name: project, sessionName: session };
}
