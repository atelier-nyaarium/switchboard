import { spawn } from "node:child_process";
import crypto from "node:crypto";
import {
	isAgentComposerEmpty,
	isAgentReady,
	isAgentWorking,
	isLoggedOut,
	type LimitNotice,
	limitNotice,
	stripAnsi,
} from "../../shared/agent-screen.js";
import {
	ALLOWED_KEYS,
	assertTmuxName,
	classifyPeekError,
	type HostPeekResult,
	isReservedHostSession,
	paneKey,
	type TmuxPeek,
	type TmuxTarget,
	type TypeIntoPaneResult,
} from "../../shared/host-op.js";
import { createKeyedFifo } from "../../shared/keyed-fifo.js";
import { trimPaneRowPadding } from "../../shared/pane-trim.js";
import { parseSessionName } from "../../shared/session-id.js";
import { buildTranscript } from "./buildTranscript.js";
import { containerFor } from "./containers.js";

// Re-exported so the daemon and tests keep this import path.
export { isAgentReady, isAgentWorking, isLoggedOut, limitNotice } from "../../shared/agent-screen.js";

////////////////////////////////
//  Constants

const EXEC_TIMEOUT_MS = 8_000;
const TYPE_INTO_PANE_WAIT_MS = 200_000;
const TYPE_INTO_PANE_POLL_MS = 1_000;
// Bounds one sealed reply.
const MAX_CAPTURE_BYTES = 256_000;
const CONTAINER_LOGS_TAIL = 200;
const CONTAINER_LOGS_TIMEOUT_MS = 5_000;

// Fits the phone's view.
const TMUX_COLS = 53;
const TMUX_ROWS = 38;

// A resumed history renders slowly.
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 1_000;
// A dead launch never captures.
const DEAD_LAUNCH_PROBES = 8;

// Answered with the first option.
const STARTUP_PROMPT_RE =
	/I am using this for local development|Is this a project you created|trust this folder|Try the new fullscreen renderer|Do you trust the files in this folder/;
// Copilot's boxed trust dialog.
const COPILOT_TRUST_RE = /Do you trust the files in this folder/u;
// A digit selects and confirms.
const NUMBERED_MENU_RE = /^[ \t\u00a0]*[❯>][ \t\u00a0]*\d+\./mu;
// Highlighted row of an unnumbered menu.
const MENU_CURSOR_ROW_RE = /^[ \t\u00a0]+[❯>][ \t\u00a0]+\S/u;
// Cursor may rest on "No, exit"; walk onto this row first.
const TRUST_YES_RE = /Yes, I trust this folder/u;

// Answered "2": keep full context.
const RESUME_PROMPT_RE = /Resuming the full session will consume/;

////////////////////////////////
//  Functions & Helpers

/** `kind` host means bare `tmux`, even inside a devcontainer. */
export function selfSessionTarget(): TmuxTarget {
	const { project, session } = parseSessionName(process.env.PROJECT_NAME ?? "");
	return { kind: "host", name: project, sessionName: session };
}

// Bare -t matches by prefix, so "story" lands on "story-2".
const exactSession = (name: string): string => `=${name}`;

/** The agent runs in pane 0. */
function paneTarget(target: TmuxTarget): string {
	assertTmuxName(target.sessionName);
	return `${exactSession(target.sessionName)}.0`;
}

/** The host's own tmux, or docker exec into the devcontainer. */
function tmuxArgv(target: TmuxTarget, sub: string[]): string[] {
	if (target.kind === "host") return ["tmux", ...sub];
	assertTmuxName(target.name);
	return ["docker", "exec", "-u", "vscode", containerFor(target.name), "tmux", ...sub];
}

/** Load one paste buffer. */
function tmuxStdinArgv(target: TmuxTarget, sub: string[]): string[] {
	if (target.kind === "host") return ["tmux", ...sub];
	assertTmuxName(target.name);
	return ["docker", "exec", "-i", "-u", "vscode", containerFor(target.name), "tmux", ...sub];
}

/** Any command, in the namespace the pane runs in. */
function execArgv(target: TmuxTarget, argv: string[]): string[] {
	if (target.kind === "host") return argv;
	assertTmuxName(target.name);
	return ["docker", "exec", "-u", "vscode", containerFor(target.name), ...argv];
}

/** A bash script where the target's panes run, with the launch's own setup. */
export function runInPlace(
	target: Pick<TmuxTarget, "kind" | "name">,
	script: string,
	timeoutMs = EXEC_TIMEOUT_MS,
): Promise<string> {
	return execInPlace(target, ["bash", "-c", `source ~/.bashrc >/dev/null 2>&1; ${script}`], timeoutMs);
}

/** One command where the panes run. */
export function execInPlace(
	target: Pick<TmuxTarget, "kind" | "name">,
	argv: string[],
	timeoutMs = EXEC_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<string> {
	if (target.kind === "host") return run(argv, timeoutMs, { signal });
	assertTmuxName(target.name);
	return run(["docker", "exec", "-u", "vscode", containerFor(target.name), ...argv], timeoutMs, { signal });
}

/** Spawn argv (no shell) and resolve stdout. */
function run(
	argv: string[],
	timeoutMs = EXEC_TIMEOUT_MS,
	opts: { input?: string; mergeStderr?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		if (opts.signal?.aborted) {
			reject(new Error("command aborted"));
			return;
		}
		const child = spawn(argv[0], argv.slice(1), {
			stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		if (opts.input !== undefined) child.stdin?.end(opts.input);
		// Decode once: a chunk boundary splits multi-byte chars.
		const chunks: Buffer[] = [];
		let bytes = 0;
		const errChunks: Buffer[] = [];
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`tmux command timed out`));
		}, timeoutMs);
		const abort = () => {
			child.kill("SIGKILL");
			reject(new Error("command aborted"));
		};
		opts.signal?.addEventListener("abort", abort, { once: true });
		child.on("close", () => opts.signal?.removeEventListener("abort", abort));
		child.stdout?.on("data", (d: Buffer) => {
			// Still drain past the cap.
			if (bytes < MAX_CAPTURE_BYTES) {
				chunks.push(d);
				bytes += d.length;
			}
		});
		let errBytes = 0;
		child.stderr?.on("data", (d: Buffer) => {
			// Own buffer: the streams schedule independently.
			if (errBytes < MAX_CAPTURE_BYTES) {
				errChunks.push(d);
				errBytes += d.length;
			}
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(Buffer.concat(errChunks).toString("utf-8").trim() || `command exited ${code}`));
				return;
			}
			const out = Buffer.concat(chunks).subarray(0, MAX_CAPTURE_BYTES).toString("utf-8");
			if (!opts.mergeStderr) {
				resolve(out);
				return;
			}
			const err = Buffer.concat(errChunks).subarray(0, MAX_CAPTURE_BYTES).toString("utf-8");
			resolve(err ? `${out}${err}` : out);
		});
	});
}

// Keeps text and Enter atomic.
const sends = createKeyedFifo<string>();
const targetKey = paneKey;

/** Capture the visible pane with ANSI colors; `resize: false` leaves the view's geometry. */
export async function peekPane(target: TmuxTarget, resize = true): Promise<TmuxPeek> {
	const pane = paneTarget(target);
	if (resize) {
		// Best effort: an old tmux lacks resize-window.
		await run(
			tmuxArgv(target, [
				"resize-window",
				"-t",
				exactSession(target.sessionName),
				"-x",
				String(TMUX_COLS),
				"-y",
				String(TMUX_ROWS),
			]),
		).catch(() => {});
	}
	// -J pads rows; trim before hashing so the hash covers what ships.
	const ansi = trimPaneRowPadding(await run(tmuxArgv(target, ["capture-pane", "-t", pane, "-e", "-J", "-p"])));
	const hash = crypto.createHash("sha256").update(ansi).digest("hex").slice(0, 16);
	return { ansi, hash };
}

/** The last `devcontainer up` transcript, then a bounded `docker logs` tail, while a pane does not exist yet. */
async function captureContainerLogs(target: TmuxTarget): Promise<{ text: string; hash: string }> {
	if (target.kind === "host") throw new Error(`no such container`);
	assertTmuxName(target.name);
	const transcript = buildTranscript(target.name);
	let logs = "";
	try {
		logs = await run(
			["docker", "logs", "--tail", String(CONTAINER_LOGS_TAIL), containerFor(target.name)],
			CONTAINER_LOGS_TIMEOUT_MS,
			{ mergeStderr: true },
		);
	} catch (error) {
		// Before the container exists, the transcript is the whole view.
		if (transcript === undefined) throw error;
	}
	const text = transcript === undefined ? logs : `${transcript}${logs ? `\n${logs}` : ""}`;
	const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
	return { text, hash };
}

/** The console-facing peek: the live pane, else container logs while it boots. Callers needing
 * reject-on-absent to detect a dead launch use `peekPane`. */
export async function peekWithFallback(target: TmuxTarget, resize = true): Promise<HostPeekResult> {
	try {
		const { ansi, hash } = await peekPane(target, resize);
		return { kind: "tmux", ansi, hash };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (classifyPeekError(message) !== "absent") throw err;
		try {
			const { text, hash } = await captureContainerLogs(target);
			return { kind: "container-logs", text, hash };
		} catch {
			// Rethrow the original: keeps the absent classification.
			throw err;
		}
	}
}

/** Callers hold the lock; nesting would deadlock. */
function sendKeyRaw(target: TmuxTarget, key: string): Promise<string> {
	return run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), key]));
}

/** Type a literal line; Enter is its own send-keys call, since an embedded CR reads as text. */
export function sendText(target: TmuxTarget, text: string, submit = true): Promise<void> {
	return sends.run(targetKey(target), async () => {
		assertNotReservedHostSink(target);
		await run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), "-l", "--", text]));
		if (submit) await sendKeyRaw(target, "Enter");
	});
}

export interface TypeIntoPaneOptions {
	timeoutMs?: number;
	pollMs?: number;
}

/**
 * Drops C0 and C1 controls but tab and newline. An escape could end the bracketed paste early
 * and type the rest as live keys.
 */
export function typeableText(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		const control = code < 0x20 ? code !== 0x09 && code !== 0x0a : code === 0x7f || (code >= 0x80 && code <= 0x9f);
		if (!control) out += ch;
	}
	return out;
}

export function typeIntoPane(
	target: TmuxTarget,
	text: string,
	options: TypeIntoPaneOptions = {},
): Promise<TypeIntoPaneResult> {
	const deadline = Date.now() + (options.timeoutMs ?? TYPE_INTO_PANE_WAIT_MS);
	const pollMs = options.pollMs ?? TYPE_INTO_PANE_POLL_MS;
	const typeable = typeableText(text);
	return sends.run(targetKey(target), async () => {
		assertNotReservedHostSink(target);
		// Nothing left to type is delivered; an empty buffer would fail the load.
		if (!typeable.trim()) return { typed: true };
		while (Date.now() < deadline) {
			const screen = (await peekPane(target, false)).ansi;
			// A signed-out composer is dead.
			if (isLoggedOut(screen)) return { typed: false, reason: "busy" };
			if (
				Date.now() < deadline &&
				isAgentReady(screen) &&
				!isAgentWorking(screen) &&
				isAgentComposerEmpty(screen)
			) {
				const bufferName = `switchboard-${crypto.randomUUID()}`;
				await run(tmuxStdinArgv(target, ["load-buffer", "-b", bufferName, "-"]), EXEC_TIMEOUT_MS, {
					input: typeable,
				});
				await run(tmuxArgv(target, ["paste-buffer", "-p", "-d", "-b", bufferName, "-t", paneTarget(target)]));
				await sendKeyRaw(target, "Enter");
				return { typed: true };
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
		}
		return { typed: false, reason: "busy" };
	});
}

/** Send a whitelisted control key. */
export function sendKey(target: TmuxTarget, key: string): Promise<void> {
	return sends.run(targetKey(target), async () => {
		assertNotReservedHostSink(target);
		if (!ALLOWED_KEYS.has(key)) throw new Error(`disallowed key "${key}"`);
		await sendKeyRaw(target, key);
	});
}

export interface PaneHands {
	/** The pane, never resized. */
	read: () => Promise<string>;
	press: (key: "Up" | "Down" | "Tab" | "Enter" | "C-x") => Promise<void>;
	type: (text: string) => Promise<void>;
}

/** Runs `work` holding the pane's send lock, so no other send interleaves. */
export function withPane<T>(target: TmuxTarget, work: (hands: PaneHands) => Promise<T>): Promise<T> {
	return sends.run(targetKey(target), async () => {
		assertNotReservedHostSink(target);
		return work({
			read: async () => (await peekPane(target, false)).ansi,
			press: async (key) => {
				await sendKeyRaw(target, key);
			},
			type: async (text) => {
				await run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), "-l", "--", typeableText(text)]));
			},
		});
	});
}

/** Start a detached tmux session. `command` is daemon-built, never console-supplied. */
export async function createSession(target: TmuxTarget, command: string): Promise<void> {
	assertTmuxName(target.sessionName);
	assertNotReservedHostSink(target);
	await run(tmuxArgv(target, ["new-session", "-d", "-s", target.sessionName, command]), 15_000);
}

/** The mutating sinks' last line of defense. Host-scoped: no devcontainer target is reserved. */
function assertNotReservedHostSink(target: TmuxTarget): void {
	if (target.kind === "host" && isReservedHostSession(target.sessionName)) {
		throw new Error(`refusing to operate reserved host session "${target.sessionName}"`);
	}
}

/** Tear down a tmux session. */
export async function killSession(target: TmuxTarget): Promise<void> {
	assertTmuxName(target.sessionName);
	assertNotReservedHostSink(target);
	try {
		await run(tmuxArgv(target, ["kill-session", "-t", exactSession(target.sessionName)]));
	} catch (err) {
		// Already gone is success. An unconfirmed kill is not, so it rethrows.
		if (classifyPeekError(err instanceof Error ? err.message : String(err)) !== "absent") throw err;
	}
}

/**
 * Whether an agent runs in the pane. A wrong "gone" kills work, so only positive evidence is "gone".
 * Evidence is the pane's tty, never `pane_current_command`.
 */
export type PaneAgentState = "alive" | "gone" | "unknown";

// A shell allowlist, not an agent denylist: a differently named agent must not read as gone.
const SHELL_COMMS = new Set(["sh", "bash", "zsh", "fish", "dash", "ash", "ps", "login", "su", "-bash", "-sh", "-zsh"]);

/** Pure rule, testable without tmux. */
export function classifyPaneProcesses(commLines: string[]): PaneAgentState {
	const comms = commLines.map((line) => line.trim()).filter(Boolean);
	// Empty means the probe failed.
	if (comms.length === 0) return `unknown`;
	return comms.every((comm) => SHELL_COMMS.has(comm)) ? "gone" : "alive";
}

/** One column of every process on the pane's tty, where the pane runs; undefined when unreadable. */
async function paneTtyColumn(target: TmuxTarget, column: "comm" | "pid"): Promise<string[] | undefined> {
	try {
		const tty = (
			await run(tmuxArgv(target, ["display-message", "-p", "-t", paneTarget(target), "#{pane_tty}"]))
		).trim();
		if (!tty.startsWith("/dev/")) return undefined;
		const listing = await run(execArgv(target, ["ps", "-t", tty, "-o", `${column}=`]));
		return listing.split("\n");
	} catch {
		return undefined;
	}
}

/** See [PaneAgentState]. Asks the OS what is on the pane's tty. */
export async function paneAgentState(target: TmuxTarget): Promise<PaneAgentState> {
	const comms = await paneTtyColumn(target, "comm");
	return comms ? classifyPaneProcesses(comms) : "unknown";
}

/** Whether the pid runs on the pane's tty, so a reused pid never reads as its launcher. */
export async function paneHolds(target: TmuxTarget, pid: number): Promise<boolean | undefined> {
	const pids = await paneTtyColumn(target, "pid");
	if (!pids) return undefined;
	const held = pids.map((line) => Number(line.trim())).filter((value) => value > 0);
	// A pane always carries its shell.
	return held.length === 0 ? undefined : held.includes(pid);
}

export type ReadyAnswer = Awaited<ReturnType<typeof awaitReady>>;

/** Undefined means agent gone. */
export function reattachStep(seen: ReadyAnswer | undefined): "relaunch" | "recheck" | "keep" {
	if (seen === undefined) return "relaunch";
	if (seen.limit) return "keep";
	return !seen.ready && !isAgentWorking(seen.screen) ? "recheck" : "keep";
}

/** Whether `target.sessionName` exists. */
export async function hasSession(target: TmuxTarget): Promise<boolean> {
	assertTmuxName(target.sessionName);
	try {
		await run(tmuxArgv(target, ["has-session", "-t", exactSession(target.sessionName)]));
		return true;
	} catch {
		return false;
	}
}

/** A digit selects and confirms, with no Enter. Daemon-pressed, so it skips the key whitelist. */
function pressDigit(target: TmuxTarget, digit: string): Promise<void> {
	return sends.run(targetKey(target), async () => {
		await run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), "-l", "--", digit]));
	});
}

/** A named key, for the menus a digit no longer answers. Daemon-pressed, so it skips the whitelist. */
function pressKey(target: TmuxTarget, key: "Up" | "Down" | "Enter"): Promise<void> {
	return sends.run(targetKey(target), async () => {
		await run(tmuxArgv(target, ["send-keys", "-t", paneTarget(target), key]));
	});
}

/** An unfound trust cursor or Yes row is left alone: Enter could pick "No, exit". */
async function answerStartupPrompt(target: TmuxTarget, clean: string): Promise<void> {
	if (NUMBERED_MENU_RE.test(clean) || COPILOT_TRUST_RE.test(clean)) return pressDigit(target, "1");
	const lines = clean.split("\n");
	const yes = lines.findIndex((line) => TRUST_YES_RE.test(line));
	if (yes >= 0) {
		const cursor = lines.findIndex((line) => MENU_CURSOR_ROW_RE.test(line));
		if (cursor < 0) return;
		// Options render contiguous; a blank row between them is layout, not a choice.
		const [from, to] = cursor < yes ? [cursor, yes] : [yes, cursor];
		const steps = lines.slice(from + 1, to + 1).filter((line) => line.trim() !== "").length;
		for (let i = 0; i < steps; i += 1) await pressKey(target, cursor < yes ? "Down" : "Up");
	}
	await pressKey(target, "Enter");
}

/** Poll until the composer appears, pressing through the startup and resume menus. */
export async function awaitReady(
	target: TmuxTarget,
	opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ alive: boolean; ready: boolean; screen: string; limit?: LimitNotice }> {
	const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? READY_POLL_MS;
	const deadline = Date.now() + timeoutMs;
	let captureOk = false;
	let missedProbes = 0;
	let screen = "";
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, pollMs));
		try {
			screen = (await peekPane(target)).ansi;
			captureOk = true;
		} catch {
			// Never captured means a dead launch.
			if (!captureOk && ++missedProbes >= DEAD_LAUNCH_PROBES) return { alive: false, ready: false, screen };
			continue;
		}
		// SGR escapes split a prompt phrase.
		const clean = stripAnsi(screen);
		// A prompt outranks a stale composer sharing its frame.
		if (STARTUP_PROMPT_RE.test(clean)) {
			try {
				await answerStartupPrompt(target, clean);
			} catch {
				// Self-heals next poll.
			}
			continue;
		}
		if (RESUME_PROMPT_RE.test(clean)) {
			try {
				await pressDigit(target, "2");
			} catch {
				// Self-heals next poll.
			}
			continue;
		}
		// Answers nothing: one choice buys usage credits.
		const limit = limitNotice(clean);
		if (limit) return { alive: true, ready: false, screen, limit };
		if (isAgentReady(clean)) return { alive: true, ready: true, screen };
	}
	const finalClean = stripAnsi(screen);
	const prompted = STARTUP_PROMPT_RE.test(finalClean) || RESUME_PROMPT_RE.test(finalClean);
	return { alive: captureOk, ready: !prompted && isAgentReady(finalClean), screen };
}

/** Reattach if alive, else launch. A duplicate `new-session` errors, hence the recheck. */
export async function ensureSession(target: TmuxTarget, command: string): Promise<{ created: boolean }> {
	if (await hasSession(target)) return { created: false };
	try {
		await createSession(target, command);
		return { created: true };
	} catch (err) {
		if (await hasSession(target)) return { created: false };
		throw err;
	}
}
