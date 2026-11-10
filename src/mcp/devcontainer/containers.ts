import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTmuxName } from "../../shared/host-op.js";
import { createFifo, createKeyedFifo } from "../../shared/keyed-fifo.js";
import type { ContainerState } from "../../shared/schemasPresence.js";
import type { SessionHarness } from "../../shared/session-harness.js";

////////////////////////////////
//  Interfaces & Types

export interface CatalogEntry {
	team: string;
	projectPath: string;
}

/** A project's dev container, as docker last reported it. */
export interface DevContainer {
	id: string;
	name: string;
	/** Absent outside compose. */
	compose?: string;
	running: boolean;
}

/** What a start hands the container CLI. */
export interface ContainerUpOptions {
	signal: AbortSignal;
	/** Per project: the CLI names temp files by the millisecond. */
	tmpdir: string;
	teardown: () => Promise<void>;
	/** Called once a build begins. */
	onStarting: () => void;
}

export interface DevContainersDeps {
	up: (projectPath: string, opts: ContainerUpOptions) => Promise<{ pluginsProvisioned: boolean }>;
	/** The CLIs installed inside. */
	look: (project: string) => Promise<SessionHarness[]>;
	catalog: () => CatalogEntry[];
	onChange: (containers: ContainerState[]) => void;
}

/** A launch whose container was stopped. */
export class ContainerStopped extends Error {
	constructor() {
		super("the container was stopped");
	}
}

/** A container that did not come up. */
export class ContainerStartFailed extends Error {}

////////////////////////////////
//  Constants

const FOLDER_LABEL = "devcontainer.local_folder";
const COMPOSE_LABEL = "com.docker.compose.project";
const EVENTS = ["create", "start", "die", "destroy", "rename"];
const EVENTS_RESTART_MS = 5_000;
const EVENTS_RESTART_MAX_MS = 300_000;
// A stream this old resets the backoff.
const EVENTS_STEADY_MS = 60_000;
const REFRESH_DEBOUNCE_MS = 250;
const DOCKER_TIMEOUT_MS = 30_000;
const DOWN_TIMEOUT_MS = 300_000;
const FAILURE_CHARS = 200;
const MAX_CONTAINERS = 128;

////////////////////////////////
//  Resolver

// Kept current by DevContainers.
const known = new Map<string, DevContainer>();

/** A project's container name; the legacy name when unknown. */
export function containerFor(project: string): string {
	return known.get(project)?.name ?? `${project}_devcontainer-dev-1`;
}

/** A project's compose project; the legacy name when unknown. */
export function composeProjectFor(project: string): string {
	return known.get(project)?.compose ?? `${project}_devcontainer`;
}

/** For a process with no tracker: asks docker by label. */
export function containerAt(project: string, projectPath: string): string {
	const held = known.get(project);
	if (held) return held.name;
	try {
		const [name] = execFileSync(
			"docker",
			["ps", "--filter", `label=${FOLDER_LABEL}=${projectPath}`, "--format", "{{.Names}}"],
			{ encoding: "utf-8", stdio: "pipe", timeout: 5_000 },
		)
			.split("\n")
			.filter(Boolean);
		if (name) return name;
	} catch {
		// Docker unreachable: the fallback.
	}
	return containerFor(project);
}

////////////////////////////////
//  Pure helpers

/** JSON with comments and trailing commas. */
export function parseJsonc(text: string): unknown {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			let end = i + 1;
			while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
			out += text.slice(i, end + 1);
			i = end + 1;
		} else if (ch === "/" && text[i + 1] === "/") {
			const newline = text.indexOf("\n", i);
			i = newline < 0 ? text.length : newline;
		} else if (ch === "/" && text[i + 1] === "*") {
			const close = text.indexOf("*/", i + 2);
			i = close < 0 ? text.length : close + 2;
		} else {
			if (ch === "}" || ch === "]") {
				const trimmed = out.trimEnd();
				if (trimmed.endsWith(",")) out = trimmed.slice(0, -1);
			}
			out += ch;
			i += 1;
		}
	}
	return JSON.parse(out);
}

/** `dockerComposeFile` entries in order, absolute. */
export function composeFilesOf(configDir: string, config: unknown): string[] {
	const entry = (config as { dockerComposeFile?: unknown } | null)?.dockerComposeFile;
	const files =
		typeof entry === "string"
			? [entry]
			: Array.isArray(entry)
				? entry.filter((file): file is string => typeof file === "string")
				: [];
	return files.map((file) => path.resolve(configDir, file));
}

interface InspectRow {
	Id?: unknown;
	Name?: unknown;
	Created?: unknown;
	State?: { Running?: unknown };
	Config?: { Labels?: Record<string, unknown> | null };
}

/** Per catalog project, its running container, else its newest. */
export function pickDevContainers(inspected: unknown, catalog: readonly CatalogEntry[]): Map<string, DevContainer> {
	const teams = new Map(catalog.map(({ team, projectPath }) => [path.resolve(projectPath), team]));
	const best = new Map<string, { container: DevContainer; created: number }>();
	for (const row of Array.isArray(inspected) ? (inspected as InspectRow[]) : []) {
		const labels = row?.Config?.Labels ?? {};
		const folder = labels[FOLDER_LABEL];
		if (typeof folder !== "string" || typeof row.Id !== "string" || typeof row.Name !== "string") continue;
		const team = teams.get(path.resolve(folder));
		if (!team) continue;
		const compose = labels[COMPOSE_LABEL];
		const container: DevContainer = {
			id: row.Id,
			name: row.Name.replace(/^\//, ""),
			...(typeof compose === "string" && compose ? { compose } : {}),
			running: row.State?.Running === true,
		};
		const created = Date.parse(String(row.Created ?? "")) || 0;
		const held = best.get(team);
		const wins =
			!held ||
			(container.running && !held.container.running) ||
			(container.running === held.container.running && created > held.created);
		if (wins) best.set(team, { container, created });
	}
	return new Map([...best].map(([team, { container }]) => [team, container]));
}

////////////////////////////////
//  Docker

function firstLine(text: string): string {
	return text.trim().split("\n")[0]?.slice(0, FAILURE_CHARS) ?? "";
}

function reasonOf(err: unknown): string {
	return firstLine(err instanceof Error ? err.message : String(err)) || "unknown failure";
}

function docker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"docker",
			args,
			{ encoding: "utf-8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) => {
				// Compose writes progress first.
				const said = stderr.trim().split("\n").at(-1)?.slice(0, FAILURE_CHARS);
				if (error) reject(Object.assign(new Error(said || error.message), { stdout }));
				else resolve(stdout);
			},
		);
	});
}

function composeFiles(projectPath: string): string[] {
	const dir = path.join(projectPath, ".devcontainer");
	try {
		return composeFilesOf(dir, parseJsonc(fs.readFileSync(path.join(dir, "devcontainer.json"), "utf8")));
	} catch (err) {
		console.error(`[containers] unreadable devcontainer.json in ${projectPath}: ${reasonOf(err)}`);
		return [];
	}
}

/** Compose down on the whole project, then its stale networks. Never volumes. */
async function teardownProject(project: string, projectPath: string): Promise<void> {
	const held = known.get(project);
	const files = composeFiles(projectPath);
	if (held && !held.compose && files.length === 0) {
		await docker(["rm", "-f", held.id], DOWN_TIMEOUT_MS);
		return;
	}
	const compose = composeProjectFor(project);
	try {
		await docker(
			["compose", "-p", compose, ...files.flatMap((file) => ["-f", file]), "down", "--remove-orphans"],
			DOWN_TIMEOUT_MS,
		);
	} finally {
		const networks = await docker(["network", "ls", "-q", "--filter", `label=${COMPOSE_LABEL}=${compose}`]).catch(
			() => "",
		);
		for (const id of networks.split("\n").filter(Boolean)) {
			// Still attached elsewhere.
			await docker(["network", "rm", id]).catch(() => {});
		}
	}
}

function projectTmpdir(project: string): string {
	const dir = path.join(os.tmpdir(), "switchboard-devcontainer", project);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

////////////////////////////////
//  Lifecycle and state

/** Each project's container: one lane for its start and stop, and its state as docker reports it. */
export class DevContainers {
	private readonly lanes = createKeyedFifo<string>();
	private readonly reads = createFifo();
	private queuedRead: Promise<void> | null = null;
	/** Bumped by each Stop; fences the work queued before it. */
	private readonly generations = new Map<string, number>();
	/** A start's lane work, which Stop aborts. */
	private readonly controllers = new Map<string, AbortController>();
	private readonly starting = new Set<string>();
	private readonly failures = new Map<string, string>();
	private readonly clis = new Map<string, SessionHarness[]>();
	/** The container id last looked inside. */
	private readonly looked = new Map<string, string>();
	private readonly lookSeq = new Map<string, number>();
	private events: ChildProcess | null = null;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private restartDelay = EVENTS_RESTART_MS;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private closed = true;
	private reported = "";

	constructor(private readonly deps: DevContainersDeps) {}

	/** Catalog projects only. */
	list(): ContainerState[] {
		return this.deps
			.catalog()
			.filter(({ team }) => isTmuxName(team))
			.slice(0, MAX_CONTAINERS)
			.map(({ team }): ContainerState => {
				const failure = this.failures.get(team);
				const clis = this.clis.get(team);
				return {
					project: team,
					state: this.starting.has(team) ? "starting" : known.get(team)?.running ? "running" : "stopped",
					...(failure ? { failure } : {}),
					...(clis ? { clis } : {}),
				};
			});
	}

	/** Follows docker's events until `close`. */
	watch(): void {
		if (!this.closed) return;
		this.closed = false;
		this.follow();
	}

	close(): void {
		this.closed = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.restartTimer = null;
		this.debounceTimer = null;
		this.events?.kill();
		this.events = null;
	}

	/** Reads docker, then reports. Joins a read not yet begun. */
	refresh(): Promise<void> {
		if (this.queuedRead) return this.queuedRead;
		const read = this.reads.run(async () => {
			this.queuedRead = null;
			await this.readOnce();
		});
		this.queuedRead = read;
		return read;
	}

	/** Queues a start; the outcome rides the state. */
	start(project: string, projectPath: string): void {
		const generation = this.generation(project);
		this.lanes
			.run(project, () => this.bring(project, projectPath, generation))
			.catch((err) => {
				if (!(err instanceof ContainerStopped))
					console.error(`[containers] ${project} start: ${reasonOf(err)}`);
			});
	}

	/** Kills a running start, fails the work queued behind it, then tears down. */
	stop(project: string, projectPath: string): void {
		this.generations.set(project, this.generation(project) + 1);
		this.controllers.get(project)?.abort();
		this.failures.delete(project);
		this.emit();
		this.lanes
			.run(project, async () => {
				try {
					await teardownProject(project, projectPath);
				} catch (err) {
					this.failures.set(project, reasonOf(err));
				}
				await this.refresh().catch((err) => console.error(`[containers] read failed: ${reasonOf(err)}`));
				this.emit();
			})
			.catch((err) => console.error(`[containers] ${project} stop: ${reasonOf(err)}`));
	}

	/** Starts if needed, looks inside, then runs `then`, all in the project's lane. */
	ensureUp<T>(
		project: string,
		projectPath: string,
		then: (installed: SessionHarness[]) => Promise<T>,
	): Promise<{ pluginsProvisioned: boolean; value: T }> {
		const generation = this.generation(project);
		return this.lanes.run(project, async () => {
			const { pluginsProvisioned, installed } = await this.bring(project, projectPath, generation);
			const value = await then(installed);
			if (this.generation(project) !== generation) throw new ContainerStopped();
			return { pluginsProvisioned, value };
		});
	}

	private generation(project: string): number {
		return this.generations.get(project) ?? 0;
	}

	private async bring(
		project: string,
		projectPath: string,
		generation: number,
	): Promise<{ pluginsProvisioned: boolean; installed: SessionHarness[] }> {
		const fenced = () => {
			if (this.generation(project) !== generation) throw new ContainerStopped();
		};
		fenced();
		this.failures.delete(project);
		const controller = new AbortController();
		this.controllers.set(project, controller);
		this.emit();
		try {
			let pluginsProvisioned: boolean;
			try {
				({ pluginsProvisioned } = await this.deps.up(projectPath, {
					signal: controller.signal,
					tmpdir: projectTmpdir(project),
					teardown: () =>
						teardownProject(project, projectPath).catch((err) =>
							console.error(`[containers] ${project} teardown: ${reasonOf(err)}`),
						),
					onStarting: () => {
						this.starting.add(project);
						this.emit();
					},
				}));
			} catch (err) {
				// A Stop's kill reads as stopped.
				fenced();
				const reason = reasonOf(err);
				this.failures.set(project, reason);
				throw new ContainerStartFailed(reason);
			} finally {
				this.starting.delete(project);
			}
			fenced();
			await this.refresh().catch((err) => console.error(`[containers] read failed: ${reasonOf(err)}`));
			fenced();
			const installed = await this.look(project);
			fenced();
			return { pluginsProvisioned, installed };
		} finally {
			this.controllers.delete(project);
			this.emit();
		}
	}

	/** Always probes; the newest answer is kept. */
	private async look(project: string): Promise<SessionHarness[]> {
		const seq = (this.lookSeq.get(project) ?? 0) + 1;
		this.lookSeq.set(project, seq);
		const id = known.get(project)?.id;
		const found = await this.deps.look(project);
		if (this.lookSeq.get(project) === seq) {
			this.clis.set(project, found);
			if (id) this.looked.set(project, id);
			this.emit();
		}
		return found;
	}

	private lookFor(project: string, id: string): void {
		this.looked.set(project, id);
		this.look(project).catch((err) => {
			if (this.looked.get(project) === id) this.looked.delete(project);
			console.error(`[containers] could not look inside ${project}: ${reasonOf(err)}`);
		});
	}

	private async readOnce(): Promise<void> {
		const catalog = this.deps.catalog();
		const ids = (await docker(["ps", "-aq", "--no-trunc", "--filter", `label=${FOLDER_LABEL}`]))
			.split("\n")
			.filter(Boolean);
		// One gone since `ps` fails the call; the rest still print.
		const raw = ids.length
			? await docker(["inspect", ...ids]).catch((err: { stdout?: string }) => err.stdout || "[]")
			: "[]";
		const view = pickDevContainers(JSON.parse(raw), catalog);
		const previous = new Map(known);
		known.clear();
		for (const [team, container] of view) {
			known.set(team, container);
			const fresh = !previous.get(team)?.running || this.looked.get(team) !== container.id;
			// Its own start looks once up.
			if (container.running && fresh && !this.controllers.has(team)) this.lookFor(team, container.id);
		}
		this.emit();
	}

	private emit(): void {
		const list = this.list();
		const text = JSON.stringify(list);
		if (text === this.reported) return;
		this.reported = text;
		this.deps.onChange(list);
	}

	private soon(): void {
		if (this.debounceTimer) return;
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.refresh().catch((err) => console.error(`[containers] read failed: ${reasonOf(err)}`));
		}, REFRESH_DEBOUNCE_MS);
		this.debounceTimer.unref?.();
	}

	private follow(): void {
		if (this.closed) return;
		const filters = ["type=container", `label=${FOLDER_LABEL}`, ...EVENTS.map((event) => `event=${event}`)];
		const child = spawn(
			"docker",
			["events", ...filters.flatMap((f) => ["--filter", f]), "--format", "{{.Action}}"],
			{
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		this.events = child;
		child.stdout?.on("data", () => this.soon());
		const began = Date.now();
		let ended = false;
		const restart = () => {
			if (ended) return;
			ended = true;
			if (this.events === child) this.events = null;
			if (this.closed) return;
			if (Date.now() - began >= EVENTS_STEADY_MS) this.restartDelay = EVENTS_RESTART_MS;
			const delay = this.restartDelay;
			this.restartDelay = Math.min(delay * 2, EVENTS_RESTART_MAX_MS);
			console.error(`[containers] docker events ended; restarting in ${delay / 1000}s`);
			this.restartTimer = setTimeout(() => {
				this.restartTimer = null;
				this.follow();
				// Covers the gap.
				this.soon();
			}, delay);
			this.restartTimer.unref?.();
		};
		child.on("error", restart);
		child.on("close", restart);
	}
}
