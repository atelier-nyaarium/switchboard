import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBinaryOnPath } from "../../shared/agent-binary.js";
import type { AgentExecutionTarget } from "../../shared/agent-execution-target.js";
import { AgentExecutionTargetSchema } from "../../shared/agent-execution-target.js";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import {
	ClaudeTurnAckFrameSchema,
	type ClaudeTurnResultFrame,
	ClaudeTurnResultFrameSchema,
	type HostClaudeCancelOp,
	HostClaudeCancelOpSchema,
	type HostClaudeRunOp,
	HostClaudeRunOpSchema,
	type HostClaudeRunReply,
	HostClaudeRunReplySchema,
} from "../../shared/host-op.js";
import { classifyAgentStderr, containerEnvArgs, scrubChildEnv } from "./codexTargets.js";
import { containerFor } from "./containers.js";
import { resolveHostWorkdir } from "./hostResolve.js";

const MAX_RUNNING = 8;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2_000;
const CANCEL_KILL_MS = 5_000;
/** Pidfile retry window. */
const STARTUP_RETRIES = 6;
const MAX_KILL_FAILURES = 60;
const KILL_EXEC_MS = 10_000;
const ENDED_KEEP = 1024;
const NOT_FOUND_EXIT = 127;

const TURN_ENV = "SWITCHBOARD_CLAUDE_TURN";

/** Pidfile failure exit. */
const UNRECORDED_EXIT = 97;

const UNRECORDED_REASON = "claude run could not be recorded for cancel, so it was stopped";

const CONTAINER_WRAPPER = `
pidfile=$1
export ${TURN_ENV}="$2"
shift 2
exec 3<&0
if command -v setsid >/dev/null 2>&1; then setsid "$@" <&3 & else "$@" <&3 & fi
child=$!
if ! { printf %s "$child" >"$pidfile.tmp" && mv -f "$pidfile.tmp" "$pidfile"; }; then
	kill -s KILL -- "-$child" 2>/dev/null || kill -KILL "-$child" 2>/dev/null || kill -s KILL "$child" 2>/dev/null
	rm -f "$pidfile.tmp"
	wait "$child" 2>/dev/null
	exit ${UNRECORDED_EXIT}
fi
wait "$child"
status=$?
rm -f "$pidfile"
exit "$status"
`;

// Guard against reused pids.
const CONTAINER_KILL = `
pid=$(cat "$1" 2>/dev/null) || exit 4
case "$pid" in ''|*[!0-9]*) exit 4;; esac
tr '\\000' '\\n' <"/proc/$pid/environ" 2>/dev/null | grep -qxF -- "${TURN_ENV}=$2" || exit 3
kill -s "$3" -- "-$pid" 2>/dev/null || kill -"$3" "-$pid" 2>/dev/null || kill -s "$3" "$pid" 2>/dev/null || exit 5
`;

const containerPidfile = (turnId: string) => `/tmp/switchboard-claude-${turnId}.pid`;

interface ClaudeCommand {
	command: string;
	args: string[];
}

function claudeArgs(input: HostClaudeRunOp): string[] {
	const args = [
		"-p",
		"--permission-mode",
		"bypassPermissions",
		"--safe-mode",
		"--disable-slash-commands",
		"--output-format",
		"json",
	];
	if (input.model !== undefined) args.push("--model", input.model);
	if (input.effort !== undefined) args.push("--effort", input.effort);
	if (input.jsonSchema !== undefined) args.push("--json-schema", JSON.stringify(input.jsonSchema));
	if (input.appendSystemPrompt !== null) args.push("--append-system-prompt", input.appendSystemPrompt);
	args.push(input.resume ? "--resume" : "--session-id", input.sessionId);
	return args;
}

export function argvFor(input: HostClaudeRunOp, env: Record<string, string | undefined> = process.env): ClaudeCommand {
	const checked = HostClaudeRunOpSchema.parse(input);
	const args = claudeArgs(checked);
	const target = AgentExecutionTargetSchema.parse(checked.target);
	if (target.kind === "host") return { command: "claude", args };
	return {
		command: "docker",
		args: [
			"exec",
			"-i",
			"-u",
			"vscode",
			"-w",
			`/workspace/${target.project}`,
			...containerEnvArgs(env, ""),
			containerFor(target.project),
			"sh",
			"-c",
			CONTAINER_WRAPPER,
			"sh",
			containerPidfile(checked.turnId),
			checked.turnId,
			"timeout",
			"--signal=TERM",
			"3600",
			"claude",
			...args,
		],
	};
}

function containerKillArgv(
	target: Extract<AgentExecutionTarget, { kind: "devcontainer" }>,
	turnId: string,
	signal: "TERM" | "KILL",
): string[] {
	return [
		"exec",
		containerFor(target.project),
		"sh",
		"-c",
		CONTAINER_KILL,
		"sh",
		containerPidfile(turnId),
		turnId,
		signal,
	];
}

/** Missing or invalid pidfile. */
type KillAnswer = "signaled" | "absent" | "unrecorded" | "failed";

interface KillDebt {
	target: AgentExecutionTarget;
	turnId: string;
	phase: "TERM" | "KILL";
	failures: number;
	waits: number;
	timer?: ReturnType<typeof setTimeout>;
}

interface RunningTurn {
	input: HostClaudeRunOp;
	child: ChildProcess;
	stdout: Buffer[];
	stdoutBytes: number;
	stdoutOverflow: boolean;
	stderrTail: string;
	cancelled: boolean;
	/** Runner-stopped failure. */
	stoppedBecause?: string;
	settled: boolean;
}

export interface ClaudeRunner {
	start(input: HostClaudeRunOp): HostClaudeRunReply;
	/** Active and orphan cancellation. */
	cancel(input: HostClaudeCancelOp): Promise<{ cancelled: boolean }>;
	replay(): void;
	acknowledge(input: { runId: string; turnId: string }): void;
	stop(): void;
	activeCount(): number;
}

export interface ClaudeRunnerDeps {
	send: (frame: ClaudeTurnResultFrame) => void;
	env?: Record<string, string | undefined>;
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	hasBinary?: (name: string, env: Record<string, string | undefined>) => boolean;
	resolveHostCwd?: (hint: string) => string;
	signalGroup?: (child: ChildProcess, signal: NodeJS.Signals) => void;
	setTimer?: typeof setTimeout;
	clearTimer?: typeof clearTimeout;
	/** Restart-safe host pidfiles. */
	pidDir?: string;
	/** Process environment entries. */
	environOf?: (pid: number) => string[] | null;
	killGroup?: (pid: number, signal: NodeJS.Signals) => boolean;
}

function turnKey(runId: string, turnId: string): string {
	return JSON.stringify([runId, turnId]);
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function jsonObjects(text: string): Record<string, unknown>[] {
	const objects: Record<string, unknown>[] = [];
	let start = -1;
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"') {
			quoted = true;
			continue;
		}
		if (char === "{") {
			if (depth === 0) start = index;
			depth += 1;
		} else if (char === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				try {
					const value: unknown = JSON.parse(text.slice(start, index + 1));
					if (value && typeof value === "object" && !Array.isArray(value)) {
						objects.push(value as Record<string, unknown>);
					}
				} catch {}
				start = -1;
			}
		}
	}
	return objects;
}

function textOutput(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function resultFrame(
	input: HostClaudeRunOp,
	code: number | null,
	signal: NodeJS.Signals | null,
	stdout: string,
	stderr: string,
	stdoutOverflow: boolean,
	cancelled: boolean,
	stoppedBecause?: string,
): ClaudeTurnResultFrame {
	const frame = (
		outcome: ClaudeTurnResultFrame["outcome"],
		answer: ClaudeTurnResultFrame["answer"],
		reason: string | null,
	) =>
		ClaudeTurnResultFrameSchema.parse({
			type: "claude_turn_result",
			runId: input.runId,
			turnId: input.turnId,
			sessionId: input.sessionId,
			outcome,
			answer,
			reason,
		});
	if (stoppedBecause !== undefined) return frame("failed", null, stoppedBecause);
	if (input.target.kind === "devcontainer" && code === UNRECORDED_EXIT)
		return frame("failed", null, UNRECORDED_REASON);
	if (cancelled) return frame("cancelled", null, "cancelled");
	if (input.target.kind === "devcontainer" && code === NOT_FOUND_EXIT) return frame("failed", null, "binaryMissing");
	const parsed = jsonObjects(stdout).at(-1);
	const result = parsed?.type === "result" ? parsed : undefined;
	const outputText = textOutput(result?.result);
	if (/no conversation found/i.test(`${stderr}\n${outputText ?? ""}`)) {
		return frame("sessionMissing", null, "No conversation found");
	}
	const stderrClass = classifyAgentStderr(stderr);
	if (stdoutOverflow) return frame("failed", null, stderrClass ?? "claude output exceeded limit");
	if (!result) return frame("failed", null, stderrClass ?? "invalid claude output");
	if (result.is_error === true) return frame("failed", null, stderrClass ?? "claude reported an error");
	if (code !== 0) {
		const exit = code === null ? (signal ?? "unknown") : String(code);
		return frame("failed", null, stderrClass ?? `claude exited with ${exit}`);
	}
	if ("structured_output" in result)
		return frame("completed", result.structured_output as ClaudeTurnResultFrame["answer"], null);
	if (outputText !== null) return frame("completed", outputText, null);
	return frame("failed", null, stderrClass ?? "claude result has no answer");
}

function procEnviron(pid: number): string[] | null {
	try {
		return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
	} catch {
		return null;
	}
}

function hostKillGroup(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		try {
			process.kill(pid, signal);
			return true;
		} catch {
			return false;
		}
	}
}

function hostSignalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid !== undefined) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {}
	}
	child.kill(signal);
}

/** Owns Claude process runs. */
export function createClaudeRunner(deps: ClaudeRunnerDeps): ClaudeRunner {
	const env = deps.env ?? process.env;
	const spawnChild = deps.spawn ?? ((command, args, options) => spawn(command, args, options));
	const hasBinary = deps.hasBinary ?? ((name, source) => isBinaryOnPath(name, source));
	const resolveHostCwd = deps.resolveHostCwd ?? resolveHostWorkdir;
	const signalGroup = deps.signalGroup ?? hostSignalGroup;
	const startTimer = deps.setTimer ?? setTimeout;
	const stopTimer = deps.clearTimer ?? clearTimeout;
	const pidDir = deps.pidDir ?? path.join(os.tmpdir(), "switchboard-claude");
	const environOf = deps.environOf ?? procEnviron;
	const killGroup = deps.killGroup ?? hostKillGroup;
	const active = new Map<string, RunningTurn>();
	const outbox = new Map<string, ClaudeTurnResultFrame>();
	const debts = new Map<string, KillDebt>();
	const ended = new Set<string>();

	const hostPidfile = (turnId: string) => path.join(pidDir, `${turnId}.pid`);

	function writeHostPidfile(turnId: string, pid: number | undefined): boolean {
		if (pid === undefined) return false;
		try {
			fs.mkdirSync(pidDir, { recursive: true, mode: 0o700 });
			writeFileAtomic(hostPidfile(turnId), String(pid), { mode: 0o600 });
			return true;
		} catch {
			return false;
		}
	}

	function removeHostPidfile(turnId: string): void {
		try {
			fs.rmSync(hostPidfile(turnId), { force: true });
		} catch {}
	}

	function containerKill(
		target: Extract<AgentExecutionTarget, { kind: "devcontainer" }>,
		turnId: string,
		signal: "TERM" | "KILL",
	): Promise<KillAnswer> {
		return new Promise((resolve) => {
			let child: ChildProcess;
			try {
				child = spawnChild("docker", containerKillArgv(target, turnId, signal), {
					stdio: ["ignore", "ignore", "pipe"],
					detached: true,
				});
			} catch {
				resolve("failed");
				return;
			}
			child.unref?.();
			let stderr = "";
			child.stderr?.on("data", (chunk: Buffer | string) => {
				stderr = (stderr + Buffer.from(chunk).toString("utf8")).slice(-STDERR_TAIL_CHARS);
			});
			child.stderr?.on("error", () => {});
			const hung = startTimer(() => {
				child.kill("SIGKILL");
				resolve("failed");
			}, KILL_EXEC_MS);
			child.once("error", () => {
				stopTimer(hung);
				resolve("failed");
			});
			child.once("close", (code) => {
				stopTimer(hung);
				if (code === 0) resolve("signaled");
				else if (code === 4) resolve("unrecorded");
				else if (code === 3 || /no such container|is not running/i.test(stderr)) resolve("absent");
				else resolve("failed");
			});
		});
	}

	function hostOrphanKill(turnId: string, signal: NodeJS.Signals): KillAnswer {
		let pid: number;
		try {
			pid = Number(fs.readFileSync(hostPidfile(turnId), "utf8").trim());
		} catch {
			return "absent";
		}
		if (!Number.isInteger(pid) || pid <= 1) return "absent";
		if (!environOf(pid)?.includes(`${TURN_ENV}=${turnId}`)) return "absent";
		return killGroup(pid, signal) ? "signaled" : "failed";
	}

	function sendResult(turn: RunningTurn, code: number | null, signal: NodeJS.Signals | null): void {
		if (turn.settled) return;
		turn.settled = true;
		const key = turnKey(turn.input.runId, turn.input.turnId);
		active.delete(key);
		if (turn.input.target.kind === "host") removeHostPidfile(turn.input.turnId);
		const stdout = Buffer.concat(turn.stdout).toString("utf8");
		const frame = resultFrame(
			turn.input,
			code,
			signal,
			stdout,
			turn.stderrTail,
			turn.stdoutOverflow,
			turn.cancelled,
			turn.stoppedBecause,
		);
		outbox.set(key, frame);
		deps.send(frame);
	}

	async function killOnce(key: string, debt: KillDebt): Promise<KillAnswer> {
		const turn = active.get(key);
		const live = turn && !turn.settled ? turn : undefined;
		if (debt.target.kind === "host") {
			if (!live) return hostOrphanKill(debt.turnId, `SIG${debt.phase}`);
			signalGroup(live.child, `SIG${debt.phase}`);
			return "signaled";
		}
		if (debt.phase === "KILL") live?.child.kill("SIGKILL");
		return containerKill(debt.target, debt.turnId, debt.phase);
	}

	function finishDebt(key: string, debt: KillDebt, confirmed: boolean): void {
		if (debts.get(key) !== debt) return;
		debts.delete(key);
		if (!confirmed) return;
		const turn = active.get(key);
		if (turn && !turn.settled) turn.child.kill("SIGKILL");
		if (debt.target.kind === "host" && !turn) removeHostPidfile(debt.turnId);
		ended.add(key);
		if (ended.size > ENDED_KEEP) ended.delete(ended.values().next().value as string);
	}

	function scheduleDebt(key: string, debt: KillDebt): void {
		debt.timer = startTimer(() => {
			debt.timer = undefined;
			void stepDebt(key, debt);
		}, CANCEL_KILL_MS);
	}

	async function stepDebt(key: string, debt: KillDebt): Promise<void> {
		if (debts.get(key) !== debt) return;
		const answer = await killOnce(key, debt);
		if (debts.get(key) !== debt) return;
		if (answer === "failed") {
			debt.failures += 1;
			if (debt.failures >= MAX_KILL_FAILURES) {
				console.warn(`[claude] gave up cancelling turn ${debt.turnId}`);
				finishDebt(key, debt, false);
			} else scheduleDebt(key, debt);
			return;
		}
		if (answer === "unrecorded" && debt.phase === "TERM" && debt.waits < STARTUP_RETRIES) {
			debt.waits += 1;
			scheduleDebt(key, debt);
			return;
		}
		if (answer === "signaled" && debt.phase === "TERM") {
			debt.phase = "KILL";
			scheduleDebt(key, debt);
			return;
		}
		finishDebt(key, debt, true);
	}

	/** Starts cancellation. */
	async function cancel(raw: HostClaudeCancelOp): Promise<{ cancelled: boolean }> {
		const checked = HostClaudeCancelOpSchema.safeParse(raw);
		if (!checked.success) return { cancelled: false };
		const input = checked.data;
		const key = turnKey(input.runId, input.turnId);
		if (ended.has(key)) return { cancelled: true };
		const turn = active.get(key);
		if (turn) turn.cancelled = true;
		else if (outbox.has(key)) return { cancelled: true };
		if (debts.has(key)) return { cancelled: false };
		const debt: KillDebt = {
			target: turn?.input.target ?? input.target,
			turnId: input.turnId,
			phase: "TERM",
			failures: 0,
			waits: 0,
		};
		debts.set(key, debt);
		void stepDebt(key, debt);
		return { cancelled: false };
	}

	return {
		start(raw) {
			const checked = HostClaudeRunOpSchema.safeParse(raw);
			if (!checked.success) return { kind: "refused", code: "badTarget" };
			const input = checked.data;
			const key = turnKey(input.runId, input.turnId);
			if (active.has(key) || outbox.has(key)) return { kind: "accepted" };
			if (active.size >= MAX_RUNNING) return { kind: "refused", code: "busy" };
			if (input.target.kind === "host" && !hasBinary("claude", env)) {
				return { kind: "refused", code: "binaryMissing" };
			}
			const command = argvFor(input, env);
			const options: SpawnOptions =
				input.target.kind === "host"
					? {
							cwd: resolveHostCwd(input.target.workdirHint),
							env: { ...scrubChildEnv(env), [TURN_ENV]: input.turnId },
							detached: true,
						}
					: { stdio: ["pipe", "pipe", "pipe"] };
			let child: ChildProcess;
			try {
				child = spawnChild(command.command, command.args, options);
			} catch (error) {
				return {
					kind: "refused",
					code: errorCode(error) === "ENOENT" ? "binaryMissing" : "badTarget",
				};
			}
			const turn: RunningTurn = {
				input,
				child,
				stdout: [],
				stdoutBytes: 0,
				stdoutOverflow: false,
				stderrTail: "",
				cancelled: false,
				settled: false,
			};
			active.set(key, turn);
			// Restart cleanup needs pidfiles.
			if (input.target.kind === "host" && !writeHostPidfile(input.turnId, child.pid)) {
				turn.stoppedBecause = UNRECORDED_REASON;
				signalGroup(child, "SIGKILL");
			}
			child.stdin?.on("error", () => {});
			child.stdout?.on("error", () => {});
			child.stderr?.on("error", () => {});
			child.stdout?.on("data", (chunk: Buffer | string) => {
				if (turn.stdoutOverflow) return;
				const bytes = Buffer.from(chunk);
				if (turn.stdoutBytes + bytes.length > MAX_STDOUT_BYTES) {
					turn.stdoutOverflow = true;
					return;
				}
				turn.stdoutBytes += bytes.length;
				turn.stdout.push(bytes);
			});
			child.stderr?.on("data", (chunk: Buffer | string) => {
				turn.stderrTail = (turn.stderrTail + Buffer.from(chunk).toString("utf8")).slice(-STDERR_TAIL_CHARS);
			});
			child.once("error", (error) => {
				const reason =
					errorCode(error) === "ENOENT"
						? "binaryMissing"
						: (classifyAgentStderr(turn.stderrTail) ?? "claude failed to start");
				if (turn.cancelled) sendResult(turn, null, null);
				else {
					turn.settled = true;
					active.delete(key);
					if (input.target.kind === "host") removeHostPidfile(input.turnId);
					const frame = ClaudeTurnResultFrameSchema.parse({
						type: "claude_turn_result",
						runId: input.runId,
						turnId: input.turnId,
						sessionId: input.sessionId,
						outcome: "failed",
						answer: null,
						reason,
					});
					outbox.set(key, frame);
					deps.send(frame);
				}
			});
			child.once("close", (code, signal) => sendResult(turn, code, signal));
			child.stdin?.end(input.prompt);
			return HostClaudeRunReplySchema.parse({ kind: "accepted" });
		},
		cancel,
		replay() {
			for (const frame of outbox.values()) deps.send(frame);
		},
		acknowledge(raw) {
			const ack = ClaudeTurnAckFrameSchema.safeParse({ ...raw, type: "claude_turn_ack" });
			if (ack.success) outbox.delete(turnKey(ack.data.runId, ack.data.turnId));
		},
		stop() {
			for (const debt of debts.values()) if (debt.timer) stopTimer(debt.timer);
			debts.clear();
			for (const [key, turn] of active) {
				turn.cancelled = true;
				void killOnce(key, {
					target: turn.input.target,
					turnId: turn.input.turnId,
					phase: "KILL",
					failures: 0,
					waits: 0,
				});
			}
		},
		activeCount: () => active.size,
	};
}
