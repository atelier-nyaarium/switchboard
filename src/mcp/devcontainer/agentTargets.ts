// One child per target.

import type { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { AgentResolvedTarget } from "../../shared/agent-execution-target.js";

////////////////////////////////
//  Interfaces & Types

/** Protocol-agnostic child. */
export interface AgentChild {
	readonly stdin: Writable;
	readonly stdout: Readable;
	kill(): void;
	/** Reason is a stderr class, never raw text. */
	onExit(listener: (info: { code: number | null; signal: string | null; reason?: string }) => void): void;
}

export interface ExecutionTargetLauncher {
	launch(target: AgentResolvedTarget, env: Record<string, string>): AgentChild;
}

/** Child lease generation fence. */
export interface TargetLease {
	generation: number;
	child: AgentChild;
}

/** Limited target supervisor interface. */
export interface TargetSupervisor {
	acquire(target: AgentResolvedTarget): TargetAvailability;
	/** A late release cannot affect another generation. */
	release(targetId: string, generation: number): void;
	onRetire?(listener: (targetId: string, generation: number) => void): () => void;
}

export type TargetAvailability =
	| { state: "running"; lease: TargetLease }
	| { state: "recovering"; retryInMs: number; errorClass: string }
	| { state: "unavailable"; errorClass: string };

export interface TargetLogEvent {
	targetId: string;
	generation: number;
	state: "launching" | "running" | "recovering" | "unavailable" | "reaped";
	errorClass?: string;
}

export interface ExecutionTargetManagerOptions {
	launcher: ExecutionTargetLauncher;
	log: (event: TargetLogEvent) => void;
	/** Child credential exemption prefix. */
	envPrefix: string;
	now?: () => number;
	baseEnv?: Record<string, string | undefined>;
}

////////////////////////////////
//  Constants

const BACKOFF_START_MS = 1_000;
const BACKOFF_CEILING_MS = 60_000;
// Healthy runtime threshold.
const HEALTHY_MS = 30_000;
const MAX_FAST_FAILS = 5;
// Retry cooldown after give-up.
const GIVE_UP_COOLDOWN_MS = 5 * 60_000;

// Scrub Switchboard secrets; backends use config files.
const SCRUBBED_EXACT = new Set([
	"HOST_WS_TOKEN",
	"BRIDGE_ROUTER_URL",
	"CONSOLE_BRIDGE_TOKEN",
	"FEDERATION_DOMAIN_ID",
	"GATEWAY_ID",
	"MCP_CONNECTOR_PORT",
	"PROJECT_NAME",
	"PROJECT_HOST_PATH",
	"AGENT_TYPE",
]);
const SCRUBBED_PATTERN = /token|secret|password|credential|api[_-]?key/i;

// Never log raw stderr; it may name paths.
const STDERR_KEEP_BYTES = 2_000;

const STDERR_CLASSES: Array<[RegExp, string]> = [
	[/no such container/i, "noSuchContainer"],
	[/is not running/i, "containerStopped"],
	[/permission denied|cannot connect to the docker daemon/i, "dockerDenied"],
	[/not found|no such file/i, "binaryMissing"],
	[/unauthor|not logged in|auth/i, "authFailed"],
];

////////////////////////////////
//  Functions & Helpers

/** Only own prefix passes. */
export function scrubChildEnv(
	source: Record<string, string | undefined>,
	exemptPrefix?: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (SCRUBBED_EXACT.has(key)) continue;
		if (SCRUBBED_PATTERN.test(key) && !(exemptPrefix && key.startsWith(exemptPrefix))) continue;
		out[key] = value;
	}
	return out;
}

/** Scrubbed container environment pairs. */
export function containerEnvArgs(source: Record<string, string | undefined>, envPrefix: string): string[] {
	if (envPrefix.length === 0) return [];
	return Object.entries(scrubChildEnv(source, envPrefix))
		.filter(([key]) => key.startsWith(envPrefix))
		.flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

export function classifyAgentStderr(stderrTail: string): string | undefined {
	return STDERR_CLASSES.find(([pattern]) => pattern.test(stderrTail))?.[1];
}

/** Process-backed agent child. */
export function adoptProcess(
	proc: ReturnType<typeof spawn>,
	reasonOf: (stderrTail: string) => string | undefined = classifyAgentStderr,
): AgentChild {
	let stderrTail = "";
	proc.stderr?.on("data", (chunk: Buffer) => {
		stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_KEEP_BYTES);
	});

	// Ignore stream errors; process failures use onExit.
	proc.stdin?.on("error", () => {});
	proc.stderr?.on("error", () => {});
	proc.stdout?.on("error", () => {});

	return {
		stdin: proc.stdin as Writable,
		stdout: proc.stdout as Readable,
		kill: () => {
			proc.kill();
		},
		onExit: (listener) => {
			const fire = (info: { code: number | null; signal: string | null }) => {
				listener({ ...info, reason: reasonOf(stderrTail) });
			};
			proc.once("exit", (code, signal) => fire({ code, signal }));
			proc.once("error", () => fire({ code: null, signal: null }));
		},
	};
}

/** Classify without logging messages. */
function classify(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "launchFailed";
}

function describeExit(info: { code: number | null; signal: string | null; reason?: string }): string {
	if (info.reason) return info.reason;
	if (info.signal) return `signal:${info.signal}`;
	return info.code === null ? "spawnError" : `exit:${info.code}`;
}

export function targetLogger(tag: string): (event: TargetLogEvent) => void {
	return (event) => {
		const suffix = event.errorClass ? ` error=${event.errorClass}` : "";
		console.error(`[${tag}] ${event.targetId} gen=${event.generation} ${event.state}${suffix}`);
	};
}

////////////////////////////////
//  Class

/** Lazy child per target. */
export class ExecutionTargetManager implements TargetSupervisor {
	private readonly retireListeners = new Set<(targetId: string, generation: number) => void>();
	private readonly targets = new Map<
		string,
		{
			lease?: TargetLease;
			launchedFor?: AgentResolvedTarget;
			generation: number;
			fastFails: number;
			backoffMs: number;
			retryAt: number;
			startedAt: number;
			errorClass?: string;
			gaveUpAt?: number;
		}
	>();

	private readonly launcher: ExecutionTargetLauncher;
	private readonly now: () => number;
	private readonly log: (event: TargetLogEvent) => void;
	private readonly baseEnv: Record<string, string | undefined>;
	private readonly envPrefix: string;

	constructor(options: ExecutionTargetManagerOptions) {
		this.launcher = options.launcher;
		this.log = options.log;
		this.envPrefix = options.envPrefix;
		this.now = options.now ?? (() => Date.now());
		this.baseEnv = options.baseEnv ?? process.env;
	}

	/** Reports failure classes without throwing. */
	acquire(target: AgentResolvedTarget): TargetAvailability {
		const entry = this.targets.get(target.targetId) ?? {
			generation: 0,
			fastFails: 0,
			backoffMs: BACKOFF_START_MS,
			retryAt: 0,
			startedAt: 0,
		};
		this.targets.set(target.targetId, entry);

		// Target identity ignores cwd.
		if (entry.launchedFor && entry.launchedFor.kind !== target.kind) {
			return { state: "unavailable", errorClass: "targetIdCollision" };
		}
		if (entry.lease) return { state: "running", lease: entry.lease };

		if (entry.gaveUpAt !== undefined) {
			if (this.now() - entry.gaveUpAt < GIVE_UP_COOLDOWN_MS) {
				return { state: "unavailable", errorClass: entry.errorClass ?? "launchFailed" };
			}
			entry.gaveUpAt = undefined;
			entry.fastFails = 0;
			entry.backoffMs = BACKOFF_START_MS;
		}

		if (this.now() < entry.retryAt) {
			return {
				state: "recovering",
				retryInMs: entry.retryAt - this.now(),
				errorClass: entry.errorClass ?? "exited",
			};
		}

		entry.generation += 1;
		entry.startedAt = this.now();
		this.log({ targetId: target.targetId, generation: entry.generation, state: "launching" });

		let child: AgentChild;
		try {
			child = this.launcher.launch(target, scrubChildEnv(this.baseEnv, this.envPrefix));
		} catch (err) {
			return this.recordFailure(target.targetId, classify(err));
		}

		const lease: TargetLease = { generation: entry.generation, child };
		entry.lease = lease;
		entry.launchedFor = target;
		child.onExit((info) => {
			// Late exits cannot tear down successors.
			const live = this.targets.get(target.targetId);
			if (live?.lease?.generation !== lease.generation) return;
			live.lease = undefined;
			this.notifyRetired(target.targetId, lease.generation);
			this.recordFailure(target.targetId, describeExit(info));
		});

		this.log({ targetId: target.targetId, generation: entry.generation, state: "running" });
		return { state: "running", lease };
	}

	/** Deliberate stops skip backoff. */
	release(targetId: string, generation: number): void {
		const entry = this.targets.get(targetId);
		if (entry?.lease?.generation !== generation) return;
		this.log({ targetId, generation, state: "reaped" });
		const child = entry.lease.child;
		entry.lease = undefined;
		this.notifyRetired(targetId, generation);
		child.kill();
	}

	onRetire(listener: (targetId: string, generation: number) => void): () => void {
		this.retireListeners.add(listener);
		return () => this.retireListeners.delete(listener);
	}

	/** Generation numbers never repeat. */
	shutdown(): void {
		for (const [targetId, entry] of [...this.targets]) {
			if (entry.lease) this.release(targetId, entry.lease.generation);
		}
	}

	private notifyRetired(targetId: string, generation: number): void {
		for (const listener of this.retireListeners) listener(targetId, generation);
	}

	private recordFailure(targetId: string, errorClass: string): TargetAvailability {
		const entry = this.targets.get(targetId);
		if (!entry) return { state: "unavailable", errorClass };

		if (this.now() - entry.startedAt >= HEALTHY_MS) {
			entry.fastFails = 0;
			entry.backoffMs = BACKOFF_START_MS;
		} else {
			entry.fastFails += 1;
		}
		entry.errorClass = errorClass;

		if (entry.fastFails >= MAX_FAST_FAILS) {
			entry.gaveUpAt = this.now();
			this.log({ targetId, generation: entry.generation, state: "unavailable", errorClass });
			return { state: "unavailable", errorClass };
		}

		entry.retryAt = this.now() + entry.backoffMs;
		const retryInMs = entry.backoffMs;
		entry.backoffMs = Math.min(entry.backoffMs * 2, BACKOFF_CEILING_MS);
		this.log({ targetId, generation: entry.generation, state: "recovering", errorClass });
		return { state: "recovering", retryInMs, errorClass };
	}
}
