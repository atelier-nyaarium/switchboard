// One OpenCode server and its terminal UI.

import path from "node:path";
import type { LaunchStatus } from "../shared/launch-status.js";
import {
	locationQuery,
	OPENCODE_GREETING_ID,
	OPENCODE_MCP_NAME,
	OPENCODE_SERVER_ENV,
	type OpencodeServerFile,
	opencodeAuth,
	parseOpencodeVersion,
} from "../shared/opencode.js";
import { HARNESS, versionRefusal } from "../shared/session-harness.js";

////////////////////////////////
//  Interfaces & Types

export interface LaunchArgs {
	sessionId: string;
	statusFile: string;
	greet: boolean;
}

export interface ServerHandle {
	/** Its announced URL, or undefined when it exited first. */
	url: Promise<string | undefined>;
	/** Closes its stdin, which ends it. */
	stop(): void;
	exited: Promise<void>;
	/** Its last error output, never shown in the pane. */
	errorTail(): string;
}

export interface LauncherPorts {
	/** This launcher's own process, named in its status. */
	pid: number;
	env: Readonly<Record<string, string | undefined>>;
	home: string;
	cwd: string;
	/** The bun this launcher runs on. */
	runtime: string;
	/** Holds `dist/` and `launch/`. */
	root: string;
	greeting: string;
	isExecutable(file: string): boolean;
	/** Stdout of `<binary> --version`, or undefined. */
	readVersion(binary: string): Promise<string | undefined>;
	startServer(binary: string, env: Record<string, string>): ServerHandle;
	/** Runs the terminal UI on this terminal; resolves with its exit code. */
	runUi(binary: string, args: string[], env: Record<string, string>): Promise<number>;
	fetch: typeof fetch;
	randomPassword(): string;
	/** A new directory only the owner can read. */
	makePrivateDir(): string;
	writePrivateFile(file: string, text: string): void;
	readFile(file: string): string | undefined;
	remove(target: string): void;
	sleep(ms: number): Promise<void>;
	now(): number;
	log(line: string): void;
}

////////////////////////////////
//  Constants

// Their sum stays under the daemon's wait.
const SERVER_START_MS = 30_000;
const MCP_CONNECT_MS = 30_000;
const CALL_TIMEOUT_MS = 15_000;
const POLL_MS = 250;
const SUPERVISE_MS = 5000;

/** The sidebar opens past 120 columns and crowds a phone's view. */
const UI_CONFIG = { tabs: { mode: "off" }, session: { sidebar: "hide" } };

////////////////////////////////
//  Functions & Helpers

export function parseLaunchArgs(argv: readonly string[]): LaunchArgs | undefined {
	let sessionId: string | undefined;
	let statusFile: string | undefined;
	let greet = false;
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--session") sessionId = argv[++index];
		else if (flag === "--status") statusFile = argv[++index];
		else if (flag === "--greet") greet = true;
		else return undefined;
	}
	if (!sessionId || !HARNESS.opencode.sessionId.shape.test(sessionId)) return undefined;
	if (!statusFile || !path.isAbsolute(statusFile)) return undefined;
	return { sessionId, statusFile, greet };
}

/** PATH first, then the installer's own directory. */
export function findBinary(ports: Pick<LauncherPorts, "env" | "home" | "isExecutable">): string | undefined {
	const { posix, homeDir } = HARNESS.opencode.binary;
	const dirs = (ports.env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
	if (homeDir) dirs.push(path.join(ports.home, homeDir));
	return dirs.map((dir) => path.join(dir, posix)).find((file) => ports.isExecutable(file));
}

/** The model the terminal UI last picked, or undefined. */
export function lastPickedModel(
	text: string | undefined,
): { id: string; providerID: string; variant?: string } | undefined {
	if (!text) return undefined;
	let state: unknown;
	try {
		state = JSON.parse(text);
	} catch {
		return undefined;
	}
	const { recent, variant } = (state ?? {}) as { recent?: unknown; variant?: unknown };
	const first = Array.isArray(recent) ? (recent[0] as Record<string, unknown> | undefined) : undefined;
	if (typeof first?.providerID !== "string" || typeof first.modelID !== "string") return undefined;
	const picked = (variant as Record<string, unknown> | undefined)?.[`${first.providerID}/${first.modelID}`];
	return {
		id: first.modelID,
		providerID: first.providerID,
		...(typeof picked === "string" ? { variant: picked } : {}),
	};
}

/** The server's launch config. */
export function serverConfig(ports: Pick<LauncherPorts, "runtime" | "root">, serverFile: string): string {
	return JSON.stringify({
		update: "disable",
		// An idle location unloads its MCP child.
		experimental: { location_idle_timeout: false },
		mcp: {
			servers: {
				[OPENCODE_MCP_NAME]: {
					type: "local",
					command: [
						ports.runtime,
						`--config=${path.join(ports.root, "launch", "bunfig.toml")}`,
						`--tsconfig-override=${path.join(ports.root, "launch", "tsconfig.json")}`,
						"--no-env-file",
						"--no-install",
						path.join(ports.root, "dist", "main-mcp.js"),
					],
					codemode: false,
					environment: { [OPENCODE_SERVER_ENV]: serverFile, AGENT_TYPE: "opencode" },
				},
			},
		},
	});
}

function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
	return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	try {
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Runs the whole launch; resolves with the exit code. */
export async function runLauncher(args: LaunchArgs, ports: LauncherPorts): Promise<number> {
	const { pid } = ports;
	const writeStatus = (status: LaunchStatus): void => {
		try {
			ports.writePrivateFile(args.statusFile, JSON.stringify(status));
		} catch (error) {
			ports.log(`could not write the launch status: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const fail = (error: string): number => {
		ports.log(`Switchboard could not start OpenCode: ${error}`);
		writeStatus({ state: "failed", pid, error: error.slice(0, 2048) });
		return 1;
	};

	writeStatus({ state: "starting", pid });

	const binary = findBinary(ports);
	if (!binary) return fail("OpenCode is not installed");
	const version = parseOpencodeVersion((await ports.readVersion(binary)) ?? "");
	const refusal = versionRefusal("opencode", version);
	if (refusal) return fail(refusal);

	const password = ports.randomPassword();
	const privateDir = ports.makePrivateDir();
	const serverFile = path.join(privateDir, "server.json");
	const base = definedEnv(ports.env);
	const server = ports.startServer(binary, {
		...base,
		OPENCODE_PASSWORD: password,
		OPENCODE_CONFIG_CONTENT: serverConfig(ports, serverFile),
	});
	const cleanup = async (): Promise<void> => {
		server.stop();
		await Promise.race([server.exited, ports.sleep(5000)]);
		ports.remove(privateDir);
	};

	const url = await Promise.race([server.url, ports.sleep(SERVER_START_MS).then(() => undefined)]);
	if (!url) {
		await cleanup();
		const said = server.errorTail().trim();
		return fail(`the OpenCode server did not start${said ? `: ${said}` : ""}`);
	}
	const headers = { authorization: opencodeAuth(password), "content-type": "application/json" };
	// A server that accepts and never answers must not hold the launch.
	const call = (method: string, route: string, body?: unknown): Promise<Response> =>
		ports.fetch(`${url}${route}`, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
		});
	const mcpStatus = async (): Promise<{ status?: string; error?: string } | undefined> => {
		const listed = await call("GET", `/api/mcp?${locationQuery(ports.cwd)}`);
		const servers = ((await readJson(listed)).data ?? []) as Array<{
			name?: string;
			status?: { status?: string; error?: string };
		}>;
		return servers.find((entry) => entry.name === OPENCODE_MCP_NAME)?.status;
	};

	try {
		const file: OpencodeServerFile = { url, password, sessionId: args.sessionId, directory: ports.cwd };
		ports.writePrivateFile(serverFile, JSON.stringify(file));

		const held = await call("GET", `/api/session/${args.sessionId}`);
		if (held.status === 404) {
			const stateHome = ports.env.XDG_STATE_HOME || path.join(ports.home, ".local", "state");
			const model = lastPickedModel(ports.readFile(path.join(stateHome, "opencode", "model.json")));
			const { permissions } = HARNESS.opencode;
			const created = await call("POST", "/api/session", {
				id: args.sessionId,
				location: { directory: ports.cwd },
				...(model ? { model } : {}),
				...(permissions.length > 0 ? { permissions } : {}),
			});
			if (!created.ok) throw new Error(`the session was not created (HTTP ${created.status})`);
		} else if (!held.ok) {
			throw new Error(`the session could not be read (HTTP ${held.status})`);
		}

		// The first location call starts the MCP child.
		const deadline = ports.now() + MCP_CONNECT_MS;
		for (;;) {
			const status = await mcpStatus();
			if (status?.status === "connected") break;
			if (status?.status === "failed") {
				throw new Error(`the Switchboard MCP server failed: ${status.error ?? "no reason given"}`);
			}
			if (ports.now() >= deadline) throw new Error("the Switchboard MCP server did not connect");
			await ports.sleep(POLL_MS);
		}

		// Best effort: a greeting never fails a launch.
		if (args.greet) {
			const greeted = await call("POST", `/api/session/${args.sessionId}/prompt`, {
				id: OPENCODE_GREETING_ID,
				text: ports.greeting,
			}).catch(() => undefined);
			if (!greeted?.ok) ports.log(`the greeting was not taken${greeted ? ` (HTTP ${greeted.status})` : ""}`);
		}
	} catch (error) {
		await cleanup();
		return fail(error instanceof Error ? error.message : String(error));
	}

	writeStatus({ state: "ready", pid, version: version ?? "" });
	const watching = { on: true };
	// The UI reconnects forever to a dead server, so the daemon must hear it and relaunch.
	void server.exited.then(() => {
		if (watching.on) writeStatus({ state: "failed", pid, error: "the OpenCode server exited" });
	});
	// OpenCode never restarts a dead MCP child, and the session is offline without it. Silent, since
	// the terminal UI owns the pane.
	const supervised = (async () => {
		while (watching.on) {
			await ports.sleep(SUPERVISE_MS);
			if (!watching.on) return;
			try {
				if ((await mcpStatus())?.status !== "failed") continue;
				await call("POST", `/api/experimental/mcp/${OPENCODE_MCP_NAME}/connect?${locationQuery(ports.cwd)}`);
			} catch {
				// The next pass retries.
			}
		}
	})();
	let code = 1;
	try {
		code = await ports.runUi(binary, ["--server", url, "--session", args.sessionId], {
			...base,
			OPENCODE_PASSWORD: password,
			OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify(UI_CONFIG),
		});
	} finally {
		watching.on = false;
		// No wake keeps a launcher that is leaving.
		writeStatus({ state: "exited", pid, code });
		await cleanup();
		await supervised;
	}
	return code;
}
