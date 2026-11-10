import { describe, expect, it } from "vitest";
import {
	findBinary,
	type LauncherPorts,
	lastPickedModel,
	parseLaunchArgs,
	runLauncher,
} from "../opencode-launch/launcher.js";
import { readLaunchStatus } from "../shared/launch-status.js";
import { OPENCODE_GREETING_ID, OPENCODE_SERVER_ENV, OpencodeServerFileSchema } from "../shared/opencode.js";
import { OPENCODE_PIN } from "../shared/session-harness.js";
import { createFakeOpencodeServer, type FakeOpencodeServer } from "../testing/fakeOpencodeServer.js";

const SESSION = "ses_sb0f8b2a4c1d3e4f5a9b6c7d8e9f0a1b2c";
const STATUS = "/run/sb/host.oc.json";
const BINARY = "/home/me/.opencode/bin/opencode";
const MODEL_FILE = "/home/me/.local/state/opencode/model.json";

const PID = 4242;

interface Rig {
	server: FakeOpencodeServer;
	ports: LauncherPorts;
	files: Map<string, string>;
	serverEnv: Array<Record<string, string>>;
	uiRuns: string[][];
	stops: () => number;
	/** Exits the running UI; an error rejects it. */
	exitUi(code: number | Error): void;
	/** The server dies on its own. */
	crashServer(): void;
	/** Runs on every launcher sleep. */
	onSleep: { hook?: () => void };
	/** Runs as the server is stopped. */
	onStop: { hook?: () => void };
	statusOf(): ReturnType<typeof readLaunchStatus>;
}

function rig(options: { version?: string; uiStays?: boolean; serverSaid?: string } = {}): Rig {
	const server = createFakeOpencodeServer();
	const files = new Map<string, string>();
	const serverEnv: Rig["serverEnv"] = [];
	const uiRuns: string[][] = [];
	const onSleep: Rig["onSleep"] = {};
	const onStop: Rig["onStop"] = {};
	let stopped = 0;
	let clock = 0;
	let exitUi: (code: number | Error) => void = () => undefined;
	let exitServer: () => void = () => undefined;
	const ports: LauncherPorts = {
		pid: PID,
		env: { PATH: "/usr/bin" },
		home: "/home/me",
		cwd: "/p",
		runtime: "/bun",
		root: "/sb",
		greeting: "hello there",
		isExecutable: (file) => file === BINARY,
		readVersion: async () => `opencode v${options.version ?? OPENCODE_PIN}`,
		startServer: (_binary, env) => {
			serverEnv.push(env);
			const exited = new Promise<void>((resolve) => {
				exitServer = resolve;
			});
			return {
				url: Promise.resolve(options.serverSaid === undefined ? server.url : undefined),
				stop: () => {
					stopped += 1;
					onStop.hook?.();
					exitServer();
				},
				exited,
				errorTail: () => options.serverSaid ?? "",
			};
		},
		runUi: (_binary, args) => {
			uiRuns.push(args);
			if (!options.uiStays) return Promise.resolve(0);
			return new Promise((resolve, reject) => {
				exitUi = (code) => (code instanceof Error ? reject(code) : resolve(code));
			});
		},
		fetch: server.fetch,
		randomPassword: () => server.password,
		makePrivateDir: () => "/run/sb-private",
		writePrivateFile: (file, text) => {
			files.set(file, text);
		},
		readFile: (file) => files.get(file),
		remove: (target) => {
			for (const file of [...files.keys()])
				if (file === target || file.startsWith(`${target}/`)) files.delete(file);
		},
		sleep: async (ms) => {
			clock += ms;
			onSleep.hook?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
		now: () => clock,
		log: () => undefined,
	};
	return {
		server,
		ports,
		files,
		serverEnv,
		uiRuns,
		stops: () => stopped,
		exitUi: (code) => exitUi(code),
		crashServer: () => exitServer(),
		onSleep,
		onStop,
		statusOf: () => readLaunchStatus(files.get(STATUS)),
	};
}

const launch = (r: Rig, greet = false) => runLauncher({ sessionId: SESSION, statusFile: STATUS, greet }, r.ports);

const created = (r: Rig) => r.server.requests.filter((req) => req.method === "POST" && req.route === "/api/session");

describe("the OpenCode launcher's arguments and finds", () => {
	it("takes a minted session id and an absolute status file, and refuses anything else", () => {
		expect(parseLaunchArgs(["--session", SESSION, "--status", STATUS, "--greet"])).toEqual({
			sessionId: SESSION,
			statusFile: STATUS,
			greet: true,
		});
		for (const argv of [
			["--session", "ses_other", "--status", STATUS],
			["--session", SESSION, "--status", "relative.json"],
			["--session", SESSION, "--status", STATUS, "--port", "1"],
		]) {
			expect(parseLaunchArgs(argv), argv.join(" ")).toBeUndefined();
		}
	});

	it("looks on PATH before the installer's own directory", () => {
		const both = (file: string) => file === "/usr/bin/opencode" || file === BINARY;

		expect(findBinary({ env: { PATH: "/usr/bin" }, home: "/home/me", isExecutable: both })).toBe(
			"/usr/bin/opencode",
		);
		expect(findBinary({ env: {}, home: "/home/me", isExecutable: (file) => file === BINARY })).toBe(BINARY);
		expect(findBinary({ env: {}, home: "/home/me", isExecutable: () => false })).toBeUndefined();
	});

	it("reads the UI's last pick with its variant, and nothing from an unreadable file", () => {
		const state = {
			recent: [{ providerID: "anthropic", modelID: "opus" }],
			variant: { "anthropic/opus": "high" },
		};

		expect(lastPickedModel(JSON.stringify(state))).toEqual({
			id: "opus",
			providerID: "anthropic",
			variant: "high",
		});
		expect([lastPickedModel("{"), lastPickedModel(JSON.stringify({ recent: [] }))]).toEqual([undefined, undefined]);
	});
});

describe("an OpenCode launch", () => {
	it("refuses a version outside the pin by its number, and starts no server", async () => {
		const r = rig({ version: "9.9.9" });

		expect(await launch(r)).toBe(1);
		expect(r.statusOf()).toMatchObject({ state: "failed", error: expect.stringContaining("9.9.9") });
		expect(r.serverEnv).toEqual([]);
	});

	it("creates an absent session with the UI's last model and no permissions, then leaves a held one alone", async () => {
		const r = rig();
		r.files.set(MODEL_FILE, JSON.stringify({ recent: [{ providerID: "anthropic", modelID: "opus" }] }));

		expect(await launch(r)).toBe(0);
		const fresh = created(r);
		expect(await launch(r)).toBe(0);

		expect(fresh.map((req) => req.body)).toEqual([
			{ id: SESSION, location: { directory: "/p" }, model: { id: "opus", providerID: "anthropic" } },
		]);
		expect(created(r)).toHaveLength(1);
		expect(r.uiRuns).toEqual([
			["--server", r.server.url, "--session", SESSION],
			["--server", r.server.url, "--session", SESSION],
		]);
	});

	it("leaves the plugin a server file only the MCP server's environment names", async () => {
		const r = rig({ uiStays: true });
		const running = launch(r);
		await waitUntil(() => r.uiRuns.length === 1);

		const config = JSON.parse(r.serverEnv[0]?.OPENCODE_CONFIG_CONTENT ?? "{}");
		const named = config.mcp.servers.switchboard.environment[OPENCODE_SERVER_ENV];
		const file = OpencodeServerFileSchema.parse(JSON.parse(r.files.get(named) ?? "{}"));
		r.exitUi(0);
		await running;

		expect(file).toEqual({ url: r.server.url, password: r.server.password, sessionId: SESSION, directory: "/p" });
		expect(r.uiRuns[0]?.join(" ")).not.toContain(r.server.password);
		expect(r.files.has(named)).toBe(false);
	});

	it("waits for the MCP server to connect before it says ready", async () => {
		const r = rig();
		r.server.setMcp("booting");
		const whileBooting: unknown[] = [];
		r.onSleep.hook = () => {
			if (whileBooting.length === 4) return;
			whileBooting.push(r.statusOf());
			if (whileBooting.length === 4) r.server.setMcp("connected");
		};
		let atUi: unknown;
		r.ports.runUi = async () => {
			atUi = r.statusOf();
			return 0;
		};

		expect(await launch(r)).toBe(0);
		expect(whileBooting).toEqual(Array(4).fill({ state: "starting", pid: PID }));
		expect(atUi).toEqual({ state: "ready", pid: PID, version: OPENCODE_PIN });
	});

	it("says why the server did not start, in its own words", async () => {
		const r = rig({ serverSaid: "listen EADDRINUSE 127.0.0.1" });

		expect(await launch(r)).toBe(1);
		expect(r.statusOf()).toMatchObject({ state: "failed", error: expect.stringContaining("EADDRINUSE") });
		expect(r.uiRuns).toEqual([]);
	});

	it.each([
		["failed", () => undefined],
		["never connected", (server: FakeOpencodeServer) => server.setMcp("booting")],
	] as const)("fails when the MCP server %s, and runs no UI", async (_label, script) => {
		const r = rig();
		r.server.setMcp("failed", "spawn ENOENT");
		script(r.server);

		expect(await launch(r)).toBe(1);
		expect(r.statusOf()?.state).toBe("failed");
		expect(r.uiRuns).toEqual([]);
		expect(r.stops()).toBe(1);
	});

	it("greets only when asked, under the one greeting id", async () => {
		const quiet = rig();
		const greeted = rig();

		await launch(quiet);
		await launch(greeted, true);

		expect(quiet.server.messages(SESSION)).toEqual([]);
		expect(greeted.server.messages(SESSION)).toEqual([
			{ id: OPENCODE_GREETING_ID, type: "user", text: "hello there" },
		]);
	});

	it("launches anyway when the greeting never answers", async () => {
		const r = rig();
		const real = r.ports.fetch;
		r.ports.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
			String(input).endsWith("/prompt")
				? Promise.reject(new DOMException("timed out", "TimeoutError"))
				: real(input, init)) as typeof fetch;
		let atUi: unknown;
		r.ports.runUi = async () => {
			atUi = r.statusOf();
			return 0;
		};

		expect(await launch(r, true)).toBe(0);
		expect(atUi).toMatchObject({ state: "ready" });
	});

	it("says ready, then cleans up and leaves the UI's exit code on disk once the UI exits", async () => {
		const r = rig({ uiStays: true });
		const running = launch(r);
		await waitUntil(() => r.uiRuns.length === 1);
		const whileUp = { status: r.statusOf(), stops: r.stops() };

		r.exitUi(3);

		expect(await running).toBe(3);
		expect(whileUp).toEqual({ status: { state: "ready", pid: PID, version: OPENCODE_PIN }, stops: 0 });
		expect(r.stops()).toBe(1);
		expect([...r.files.keys()]).toEqual([STATUS]);
		expect(r.statusOf()).toEqual({ state: "exited", pid: PID, code: 3 });
	});

	it("says failed once its server exits under a running UI", async () => {
		const r = rig({ uiStays: true });
		const running = launch(r);
		await waitUntil(() => r.uiRuns.length === 1);

		r.crashServer();
		await waitUntil(() => r.statusOf()?.state === "failed");
		const whileUiRuns = r.statusOf();
		r.exitUi(0);
		await running;

		expect(whileUiRuns).toMatchObject({ state: "failed", pid: PID });
	});

	it.each([
		["exits", 0],
		["throws", new Error("the terminal died")],
	] as const)("says exited for its whole wind-down once the UI %s", async (_label, ending) => {
		const r = rig({ uiStays: true });
		let atStop: unknown;
		r.onStop.hook = () => {
			atStop = r.statusOf();
		};
		const running = launch(r);
		await waitUntil(() => r.uiRuns.length === 1);

		r.exitUi(ending);
		const ended = await running.then(
			(code) => code,
			(error: unknown) => error,
		);

		const left = { state: "exited", pid: PID, code: ending === 0 ? 0 : 1 };
		expect(ended).toBe(ending);
		expect([atStop, r.statusOf()]).toEqual([left, left]);
	});

	it("leaves a status a newer launcher wrote during its wind-down", async () => {
		const r = rig({ uiStays: true });
		const newer = JSON.stringify({ state: "starting", pid: PID + 1 });
		r.onStop.hook = () => r.files.set(STATUS, newer);
		const running = launch(r);
		await waitUntil(() => r.uiRuns.length === 1);

		r.exitUi(0);
		await running;

		expect(r.files.get(STATUS)).toBe(newer);
	});

	it("reconnects a dead MCP server while the UI runs, and stops watching once it exits", async () => {
		const r = rig({ uiStays: true });
		const running = launch(r);
		await waitUntil(() => r.uiRuns.length === 1);
		const reconnects = () => r.server.requests.filter((req) => req.route.includes("/mcp/switchboard/connect"));

		r.server.setMcp("failed", "child exited");
		await waitUntil(() => reconnects().length === 1);
		r.exitUi(0);
		await running;
		const polled = r.server.requests.length;
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(reconnects()).toHaveLength(1);
		expect(r.server.requests.length).toBe(polled);
	});
});

async function waitUntil(probe: () => boolean): Promise<void> {
	for (let tries = 0; tries < 500 && !probe(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 2));
	if (!probe()) throw new Error("never happened");
}
