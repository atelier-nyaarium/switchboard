import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowThreadMapRowSchema, WorkflowTurnRowSchema } from "../gateway/workflows/workflowSchemas.js";
import {
	argvFor,
	type ClaudeRunnerDeps,
	containerKillArgv,
	createClaudeRunner,
} from "../mcp/devcontainer/claudeRunner.js";
import {
	ClaudeTurnAckFrameSchema,
	ClaudeTurnResultFrameSchema,
	HostClaudeCancelOpSchema,
	HostClaudeCancelResultSchema,
	type HostClaudeRunOp,
	HostClaudeRunOpSchema,
	HostClaudeRunReplySchema,
} from "../shared/host-op.js";

const SESSION_ID = "d9428888-122b-4d55-9f9e-4db1a347e901";
const HOST_TARGET = { kind: "host", workdirHint: "/tmp" } as const;
const CONTAINER_TARGET = { kind: "devcontainer", project: "sample", hostProjectPath: "/tmp/sample" } as const;

const pidDirs: string[] = [];
afterEach(() => {
	for (const dir of pidDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function cancelOf(
	overrides: { runId?: string; turnId?: string; target?: typeof HOST_TARGET | typeof CONTAINER_TARGET } = {},
) {
	return {
		kind: "claudeCancel" as const,
		runId: overrides.runId ?? "run-1",
		turnId: overrides.turnId ?? "turn-1",
		target: overrides.target ?? HOST_TARGET,
	};
}

/** Fake timers that run when the test says. */
function manualTimers() {
	const timers: Array<() => void> = [];
	return {
		timers,
		setTimer: ((handler: () => void) => {
			timers.push(handler);
			return 1 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout,
		clearTimer: (() => {}) as typeof clearTimeout,
	};
}

function input(overrides: Partial<HostClaudeRunOp> = {}): HostClaudeRunOp {
	return {
		kind: "claudeRun",
		target: HOST_TARGET,
		runId: "run-1",
		turnId: "turn-1",
		sessionId: SESSION_ID,
		resume: false,
		prompt: "Say hello",
		appendSystemPrompt: null,
		...overrides,
	};
}

type TestChild = ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };

function child(): TestChild {
	return Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		pid: 100,
		kill: () => true,
	}) as unknown as TestChild;
}

function harness(overrides: Partial<ClaudeRunnerDeps> = {}) {
	const children: TestChild[] = [];
	const launches: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
	const sent: ReturnType<typeof ClaudeTurnResultFrameSchema.parse>[] = [];
	const spawnChild: NonNullable<ClaudeRunnerDeps["spawn"]> = (command, args, options) => {
		launches.push({ command, args, options });
		const next = child();
		children.push(next);
		return next;
	};
	const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pids-"));
	pidDirs.push(pidDir);
	const runner = createClaudeRunner({
		send: (frame) => sent.push(frame),
		spawn: spawnChild,
		pidDir,
		env: { PATH: "/fake/bin", HOST_WS_TOKEN: "secret" },
		hasBinary: () => true,
		resolveHostCwd: (hint) => `/resolved${hint.startsWith("/") ? "" : "/"}${hint}`,
		...overrides,
	});
	return { runner, children, launches, sent, pidDir };
}

async function finish(child_: TestChild, stdout: string, stderr = "", code: number | null = 0): Promise<void> {
	child_.stdout.end(stdout);
	child_.stderr.end(stderr);
	await new Promise<void>((resolve) => setImmediate(resolve));
	child_.emit("close", code, null);
}

describe("Claude workflow wire", () => {
	it("round trips host operations, frames and journal rows", () => {
		const run = input({
			jsonSchema: { type: "object", required: ["answer"] },
			appendSystemPrompt: "Project rules",
		});
		expect(HostClaudeRunOpSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run);
		expect(
			HostClaudeCancelOpSchema.parse(JSON.parse(JSON.stringify(cancelOf({ target: CONTAINER_TARGET })))),
		).toEqual(cancelOf({ target: CONTAINER_TARGET }));
		expect(HostClaudeRunOpSchema.safeParse({ ...run, turnId: "../etc" }).success).toBe(false);
		expect(HostClaudeRunReplySchema.parse(JSON.parse(JSON.stringify({ kind: "refused", code: "busy" })))).toEqual({
			kind: "refused",
			code: "busy",
		});
		expect(HostClaudeCancelResultSchema.parse(JSON.parse(JSON.stringify({ cancelled: true })))).toEqual({
			cancelled: true,
		});
		const result = {
			type: "claude_turn_result",
			runId: run.runId,
			turnId: run.turnId,
			sessionId: run.sessionId,
			outcome: "completed",
			answer: { answer: 42 },
			reason: null,
		} as const;
		expect(ClaudeTurnResultFrameSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
		expect(
			ClaudeTurnAckFrameSchema.parse(
				JSON.parse(JSON.stringify({ type: "claude_turn_ack", runId: run.runId, turnId: run.turnId })),
			),
		).toEqual({ type: "claude_turn_ack", runId: run.runId, turnId: run.turnId });
		const turn = {
			kind: "turn",
			issueOrdinal: 1,
			turnOrdinal: 1,
			turnId: run.turnId,
			backend: "claude",
			prompt: run.prompt,
			operationId: null,
			registerInstanceId: "daemon-a",
			agentId: run.sessionId,
			target: "container:sample",
		} as const;
		expect(WorkflowTurnRowSchema.parse(JSON.parse(JSON.stringify(turn)))).toEqual(turn);
		const thread = {
			kind: "thread_map",
			thread: "implementer",
			backend: "claude",
			agentId: run.sessionId,
			target: "container:sample",
			lastIssueOrdinal: 1,
		} as const;
		expect(WorkflowThreadMapRowSchema.parse(JSON.parse(JSON.stringify(thread)))).toEqual(thread);
		expect(WorkflowTurnRowSchema.safeParse({ ...turn, operationId: "op-1" }).success).toBe(false);
	});
});

describe("Claude argv", () => {
	it("builds a host first-turn command with optional rules", () => {
		const command = argvFor(
			input({
				model: "sonnet",
				effort: "high",
				jsonSchema: { type: "object" },
				appendSystemPrompt: "Project instructions",
			}),
		);
		expect(command).toEqual({
			command: "claude",
			args: [
				"-p",
				"--permission-mode",
				"bypassPermissions",
				"--safe-mode",
				"--disable-slash-commands",
				"--output-format",
				"json",
				"--model",
				"sonnet",
				"--effort",
				"high",
				"--json-schema",
				JSON.stringify({ type: "object" }),
				"--append-system-prompt",
				"Project instructions",
				"--session-id",
				SESSION_ID,
			],
		});
	});

	it("builds a container resume without forwarding host environment", () => {
		const command = argvFor(input({ target: CONTAINER_TARGET, resume: true }), {
			PATH: "/host/bin",
			HOST_WS_TOKEN: "secret",
			ANTHROPIC_API_KEY: "secret",
		});
		expect(command.command).toBe("docker");
		expect(command.args).toEqual([
			"exec",
			"-i",
			"-u",
			"vscode",
			"-w",
			"/workspace/sample",
			"sample_devcontainer-dev-1",
			"sh",
			"-c",
			expect.stringContaining("setsid"),
			"sh",
			"/tmp/switchboard-claude-turn-1.pid",
			"turn-1",
			"timeout",
			"--signal=TERM",
			"3600",
			"claude",
			"-p",
			"--permission-mode",
			"bypassPermissions",
			"--safe-mode",
			"--disable-slash-commands",
			"--output-format",
			"json",
			"--resume",
			SESSION_ID,
		]);
	});

	it("spawns host turns in the resolved directory with a scrubbed environment", () => {
		const h = harness();
		expect(h.runner.start(input())).toEqual({ kind: "accepted" });
		expect(h.launches[0]).toMatchObject({
			command: "claude",
			options: {
				cwd: "/resolved/tmp",
				env: { PATH: "/fake/bin", SWITCHBOARD_CLAUDE_TURN: "turn-1" },
				detached: true,
			},
		});
		expect(h.children[0]?.stdin.read()?.toString()).toBe("Say hello");
	});
});

describe("Claude turn results", () => {
	it("prefers structured output and otherwise returns result text", async () => {
		const structured = harness();
		expect(structured.runner.start(input())).toEqual({ kind: "accepted" });
		const structuredChild = structured.children[0];
		if (!structuredChild) throw new Error("missing fake child");
		await finish(
			structuredChild,
			'{"type":"progress","message":"working"}\n{"type":"result","result":"text","structured_output":{"answer":42}}',
		);
		expect(structured.sent[0]).toMatchObject({ outcome: "completed", answer: { answer: 42 }, reason: null });

		const text = harness();
		text.runner.start(input());
		const textChild = text.children[0];
		if (!textChild) throw new Error("missing fake child");
		await finish(textChild, '{"type":"result","result":"hello"}');
		expect(text.sent[0]).toMatchObject({ outcome: "completed", answer: "hello", reason: null });
	});

	it.each([
		["is_error", '{"type":"result","is_error":true,"result":"no"}', "", 0, "claude reported an error"],
		["nonzero exit", '{"type":"result","result":"no"}', "", 3, "claude exited with 3"],
		["unparseable output", "not json", "", 0, "invalid claude output"],
	] as const)("fails on %s", async (_name, stdout, stderr, code, reason) => {
		const h = harness();
		h.runner.start(input());
		const child_ = h.children[0];
		if (!child_) throw new Error("missing fake child");
		await finish(child_, stdout, stderr, code);
		expect(h.sent[0]).toMatchObject({ outcome: "failed", answer: null, reason });
	});

	it("marks a missing resumed conversation", async () => {
		const h = harness();
		h.runner.start(input({ resume: true }));
		const child_ = h.children[0];
		if (!child_) throw new Error("missing fake child");
		await finish(child_, '{"type":"result","is_error":true,"result":"No conversation found"}', "", 1);
		expect(h.sent[0]).toMatchObject({ outcome: "sessionMissing", answer: null, reason: "No conversation found" });
	});

	it("returns a short stderr classification", async () => {
		const h = harness();
		h.runner.start(input());
		const child_ = h.children[0];
		if (!child_) throw new Error("missing fake child");
		await finish(child_, '{"type":"result","is_error":true}', "authentication failed at /private/token.txt", 1);
		expect(h.sent[0]).toMatchObject({ outcome: "failed", answer: null, reason: "authFailed" });
		expect(h.sent[0]?.reason).not.toContain("/private/token.txt");
	});
});

describe("Claude runner lifecycle", () => {
	it("answers the ninth active turn as busy", () => {
		const h = harness();
		for (let index = 0; index < 8; index += 1) {
			expect(h.runner.start(input({ runId: `run-${index}`, turnId: `turn-${index}` }))).toEqual({
				kind: "accepted",
			});
		}
		expect(h.runner.start(input({ runId: "run-9", turnId: "turn-9" }))).toEqual({ kind: "refused", code: "busy" });
		expect(h.launches).toHaveLength(8);
	});

	it("replays unacked results on register and drops them after ack", async () => {
		const h = harness();
		h.runner.start(input());
		const child_ = h.children[0];
		if (!child_) throw new Error("missing fake child");
		await finish(child_, '{"type":"result","result":"done"}');
		h.runner.replay();
		expect(h.sent).toHaveLength(2);
		h.runner.acknowledge({ runId: "run-1", turnId: "turn-1" });
		h.runner.replay();
		expect(h.sent).toHaveLength(2);
	});

	it("sends TERM then KILL on cancel, and keeps a host pidfile only while the turn runs", async () => {
		const signals: NodeJS.Signals[] = [];
		const clock = manualTimers();
		const h = harness({ signalGroup: (_child, signal) => signals.push(signal), ...clock });
		h.runner.start(input());
		const pidfile = path.join(h.pidDir, "turn-1.pid");
		expect(fs.readFileSync(pidfile, "utf8")).toBe("100");

		expect(await h.runner.cancel(cancelOf())).toEqual({ cancelled: true });
		expect(signals).toEqual(["SIGTERM"]);
		clock.timers[0]?.();
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		h.children[0]?.emit("close", null, "SIGKILL");
		expect(h.sent[0]).toMatchObject({ outcome: "cancelled", answer: null });
		expect(fs.existsSync(pidfile)).toBe(false);
	});

	it("cancels a host orphan through its pidfile only when the process carries that turn", async () => {
		const killed: Array<[number, NodeJS.Signals]> = [];
		const clock = manualTimers();
		// A later turn of the same resumed session reusing the pid carries its own turn id.
		let environ = ["PATH=/bin", "SWITCHBOARD_CLAUDE_TURN=turn-9"];
		const h = harness({
			environOf: () => environ,
			killGroup: (pid, signal) => {
				killed.push([pid, signal]);
				return true;
			},
			...clock,
		});
		fs.writeFileSync(path.join(h.pidDir, "turn-9.pid"), "4242");

		expect(await h.runner.cancel(cancelOf({ turnId: "turn-9" }))).toEqual({ cancelled: true });
		clock.timers[0]?.();
		environ = ["PATH=/bin", "SWITCHBOARD_CLAUDE_TURN=turn-10"];
		expect(await h.runner.cancel(cancelOf({ turnId: "turn-9" }))).toEqual({ cancelled: false });
		expect(await h.runner.cancel(cancelOf({ turnId: "turn-missing" }))).toEqual({ cancelled: false });

		expect(killed).toEqual([
			[4242, "SIGTERM"],
			[4242, "SIGKILL"],
		]);
	});

	it("signals a container turn inside the container, where the client's death never reaches", async () => {
		const clock = manualTimers();
		const h = harness(clock);
		h.runner.start(input({ target: CONTAINER_TARGET }));
		const run = h.children[0];
		let clientKilled: NodeJS.Signals | undefined;
		if (run)
			run.kill = ((signal: NodeJS.Signals) => {
				clientKilled = signal;
				return true;
			}) as TestChild["kill"];

		// The kill exec's exit decides the answer, so the test closes each one.
		const closeLatest = async (code: number) => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			h.children.at(-1)?.emit("close", code);
		};
		const notYet = h.runner.cancel(cancelOf({ target: CONTAINER_TARGET }));
		await closeLatest(3);
		await expect(notYet).rejects.toThrow();
		const failed = h.runner.cancel(cancelOf({ target: CONTAINER_TARGET }));
		await closeLatest(125);
		await expect(failed).rejects.toThrow();
		const signaled = h.runner.cancel(cancelOf({ target: CONTAINER_TARGET }));
		await closeLatest(0);
		expect(await signaled).toEqual({ cancelled: true });
		clock.timers[0]?.();
		expect(h.launches.slice(1).map((launch) => launch.args)).toEqual([
			containerKillArgv(CONTAINER_TARGET, "turn-1", "TERM"),
			containerKillArgv(CONTAINER_TARGET, "turn-1", "TERM"),
			containerKillArgv(CONTAINER_TARGET, "turn-1", "TERM"),
			containerKillArgv(CONTAINER_TARGET, "turn-1", "KILL"),
		]);
		expect(clientKilled).toBe("SIGKILL");

		const orphan = h.runner.cancel(cancelOf({ target: CONTAINER_TARGET, turnId: "turn-7" }));
		await closeLatest(0);
		expect(await orphan).toEqual({ cancelled: true });
		const gone = h.runner.cancel(cancelOf({ target: CONTAINER_TARGET, turnId: "turn-8" }));
		await closeLatest(3);
		expect(await gone).toEqual({ cancelled: false });
	});

	it("kills active turns when the daemon stops", () => {
		const signals: NodeJS.Signals[] = [];
		const h = harness({ signalGroup: (_child, signal) => signals.push(signal) });
		h.runner.start(input());

		h.runner.stop();

		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("refuses a host turn when Claude is missing", () => {
		const h = harness({ hasBinary: () => false });
		expect(h.runner.start(input())).toEqual({ kind: "refused", code: "binaryMissing" });
		expect(h.launches).toHaveLength(0);
	});
});
