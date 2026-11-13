import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture every spawned argv and simulate a clean (or failing) child, so we can assert
// the exact tmux command shapes without a real tmux/docker.
const calls: string[][] = [];
const captureScreens: string[] = [];
const stdinWrites: string[] = [];
let exitCode = 0;
// Per-spawn exit codes consumed in order; falls back to the global exitCode when empty. Lets a test
// drive a multi-spawn sequence (e.g. has-session fails, then new-session succeeds).
const exitQueue: number[] = [];
let stdoutData = "";
// Scripted stderr emitted on a non-zero exit, so a test can drive the exact failure wording
// killSession classifies on (e.g. tmux's "can't find session" vs an unrecognized failure).
let stderrData = "";
// Scripted stderr for a `docker logs` spawn, emitted regardless of exit code (docker sends a
// container's stderr there on a clean run). Lets a test drive the mergeStderr fold.
let logsStderr = "";
// Delays Enter exits.
let holdEnter: Promise<void> | null = null;

vi.mock("node:child_process", () => ({
	spawn: (cmd: string, args: string[]) => {
		calls.push([cmd, ...args]);
		const code = exitQueue.length ? (exitQueue.shift() as number) : exitCode;
		const child = new EventEmitter() as EventEmitter & {
			stdin: EventEmitter & { end: (data?: string | Uint8Array) => void };
			stdout: EventEmitter;
			stderr: EventEmitter;
			kill: () => void;
		};
		child.stdin = Object.assign(new EventEmitter(), {
			end: (data?: string | Uint8Array) => {
				if (data !== undefined) stdinWrites.push(String(data));
			},
		});
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		// Only a reading command returns stdout; a send-keys / has-session / etc. has none, so a
		// scripted screen is not consumed by the "1" keypresses awaitReady interleaves with its peeks.
		const reads = ["capture-pane", "logs", "display-message", "ps"];
		const out = args.includes("capture-pane")
			? (captureScreens.shift() ?? stdoutData)
			: args.some((a) => reads.includes(a))
				? stdoutData
				: "";
		const exit = () => {
			if (out) child.stdout.emit("data", Buffer.from(out));
			if (args.includes("logs") && logsStderr) child.stderr.emit("data", Buffer.from(logsStderr));
			if (code !== 0 && stderrData) child.stderr.emit("data", Buffer.from(stderrData));
			child.emit("close", code);
		};
		if (holdEnter && args.includes("Enter")) void holdEnter.then(exit);
		else queueMicrotask(exit);
		return child;
	},
}));

import {
	awaitReady,
	classifyPaneProcesses,
	createSession,
	ENTER_PAUSE_MS,
	ensureSession,
	hasSession,
	isAgentReady,
	isAgentWorking,
	isLoggedOut,
	killSession,
	paneAgentState,
	peekPane,
	peekWithFallback,
	type ReadyAnswer,
	reattachStep,
	selfSessionTarget,
	sendKey,
	sendText,
	typeIntoPane,
} from "../mcp/devcontainer/tmuxCore.js";
import { isCompacting, restartPending } from "../shared/agent-screen.js";
import type { TmuxTarget } from "../shared/host-op.js";
import { DEFAULT_SESSION } from "../shared/session-id.js";

afterEach(() => {
	calls.length = 0;
	captureScreens.length = 0;
	stdinWrites.length = 0;
	exitCode = 0;
	exitQueue.length = 0;
	stdoutData = "";
	stderrData = "";
	logsStderr = "";
	holdEnter = null;
});

describe("tmuxCore sendText", () => {
	it("types text then sends Enter as its own send-keys call, with -- guarding a leading dash", async () => {
		await sendText({ kind: "host", name: "host", sessionName: "claude" }, "-l hello", true, 0);
		// Two invocations: Enter rides as its own send-keys call rather than an embedded CR, since a
		// target CLI's paste detection would otherwise swallow an embedded CR as inserted text
		// instead of a submit keypress.
		expect(calls).toEqual([
			["tmux", "send-keys", "-t", "=claude.0", "-l", "--", "-l hello"],
			["tmux", "send-keys", "-t", "=claude.0", "Enter"],
		]);
	});

	it("holds Enter back from the text, so a CLI cannot read both as one paste", async () => {
		vi.useFakeTimers();
		try {
			const sent = sendText({ kind: "host", name: "host", sessionName: "claude" }, "hello");
			await vi.advanceTimersByTimeAsync(ENTER_PAUSE_MS - 1);
			expect(calls.map((call) => call.at(-1))).toEqual(["hello"]);

			await vi.advanceTimersByTimeAsync(1);
			await sent;
			expect(calls.map((call) => call.at(-1))).toEqual(["hello", "Enter"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("omits the trailing CR when submit is false (types into the composer without submitting)", async () => {
		await sendText({ kind: "host", name: "host", sessionName: "claude" }, "hello", false);
		expect(calls).toEqual([["tmux", "send-keys", "-t", "=claude.0", "-l", "--", "hello"]]);
	});

	it("targets a devcontainer via docker exec by the compose container name", async () => {
		await sendText({ kind: "devcontainer", name: "recipe-app", sessionName: "claude" }, "hi", true, 0);
		expect(calls).toEqual([
			[
				"docker",
				"exec",
				"-u",
				"vscode",
				"recipe-app_devcontainer-dev-1",
				"tmux",
				"send-keys",
				"-t",
				"=claude.0",
				"-l",
				"--",
				"hi",
			],
			[
				"docker",
				"exec",
				"-u",
				"vscode",
				"recipe-app_devcontainer-dev-1",
				"tmux",
				"send-keys",
				"-t",
				"=claude.0",
				"Enter",
			],
		]);
	});

	it("refuses to inject text into a reserved host session without spawning anything", async () => {
		await expect(sendText({ kind: "host", name: "host", sessionName: "host-daemon" }, "hi")).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});

	it("keeps a later send behind an earlier one across a kill", async () => {
		const target: TmuxTarget = { kind: "host", name: "host", sessionName: "claude" };
		let release = () => {};
		holdEnter = new Promise((resolve) => {
			release = resolve;
		});
		const first = sendText(target, "one", true, 0);
		await killSession(target);
		const second = sendText(target, "two", true, 0);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls.some((call) => call.includes("two"))).toBe(false);

		release();
		await Promise.all([first, second]);
		const sent = calls.filter((call) => call.includes("send-keys")).map((call) => call.at(-1));
		expect(sent).toEqual(["one", "Enter", "two", "Enter"]);
	});
});

describe("tmuxCore sendKey", () => {
	it("sends an allowed control key with no -l and no trailing Enter", async () => {
		await sendKey({ kind: "host", name: "host", sessionName: "claude" }, "C-c");
		expect(calls).toEqual([["tmux", "send-keys", "-t", "=claude.0", "C-c"]]);
	});

	it("rejects a key not on the whitelist without spawning anything", async () => {
		await expect(sendKey({ kind: "host", name: "host", sessionName: "claude" }, "rm -rf")).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});

	it("refuses a control key to a reserved host session without spawning anything", async () => {
		await expect(sendKey({ kind: "host", name: "host", sessionName: "host-daemon" }, "C-c")).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});
});

describe("tmuxCore typeIntoPane", () => {
	const target: TmuxTarget = { kind: "host", name: "host", sessionName: "copilot" };

	it("waits for an empty idle composer, then pastes once and submits, with no key a paste could end on", async () => {
		captureScreens.push("──────\n❯ a draft\n──────", "──────\n❯ \n──────");
		const [esc, cr, csi] = [0x1b, 0x0d, 0x9b].map((code) => String.fromCharCode(code));
		const text = `first line${cr}\nsecond${esc}[201~ line\tend${csi}2J`;

		expect(await typeIntoPane(target, text, { timeoutMs: 100, pollMs: 1, enterPauseMs: 0 })).toEqual({
			typed: true,
		});
		expect(calls.filter((call) => call.includes("capture-pane"))).toHaveLength(2);
		const load = calls.find((call) => call.includes("load-buffer"));
		const paste = calls.find((call) => call.includes("paste-buffer"));
		expect(stdinWrites).toEqual(["first line\nsecond[201~ line\tend2J"]);
		expect(load?.slice(1)).toEqual(["load-buffer", "-b", expect.any(String), "-"]);
		expect(paste?.slice(1)).toEqual(["paste-buffer", "-p", "-d", "-b", load?.[3], "-t", "=copilot.0"]);
		expect(calls.at(-1)).toEqual(["tmux", "send-keys", "-t", "=copilot.0", "Enter"]);
	});

	it("answers busy at once for a signed-out CLI whose empty composer reads ready, and types nothing", async () => {
		const vectors = JSON.parse(
			fs.readFileSync(path.join(import.meta.dirname, "../../tests/fixtures/agent-screen/vectors.json"), "utf8"),
		) as { vectors: Array<{ name: string; screen: string }> };
		const loggedOut = vectors.vectors.find((vector) => vector.name === "copilot-logged-out")?.screen ?? "";
		stdoutData = loggedOut;

		expect(await typeIntoPane(target, "hello", { timeoutMs: 100, pollMs: 1, enterPauseMs: 0 })).toEqual({
			typed: false,
			reason: "busy",
		});
		expect(loggedOut).not.toBe("");
		expect(calls.filter((call) => call.includes("capture-pane"))).toHaveLength(1);
		expect(calls.some((call) => call.includes("load-buffer") || call.includes("send-keys"))).toBe(false);
	});

	it("returns busy at its deadline without typing", async () => {
		stdoutData = "──────\n❯ \n──────\n◎ Working · 470 B esc interrupt";

		expect(await typeIntoPane(target, "wait", { timeoutMs: 8, pollMs: 2 })).toEqual({
			typed: false,
			reason: "busy",
		});
		expect(calls.some((call) => call.includes("load-buffer") || call.includes("paste-buffer"))).toBe(false);
		expect(calls.some((call) => call.includes("send-keys"))).toBe(false);
	});

	it("keeps stdin attached when loading a buffer inside Docker", async () => {
		captureScreens.push("──────\n❯ \n──────");
		const target: TmuxTarget = { kind: "devcontainer", name: "recipe-app", sessionName: "copilot" };

		await expect(typeIntoPane(target, "hello", { timeoutMs: 100, pollMs: 1, enterPauseMs: 0 })).resolves.toEqual({
			typed: true,
		});
		expect(calls.find((call) => call.includes("load-buffer"))).toEqual([
			"docker",
			"exec",
			"-i",
			"-u",
			"vscode",
			"recipe-app_devcontainer-dev-1",
			"tmux",
			"load-buffer",
			"-b",
			expect.any(String),
			"-",
		]);
	});
});

describe("tmuxCore peekPane", () => {
	it("resizes the detached session to fit the phone, then captures the visible pane with a hash", async () => {
		stdoutData = "screen contents";
		const r = await peekPane({ kind: "host", name: "host", sessionName: "claude" });
		expect(calls[0]).toEqual(["tmux", "resize-window", "-t", "=claude", "-x", "53", "-y", "38"]);
		// -J joins wrapped rows, so a selected URL copies as one string.
		expect(calls[1]).toEqual(["tmux", "capture-pane", "-t", "=claude.0", "-e", "-J", "-p"]);
		expect(r.ansi).toBe("screen contents");
		expect(r.hash).toMatch(/^[0-9a-f]{16}$/);
	});

	it("rejects a target name that is not a slug before reaching docker", async () => {
		await expect(peekPane({ kind: "devcontainer", name: "x;y", sessionName: "claude" })).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});

	it("rejects a crafted session name before reaching tmux", async () => {
		await expect(peekPane({ kind: "host", name: "host", sessionName: "a;b" })).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});
});

describe("tmuxCore peekWithFallback", () => {
	const dev: TmuxTarget = { kind: "devcontainer", name: "recipe-app", sessionName: "scratch" };

	it("returns the tmux pane tagged kind:tmux when the pane exists", async () => {
		stdoutData = "PANE";
		const r = await peekWithFallback(dev);
		expect(r).toMatchObject({ kind: "tmux", ansi: "PANE" });
	});

	it("falls back to container logs (kind:container-logs) when the pane is absent", async () => {
		stdoutData = "postCreate installing deps";
		stderrData = "can't find session";
		// resize (ok), capture-pane (absent), then docker logs (ok).
		exitQueue.push(0, 1, 0);
		const r = await peekWithFallback(dev);
		expect(r.kind).toBe("container-logs");
		if (r.kind === "container-logs") expect(r.text).toBeTruthy();
		// The tail count + compose container-name convention reach docker verbatim.
		expect(calls.find((c) => c.includes("logs"))).toEqual([
			"docker",
			"logs",
			"--tail",
			"200",
			"recipe-app_devcontainer-dev-1",
		]);
	});

	it("folds a container's stderr into the log text so a boot error is not lost", async () => {
		stdoutData = "starting";
		stderrData = "can't find session";
		logsStderr = "postCreate.sh: line 3: npm: command not found";
		exitQueue.push(0, 1, 0); // resize ok, capture absent, docker logs ok
		const r = await peekWithFallback(dev);
		expect(r.kind).toBe("container-logs");
		if (r.kind === "container-logs") {
			expect(r.text).not.toBe("starting");
		}
	});

	it("rethrows a real failure without trying container logs", async () => {
		stderrData = "tmux command exited 2";
		exitQueue.push(0, 1); // resize ok, capture a non-absent failure
		await expect(peekWithFallback(dev)).rejects.toThrow();
		expect(calls.some((c) => c.includes("logs"))).toBe(false);
	});

	it("rethrows the original absent peek error when the container is also gone", async () => {
		stderrData = "can't find session";
		exitQueue.push(0, 1, 1); // resize ok, capture absent, docker logs also fails
		await expect(peekWithFallback(dev)).rejects.toThrow();
	});
});

describe("tmuxCore createSession", () => {
	it("creates a detached session by name on the host running the command", async () => {
		await createSession({ kind: "host", name: "host", sessionName: "scratch" }, "claude --foo");
		expect(calls).toEqual([["tmux", "new-session", "-d", "-s", "scratch", "claude --foo"]]);
	});

	it("creates a session inside a devcontainer via docker exec", async () => {
		await createSession({ kind: "devcontainer", name: "recipe-app", sessionName: "scratch" }, "claude");
		expect(calls[0]).toEqual([
			"docker",
			"exec",
			"-u",
			"vscode",
			"recipe-app_devcontainer-dev-1",
			"tmux",
			"new-session",
			"-d",
			"-s",
			"scratch",
			"claude",
		]);
	});

	it("rejects a crafted session name before spawning anything", async () => {
		await expect(createSession({ kind: "host", name: "host", sessionName: "a;b" }, "claude")).rejects.toThrow(
			/invalid tmux name/,
		);
		expect(calls).toHaveLength(0);
	});
});

describe("tmuxCore hasSession / ensureSession", () => {
	it("hasSession is true when has-session exits 0", async () => {
		const alive = await hasSession({ kind: "devcontainer", name: "recipe-app", sessionName: "scratch" });
		expect(alive).toBe(true);
		expect(calls[0]).toEqual([
			"docker",
			"exec",
			"-u",
			"vscode",
			"recipe-app_devcontainer-dev-1",
			"tmux",
			"has-session",
			"-t",
			"=scratch",
		]);
	});

	it("hasSession is false when has-session exits non-zero (absent, not an error)", async () => {
		exitCode = 1;
		expect(await hasSession({ kind: "host", name: "host", sessionName: "scratch" })).toBe(false);
	});

	it("ensureSession reattaches an existing session without launching a new one", async () => {
		exitCode = 0; // has-session succeeds
		const r = await ensureSession({ kind: "host", name: "host", sessionName: "scratch" }, "claude");
		expect(r).toEqual({ created: false });
		expect(calls).toHaveLength(1); // only has-session, no new-session
		expect(calls[0]).toEqual(["tmux", "has-session", "-t", "=scratch"]);
	});

	it("ensureSession launches a fresh session when absent", async () => {
		exitQueue.push(1, 0); // has-session absent, then new-session succeeds
		const r = await ensureSession({ kind: "host", name: "host", sessionName: "scratch" }, "claude");
		expect(r).toEqual({ created: true });
		expect(calls[0]).toEqual(["tmux", "has-session", "-t", "=scratch"]);
		expect(calls[1]).toEqual(["tmux", "new-session", "-d", "-s", "scratch", "claude"]);
		expect(calls).toHaveLength(2);
	});

	it("ensureSession treats a duplicate (lost race) as a reattach when the session now exists", async () => {
		// has-session misses (absent or transient), new-session loses a race / errors duplicate, then
		// the re-check finds the session present.
		exitQueue.push(1, 1, 0);
		const r = await ensureSession({ kind: "host", name: "host", sessionName: "scratch" }, "claude");
		expect(r).toEqual({ created: false });
		expect(calls).toHaveLength(3); // has-session, new-session, re-check has-session
	});

	it("ensureSession surfaces the failure when the session is still absent after a failed create", async () => {
		exitQueue.push(1, 1, 1); // absent, create fails, still absent
		await expect(ensureSession({ kind: "host", name: "host", sessionName: "scratch" }, "claude")).rejects.toThrow();
	});
});

describe("tmuxCore paneAgentState", () => {
	// The real listings, taken from a pane whose agent was SIGKILLed and from a live one beside it.
	const DEAD = ["sh", "bash"];
	const LIVE = ["sh", "bash", "claude", "MainThread", "MainThread", "nyaascripts"];

	it("reads a shells-only tty as gone and anything else as alive", () => {
		expect(classifyPaneProcesses(DEAD)).toBe("gone");
		expect(classifyPaneProcesses(LIVE)).toBe("alive");
	});

	it("relaunches a gone agent, keeps a ready or limited one, and rechecks a blank frame", () => {
		const limit = { headline: "limit", detail: "resets 4pm" } as unknown as NonNullable<ReadyAnswer["limit"]>;
		expect([
			reattachStep(undefined),
			reattachStep({ alive: true, ready: true, screen: "" }),
			reattachStep({ alive: true, ready: false, screen: "", limit }),
			reattachStep({ alive: true, ready: false, screen: "" }),
		]).toEqual(["relaunch", "keep", "keep", "recheck"]);
	});

	it("never answers gone without evidence, since gone is what relaunches", () => {
		// Nothing at all is a probe that failed to look: a pane always carries at least its shell.
		expect(classifyPaneProcesses([])).toBe("unknown");
		expect(classifyPaneProcesses(["", "  "])).toBe("unknown");
		// An agent whose process is named something else must NOT read as gone - matching on a shell
		// allowlist rather than on "claude" is what keeps a wrong guess from killing live work.
		expect(classifyPaneProcesses(["sh", "bash", "node"])).toBe("alive");
	});

	it("asks the pane's own tty, inside the container for a devcontainer target", async () => {
		stdoutData = "/dev/pts/7\n";
		await paneAgentState({ kind: "devcontainer", name: "recipe-app", sessionName: "scratch" });
		expect(calls[0]).toEqual([
			"docker",
			"exec",
			"-u",
			"vscode",
			"recipe-app_devcontainer-dev-1",
			"tmux",
			"display-message",
			"-p",
			"-t",
			"=scratch.0",
			"#{pane_tty}",
		]);
		// The listing runs in the same namespace: a host ps would answer about the wrong machine.
		expect(calls[1]).toEqual([
			"docker",
			"exec",
			"-u",
			"vscode",
			"recipe-app_devcontainer-dev-1",
			"ps",
			"-t",
			"/dev/pts/7",
			"-o",
			"comm=",
		]);
	});

	it("answers unknown when the probe itself fails, rather than guessing gone", async () => {
		exitCode = 1;
		expect(await paneAgentState({ kind: "host", name: "host", sessionName: "scratch" })).toBe("unknown");
		// A tty tmux would not name is equally no evidence.
		exitCode = 0;
		stdoutData = "";
		expect(await paneAgentState({ kind: "host", name: "host", sessionName: "scratch" })).toBe("unknown");
	});
});

describe("tmuxCore isAgentReady", () => {
	it("is false for an empty or still-booting pane", () => {
		expect(isAgentReady("")).toBe(false);
		expect(isAgentReady("Loading development channels...")).toBe(false);
	});

	it("is false at an indented menu cursor (a launch menu, not the composer)", () => {
		expect(isAgentReady("  ❯ 1. I am using this for local development\n    2. Exit")).toBe(false);
	});

	it("is true at the column-0 composer prompt (fresh idle REPL)", () => {
		expect(isAgentReady("❯ ")).toBe(true);
	});

	it("is true at a resumed REPL whose header scrolled off (composer still shows)", () => {
		expect(isAgentReady("...restored conversation...\n❯ ")).toBe(true);
	});

	it("sees the composer through the SGR escapes a real -e capture prefixes it with", () => {
		// capture-pane -e renders the composer line as e.g. "\e[39m❯ \e[2mTry\e[0m".
		const esc = String.fromCharCode(27);
		expect(isAgentReady(`${esc}[39m❯ ${esc}[2mTry${esc}[0m`)).toBe(true);
	});

	it("CANNOT see that the agent died, which is why the wake gate does not rely on it", () => {
		// A real killed pane: the frame the agent painted is frozen exactly as it was and the shell's
		// output lands after it, so the composer is still at column 0 and this answers TRUE for a pane
		// running nothing. Pinned rather than fixed - no screen rule separates a frozen frame from a
		// live one, so hostDaemon asks the OS (paneAgentState) instead of tightening this.
		const killed = [
			"────────────────",
			"❯ bash: line 1: 1715643 Killed   claude --model opus",
			"user@host:~$ ",
		].join("\n");
		expect(isAgentReady(killed)).toBe(true);
		expect(classifyPaneProcesses(["sh", "bash"])).toBe("gone");
	});
});

describe("tmuxCore killSession", () => {
	it("kills the target session by name", async () => {
		await killSession({ kind: "host", name: "host", sessionName: "scratch" });
		expect(calls).toEqual([["tmux", "kill-session", "-t", "=scratch"]]);
	});

	it("kills a devcontainer session via docker exec", async () => {
		await killSession({ kind: "devcontainer", name: "recipe-app", sessionName: "scratch" });
		expect(calls[0]).toEqual([
			"docker",
			"exec",
			"-u",
			"vscode",
			"recipe-app_devcontainer-dev-1",
			"tmux",
			"kill-session",
			"-t",
			"=scratch",
		]);
	});

	it("treats an already-gone session as success (swallows the absent error)", async () => {
		exitCode = 1; // kill-session exits non-zero when the session is absent
		stderrData = "can't find session: scratch";
		await expect(killSession({ kind: "host", name: "host", sessionName: "scratch" })).resolves.toBeUndefined();
	});

	it("rethrows when the kill is unconfirmed (not a recognized absent error)", async () => {
		// A timeout or unrecognized exit means the kill is unconfirmed; rethrow so a forget does not
		// drop the resume record over a still-live tmux. The generic non-zero exit classifies as a
		// failure (no absent stderr), the conservative default.
		exitCode = 1;
		await expect(killSession({ kind: "host", name: "host", sessionName: "scratch" })).rejects.toThrow();
	});
});

describe("tmuxCore isAgentWorking", () => {
	it("is working when the esc-to-interrupt hint is on the last line", () => {
		expect(isAgentWorking("✻ Prestidigitating… (12s · esc to interrupt)")).toBe(true);
		expect(isAgentWorking("✻ Brewed for 7s")).toBe(false);
		expect(isAgentWorking("")).toBe(false);
		expect(isAgentWorking("❯ ")).toBe(false);
	});

	it("can land on either of the last two lines depending on how the pane wraps", () => {
		expect(isAgentWorking("✻ Prestidigitating…\n(12s · esc to interrupt)")).toBe(true);
		expect(isAgentWorking("(12s · esc to interrupt)\n✻ Prestidigitating…")).toBe(true);
	});

	it("ignores a hint more than two lines back when there is no rule to bound the search by", () => {
		expect(isAgentWorking("(12s · esc to interrupt)\n● Done.\n❯ ")).toBe(false);
	});

	it("finds the hint any distance below the rule, since the footer's height is dynamic", () => {
		const rule = "─".repeat(40);
		// 3 lines above the very bottom - past the old fixed "last 2 lines" heuristic - but below the
		// rule, so the properly-bounded footer search still finds it.
		expect(
			isAgentWorking(
				`❯ \n${rule}\n✻ Prestidigitating… (12s · esc to interrupt)\n  ⏵⏵ bypass permissions on\n  ← for agents`,
			),
		).toBe(true);
		// A hint ABOVE the rule is transcript/history, not the live footer - never counts, even when
		// it would fall within some arbitrary distance of the bottom.
		expect(isAgentWorking(`● It said (12s · esc to interrupt)\n${rule}\n❯ `)).toBe(false);
	});

	it("strips the SGR escapes around the hint", () => {
		const esc = String.fromCharCode(27);
		expect(isAgentWorking(`✻ Prestidigitating${esc}[2m… (12s ${esc}[2m·${esc}[0m esc to interrupt)${esc}[0m`)).toBe(
			true,
		);
	});

	it("reads compacting through a wrapped tip, but not from far up the transcript", () => {
		const rule = "─".repeat(40);
		const tip = "  ⎿  Tip: Run claude --continue or\n     claude --resume to resume a\n     conversation";
		const pane = `· Compacting conversation… (10s)\n${tip}\n   0% until auto-compact\n${rule}\n❯ \n${rule}`;
		expect(isCompacting(pane)).toBe(true);
		expect(isCompacting(pane.replace("Compacting", "Composing"))).toBe(false);
		expect(isCompacting(pane.replace(tip, `${tip}\n\n\n\n`))).toBe(false);
	});

	it("reads Claude's update-installed status line as a pending restart, and nothing for Copilot yet", () => {
		const rule = "─".repeat(40);
		const pane = `  new task? /clear to… · ✔ Update installed · /res…\n${rule}\n❯ \n${rule}\n  ⏵⏵ don't ask on`;
		expect(restartPending("claude", pane)).toBe(true);
		expect(restartPending("copilot", pane)).toBe(false);
		// Typed in the composer, it is not the status line.
		expect(restartPending("claude", `${rule}\n❯ Update installed\n${rule}`)).toBe(false);
	});

	it("reads a teammate below the toolbar as working until its row says idle", () => {
		const rule = "─".repeat(40);
		const crew = (...rows: string[]) =>
			`❯ \n${rule}\n  ⏵⏵ bypass permissions on · ↓ to manage\n  ● main\n${rows.join("\n")}`;
		expect(isAgentWorking(crew("  ◯ ieee  IEEE 754… 15s · ↓ 191.5k tokens"))).toBe(true);
		expect(isAgentWorking(crew("  ◯ ieee  IEEE 754 subnormals 1s"))).toBe(true);
		// Viewing the teammate swaps the dots.
		expect(isAgentWorking(`❯ \n${rule}\n  ◯ main\n  ● ieee  IEEE 754… 15s`)).toBe(true);
		expect(isAgentWorking(crew("  ◯ ieee  IEEE 754 subnormals                idle"))).toBe(false);
		expect(isAgentWorking(crew("  ◯ red-team  ▰▰▰▰▰▰  6/6"))).toBe(false);
		expect(isAgentWorking(crew())).toBe(false);
		// Above the composer is transcript.
		expect(isAgentWorking(`  ◯ ieee  IEEE 754… 15s\n${rule}\n❯ `)).toBe(false);
	});

	it("reads only an unfinished workflow row below the toolbar as working", () => {
		const rule = "─".repeat(40);
		const pane = (row: string) => `❯ \n${rule}\n  ⏵⏵ bypass permissions on\n\n${row}`;
		expect(isAgentWorking(pane("  ◯ red-team  ▰▰▰▱▱▱  3/6 · 9s"))).toBe(true);
		expect(isAgentWorking(pane("  ◯ red-team  ▱▱▱▱▱▱  0/6 · 0s"))).toBe(true);
		expect(isAgentWorking(pane("  ◯ red-team  ▰▰▰▰▰▰  6/6"))).toBe(false);
		// A full bar still finishing says so above the composer.
		const finishing = `✻ Waiting for 1 dynamic workflow to finish\n${rule}\n❯ \n${rule}\n  ◯ red-team  ▰▰▰▰▰▰  6/6`;
		expect(isAgentWorking(finishing)).toBe(true);
		// A meter that is not a workflow row.
		expect(isAgentWorking(pane("  ctx ▰▰▱▱▱▱ 31%"))).toBe(false);
		expect(isAgentWorking(`  ◯ red-team  ▱▱▱▱▱▱\n${rule}\n❯ `)).toBe(false);
	});

	/**
	 * The status line a running turn draws ABOVE the composer, which is where the CLI puts it now.
	 *
	 * The footer alone cannot answer this: the toolbar elides "esc to interrupt" to an ellipsis when
	 * the pane is too narrow, and the mode label counts toward that width, so a session in bypass mode
	 * loses the only marker the footer ever carried.
	 */
	it("reads the status line above the composer, where the footer hint has been elided away", () => {
		const rule = "─".repeat(40);
		const toolbar = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · …";
		const working = `✶ Composing… (46m 51s · ↓ 154.1k tokens)\n${rule}\n❯ \n${rule}\n${toolbar}`;
		expect(isAgentWorking(working)).toBe(true);
		const idle = `● Done.\n${rule}\n❯ \n${rule}\n${toolbar}`;
		expect(isAgentWorking(idle)).toBe(false);
	});

	it("reads a spinner and its verb as working with or without a token run, and a finished turn as idle", () => {
		const rule = "─".repeat(40);
		const toolbar = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · …";
		const pane = (status: string) => `${status}\n${rule}\n❯ \n${rule}\n${toolbar}`;
		expect(isAgentWorking(pane("✢ Cogitating…"))).toBe(true);
		expect(isAgentWorking(pane("* Calling plugin:switchboard:switchboard…"))).toBe(true);
		expect(isAgentWorking(pane("✻ Churned for 2h 6m 20s · done 3:31 PM"))).toBe(false);
		expect(isAgentWorking(pane("● Bash(cd /tmp/claude-1000/kit && rm -f out/…)"))).toBe(false);
		expect(isAgentWorking(pane("  ✔ Update installed · Restart…"))).toBe(false);
		expect(isAgentWorking(pane("\n  ✔ Update installed · Restart…"))).toBe(false);
		expect(isAgentWorking(pane("❯ please check the logs…"))).toBe(false);
		expect(isAgentWorking(pane("- fix the thing…"))).toBe(false);
	});

	// Bounded on purpose. Far enough above the composer is transcript, and a transcript can quote
	// anything, including a pane.
	it("does not read a status line from arbitrarily far up the transcript", () => {
		const rule = "─".repeat(40);
		const far = ["✶ Composing… (1m 2s · ↓ 9k tokens)", "", "", "", "", "", "", `${rule}`, "❯ "].join("\n");
		expect(isAgentWorking(far)).toBe(false);
	});
});

describe("tmuxCore isLoggedOut", () => {
	const rule = "─".repeat(40);

	it("is true when the toolbar below the last rule shows the auth footer", () => {
		const screen = `❯ \n${rule}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents    Not logged in · Run /login\n  ◐ medium · /effort`;
		expect(isLoggedOut(screen)).toBe(true);
	});

	it("is false at a logged-in REPL (no auth footer in the toolbar)", () => {
		const screen = `❯ \n${rule}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;
		expect(isLoggedOut(screen)).toBe(false);
	});

	it("ignores the phrase above the last rule (transcript or composer), not anywhere in the body", () => {
		const screen = `● The DB replied: Not logged in. Run /login there.\n${rule}\n❯ Run /login\n${rule}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;
		expect(isLoggedOut(screen)).toBe(false);
	});

	it("strips the SGR escapes a real -e capture wraps the footer in", () => {
		const esc = String.fromCharCode(27);
		const ruleAnsi = `${esc}[2m${rule}${esc}[0m`;
		const screen = `❯ \n${ruleAnsi}\n  ⏵⏵ for agents  ${esc}[33mNot logged in${esc}[0m · ${esc}[1mRun /login${esc}[0m`;
		expect(isLoggedOut(screen)).toBe(true);
	});
});

describe("tmuxCore awaitReady", () => {
	const target = { kind: "host", name: "host", sessionName: "scratch" } as const;

	it("returns ready+alive once the composer appears, pressing no key", async () => {
		stdoutData = "...restored...\n❯ ";
		const res = await awaitReady(target, { pollMs: 5, timeoutMs: 200 });
		expect(res).toMatchObject({ alive: true, ready: true });
		expect(calls.some((c) => c.includes("send-keys") && c.includes("1"))).toBe(false);
	});

	it('presses "1" to clear the dev-channels menu while not yet at the REPL', async () => {
		stdoutData = "  ❯ 1. I am using this for local development\n    2. Exit";
		const res = await awaitReady(target, { pollMs: 5, timeoutMs: 40 });
		expect(res).toMatchObject({ alive: true, ready: false });
		expect(calls).toContainEqual(["tmux", "send-keys", "-t", "=scratch.0", "-l", "--", "1"]);
	});

	it('presses "1" on the folder-trust and fullscreen-renderer prompts too', async () => {
		for (const menu of [
			"  Is this a project you created or one you trust?\n  ❯ 1. Yes, I trust this folder\n    2. No, exit",
			"  Try the new fullscreen renderer?\n  ❯ 1. Yes, try it\n    2. Not now",
		]) {
			calls.length = 0;
			stdoutData = menu;
			await awaitReady(target, { pollMs: 5, timeoutMs: 30, enterPauseMs: 0 });
			expect(calls).toContainEqual(["tmux", "send-keys", "-t", "=scratch.0", "-l", "--", "1"]);
		}
	});

	it("walks the cursor onto Yes and confirms an unnumbered trust dialog that rests on No, exit", async () => {
		// A newer build on a fresh Windows machine, captured from the phone's terminal view.
		stdoutData = [
			" Accessing workspace:",
			"",
			" C:\\Users\\nyaarium",
			"",
			" Quick safety check: Is this a project you created",
			" or one you trust? (Like your own code, a well-known",
			" open source project, or work from your team). If",
			" not, take a moment to review what's in this folder",
			" first.",
			"",
			" Security guide",
			"",
			" > No, exit",
			"   Yes, I trust this folder",
			"",
			" Enter to confirm · Esc to cancel",
		].join("\n");
		const res = await awaitReady(target, { pollMs: 5, timeoutMs: 30 });
		expect(res).toMatchObject({ alive: true, ready: false });
		const keys = calls.filter((c) => c.includes("send-keys")).map((c) => c[c.length - 1]);
		expect(keys.slice(0, 2)).toEqual(["Down", "Enter"]);
		expect(calls.some((c) => c.includes("-l"))).toBe(false);
	});

	it("confirms an unnumbered non-trust prompt with Enter, and leaves a trust dialog with no cursor alone", async () => {
		stdoutData = " Try the new fullscreen renderer?\n > Yes, try it\n   Not now";
		await awaitReady(target, { pollMs: 5, timeoutMs: 30, enterPauseMs: 0 });
		const keys = calls.filter((c) => c.includes("send-keys")).map((c) => c[c.length - 1]);
		expect(keys.slice(0, 1)).toEqual(["Enter"]);

		calls.length = 0;
		stdoutData = " Is this a project you created or one you trust?\n   No, exit\n   Yes, I trust this folder";
		await awaitReady(target, { pollMs: 5, timeoutMs: 30, enterPauseMs: 0 });
		expect(calls.some((c) => c.includes("send-keys"))).toBe(false);
	});

	it('presses "1" when SGR escapes split the prompt phrase in a real -e capture', async () => {
		// capture-pane -e wraps cells in SGR codes, so the phrase is not contiguous in the raw bytes;
		// awaitReady must strip before matching, or the menu never gets cleared.
		const esc = String.fromCharCode(27);
		stdoutData = `  ${esc}[7m❯ 1.${esc}[0m I am ${esc}[1musing${esc}[0m this for ${esc}[2mlocal${esc}[0m development\n    2. Exit`;
		const res = await awaitReady(target, { pollMs: 5, timeoutMs: 40 });
		expect(res).toMatchObject({ alive: true, ready: false });
		expect(calls).toContainEqual(["tmux", "send-keys", "-t", "=scratch.0", "-l", "--", "1"]);
	});

	it('presses "2" on the large-resumed-session picker to keep the full session, not the summary', async () => {
		stdoutData =
			"This session is 1d 15h old and 189.1k tokens.\n" +
			"Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a summary.\n" +
			"  ❯ 1. Resume from summary (recommended)\n    2. Resume full session as-is\n    3. Don't ask me again";
		const res = await awaitReady(target, { pollMs: 5, timeoutMs: 40 });
		expect(res).toMatchObject({ alive: true, ready: false });
		expect(calls).toContainEqual(["tmux", "send-keys", "-t", "=scratch.0", "-l", "--", "2"]);
		expect(calls.some((c) => c.includes("send-keys") && c.includes("1"))).toBe(false);
	});

	it("answers the picker even when a stale composer shares the frame", async () => {
		// A reattached pane carries the previous incarnation's composer at column 0 while the fresh
		// `claude --resume` draws its picker below. Conceding ready here returns out of the loop, so
		// the picker would sit unanswered for the life of the session.
		stdoutData =
			"\u276f some earlier prompt line\n" +
			"This session is 5h 53m old and 217.1k tokens.\n" +
			"Resuming the full session will consume a substantial portion of your usage limits.\n" +
			"  \u276f 1. Resume from summary (recommended)\n    2. Resume full session as-is";
		const res = await awaitReady(target, { pollMs: 5, timeoutMs: 40 });
		expect(res.ready).toBe(false);
		expect(calls).toContainEqual(["tmux", "send-keys", "-t", "=scratch.0", "-l", "--", "2"]);
	});

	it("reports a dead launch (alive:false) early when the pane never captures", async () => {
		exitCode = 1; // capture-pane always fails: the session exited on launch
		// Budget large enough that the dead-launch early-out (not the deadline) is what returns.
		const res = await awaitReady(target, { pollMs: 2, timeoutMs: 5_000 });
		expect(res).toMatchObject({ alive: false, ready: false });
	});

	it("returns the usage limit early instead of spinning out the budget, pressing no key", async () => {
		// The dialog replaces the composer, so without this the composer check can never succeed and the
		// whole budget burns before reporting a bare not-ready. Budget large enough that a deadline exit
		// would outlast the assertion window.
		stdoutData = [
			"  └   You've hit your weekly limit · resets 5pm",
			"━".repeat(58),
			"   What do you want to do?",
			" ❯ 1. Stop and wait for limit to reset",
			"   2. Switch to usage credits",
		].join("\n");
		const started = Date.now();
		const res = await awaitReady(target, { pollMs: 5, timeoutMs: 5_000 });
		expect(res).toMatchObject({ alive: true, ready: false });
		expect(res.limit?.detail).toBeTruthy();
		expect(Date.now() - started).toBeLessThan(1_000);
		// One of those choices buys usage credits, so answering it would spend the owner's money.
		expect(calls.some((c) => c.includes("send-keys"))).toBe(false);
	});
});

describe("tmuxCore selfSessionTarget", () => {
	const saved = process.env.PROJECT_NAME;
	afterEach(() => {
		if (saved === undefined) delete process.env.PROJECT_NAME;
		else process.env.PROJECT_NAME = saved;
	});

	// BOTH segments come from PROJECT_NAME. `name` was hardcoded "host" here, which this test pinned:
	// a devcontainer session reported itself as the host spawn point. It was inert (the host argv
	// branch never reads `name`) but it was still a lie a later reader would build on.
	it("derives both segments from a composite PROJECT_NAME", () => {
		process.env.PROJECT_NAME = "recipe-app.scratch";
		expect(selfSessionTarget()).toEqual({ kind: "host", name: "recipe-app", sessionName: "scratch" });
	});

	// `kind` stays "host" whatever this process is: for a SELF target it means "the tmux server I can
	// reach directly", and a plugin inside a devcontainer reaches its own tmux with bare `tmux` too.
	it("stays host-kind for a devcontainer session, since a self target is always local tmux", () => {
		process.env.PROJECT_NAME = "recipe-app.scratch";
		expect(selfSessionTarget().kind).toBe("host");
	});

	it("uses the default session for a bare or unset PROJECT_NAME", () => {
		process.env.PROJECT_NAME = "recipe-app";
		expect(selfSessionTarget().sessionName).toBe(DEFAULT_SESSION);
		delete process.env.PROJECT_NAME;
		expect(selfSessionTarget().sessionName).toBe(DEFAULT_SESSION);
	});
});
