// The host spawn points a machine offers, and what each one launches.
// Pure: detection and path translation live in the daemon.

import type { SpawnClis } from "./schemasConsoleResults.js";
import type { ContainerState } from "./schemasPresence.js";
import { HARNESS, type LaunchPlace, SESSION_HARNESSES, type SessionHarness } from "./session-harness.js";
import type { GatewaySpawnPoints } from "./types.js";

////////////////////////////////
//  Interfaces & Types

/** Every field is already validated by the caller. */
export interface HostLaunchContext {
	/** `PROJECT_NAME`, the `spawn.session` composite the launched MCP registers under. */
	composite: string;
	harness: SessionHarness;
	/** The invocation without its binary, which differs per spawn point. */
	agentArgs: string;
	/** Runs in place of the CLI's binary. Already shell-safe. */
	program?: string;
	/** `export SWITCHBOARD_SESSION_TOKEN=<hex>; ` or empty. Already shell-safe. */
	exportToken: string;
	/** Absolute, quote-free, already translated for the shell. */
	workdir?: string;
	/** The daemon's bun bin dir, put ahead of PATH. */
	pathPrefix?: string;
}

/** `known: false` (no daemon told us) differs from `known: true, ids: []`. */
export interface HostSpawnState {
	known: boolean;
	ids: string[];
	/** Per CLI, the spawn points whose shell has it, `host` included. */
	harnessSpawns?: Partial<Record<SessionHarness, string[]>>;
	containers?: ContainerState[];
}

export interface HostSpawnPoint {
	/** The spawn segment; must be a valid tmux slug. */
	readonly id: string;
	/** True when every machine has it. A detected one is announced by the daemon instead. */
	readonly alwaysAvailable: boolean;
	/** False means a workdir must be translated first. */
	readonly nativePaths: boolean;
	/** What a CLI's launch rules know it as. */
	readonly place: Exclude<LaunchPlace, "container">;
	/** False when daemon drivers cannot reach CLI stores. */
	readonly driverHome: boolean;
	/** The command tmux runs for a new session. */
	build(ctx: HostLaunchContext): string;
}

////////////////////////////////
//  Registry

export const HOST_SPAWN = "host";
export const WINDOWS_SPAWN = "windows";

/** Windows PowerShell 5.1; `pwsh.exe` is deliberately not preferred. */
const WINDOWS_SHELL = "powershell.exe";

/** A UNC cwd breaks legacy console apps, so callers refuse it. */
export function isUncPath(path: string): boolean {
	return path.startsWith("\\\\");
}

/** `-EncodedCommand` takes base64 of UTF-16LE. */
export function encodePowerShellCommand(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

/** Longer commands are refused at construction. */
export const MAX_LAUNCH_COMMAND_LEN = 8192;

/** Relative to home. */
export const VAULT_ASKPASS_HOME_PATH = ".local/bin/vault-askpass";

/** The session's shell expands `$HOME`. */
export const ASKPASS_EXPORTS = ["SUDO_ASKPASS", "SSH_ASKPASS", "GIT_ASKPASS"]
	.map((name) => `export ${name}="$HOME/${VAULT_ASKPASS_HOME_PATH}"; `)
	.join("");

/** The plugin cannot tell its CLI from its parent process. */
export function agentTypeExport(harness: SessionHarness): string {
	return `export AGENT_TYPE=${harness}; `;
}

const HOST: HostSpawnPoint = {
	id: HOST_SPAWN,
	alwaysAvailable: true,
	nativePaths: true,
	place: "host",
	driverHome: true,
	// `exec bash` keeps the pane peekable after the agent exits.
	build(ctx) {
		const cd = ctx.workdir ? `cd "${ctx.workdir}"; ` : "";
		const path = ctx.pathPrefix ? `export PATH="${ctx.pathPrefix}:$PATH"; ` : "";
		const binary = ctx.program ?? HARNESS[ctx.harness].binary.posix;
		return `bash -c 'source ~/.bashrc; ${path}export PROJECT_NAME=${ctx.composite}; ${agentTypeExport(ctx.harness)}${ctx.exportToken}${ASKPASS_EXPORTS}${cd}${binary} ${ctx.agentArgs}; exec bash'`;
	},
};

/** PowerShell over WSL interop; the tmux session still runs in WSL.
 * WSLENV is appended, not assigned. Set-Location always runs, since an inherited UNC cwd breaks subprocesses. */
const WINDOWS: HostSpawnPoint = {
	id: WINDOWS_SPAWN,
	alwaysAvailable: false,
	nativePaths: false,
	place: "windows",
	driverHome: false,
	build(ctx) {
		if (!ctx.workdir) {
			throw new Error("refusing to launch: a windows session needs a resolved Windows working directory");
		}
		const binary = HARNESS[ctx.harness].binary.windows;
		// Unreachable past launchRefusal.
		if (binary === null || ctx.program) {
			throw new Error(`refusing to launch: ${HARNESS[ctx.harness].label} does not run on a Windows shell`);
		}
		const script = `Set-Location -LiteralPath '${ctx.workdir}'\n${binary} ${ctx.agentArgs}\n`;
		const names = [
			"PROJECT_NAME/w",
			...(ctx.exportToken ? ["SWITCHBOARD_SESSION_TOKEN/w"] : []),
			"AGENT_TYPE/w",
		].join(":");
		const crossed = `export WSLENV="\${WSLENV:+$WSLENV:}${names}"; `;
		return `bash -c 'source ~/.bashrc; export PROJECT_NAME=${ctx.composite}; ${agentTypeExport(ctx.harness)}${ctx.exportToken}${crossed}exec ${WINDOWS_SHELL} -NoLogo -NoExit -EncodedCommand ${encodePowerShellCommand(script)}'`;
	},
};

const REGISTRY: readonly HostSpawnPoint[] = [HOST, WINDOWS];

////////////////////////////////
//  Functions & Helpers

/** Whether a spawn segment names a host shell, not a container. */
export function isHostSpawn(id: string): boolean {
	return REGISTRY.some((p) => p.id === id);
}

/** Whether a team is `<hostSpawn>.<session>`; a bare spawn name is not. */
export function isHostSpawnSession(team: string): boolean {
	const dot = team.indexOf(".");
	if (dot <= 0 || dot === team.length - 1) return false;
	return isHostSpawn(team.slice(0, dot));
}

export function hostSpawnPoint(id: string): HostSpawnPoint | undefined {
	return REGISTRY.find((p) => p.id === id);
}

/** Whether drivers reach CLI stores; containers run their own drivers. */
export function driversReach(spawn: string): boolean {
	return hostSpawnPoint(spawn)?.driverHome ?? true;
}

/** A spawn segment that names no host shell is a container. */
export function launchPlaceOf(spawn: string): LaunchPlace {
	return hostSpawnPoint(spawn)?.place ?? "container";
}

/** Presence and discovery share these. */
export function spawnPointFields(state: HostSpawnState) {
	const harnessSpawns = state.known ? (state.harnessSpawns ?? {}) : {};
	return {
		hostSpawns: state.known ? [...state.ids] : [],
		harnessSpawns,
		// FIXME 2026-11-23: drop both, once every reader takes `harnessSpawns`.
		claudeSpawns: [...(harnessSpawns.claude ?? [])],
		copilotSpawns: [...(harnessSpawns.copilot ?? [])],
		...(state.known && state.containers ? { containers: state.containers.map((held) => ({ ...held })) } : {}),
	};
}

/** Each spawn point's CLIs where known: host shells from `harnessSpawns`, containers once looked inside. */
export function spawnClisOf(points: readonly GatewaySpawnPoints[]): SpawnClis[] {
	return points.flatMap((point) => {
		const hosts = [HOST_SPAWN, ...point.hostSpawns].map((spawn) => ({
			domainId: point.domainId,
			gatewayId: point.gatewayId,
			spawn,
			clis: SESSION_HARNESSES.filter((harness) => point.harnessSpawns?.[harness]?.includes(spawn)),
		}));
		const containers = (point.containers ?? []).flatMap((container) =>
			container.clis
				? [
						{
							domainId: point.domainId,
							gatewayId: point.gatewayId,
							spawn: container.project,
							clis: container.clis,
						},
					]
				: [],
		);
		return [...hosts, ...containers];
	});
}

/** Every host spawn id. */
export function hostSpawnIds(): string[] {
	return REGISTRY.map((p) => p.id);
}

/** The spawn points every machine has. */
export function alwaysAvailableHostSpawns(): string[] {
	return REGISTRY.filter((p) => p.alwaysAvailable).map((p) => p.id);
}

/** The spawn points a machine must probe for. */
export function detectableHostSpawns(): string[] {
	return REGISTRY.filter((p) => !p.alwaysAvailable).map((p) => p.id);
}

/** Build a host spawn point's launch command, refusing an unknown id and an over-long result. */
export function buildHostLaunch(id: string, ctx: HostLaunchContext): string {
	const point = hostSpawnPoint(id);
	if (!point) throw new Error(`"${id}" is not a host spawn point`);
	const command = point.build(ctx);
	if (command.length > MAX_LAUNCH_COMMAND_LEN) {
		throw new Error(`refusing to launch: command is ${command.length} chars (max ${MAX_LAUNCH_COMMAND_LEN})`);
	}
	return command;
}
