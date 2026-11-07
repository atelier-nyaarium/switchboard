import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowThreadMapRowSchema, WorkflowTurnRowSchema } from "../gateway/workflows/workflowSchemas.js";
import { argvFor, type ClaudeRunnerDeps, createClaudeRunner } from "../mcp/devcontainer/claudeRunner.js";
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

/** Controlled fake timers. */
function manualTimers() {
	const pending = new Map<number, { run: () => void; ms: number }>();
	let nextId = 1;
	const take = (ms: number) => {
		const entry = [...pending].find(([, timer]) => timer.ms === ms);
		if (!entry) return;
		pending.delete(entry[0]);
		entry[1].run();
	};
	return {
		/** Pending retry timers. */
		get timers() {
			return [...pending.values()].filter((timer) => timer.ms === 5_000);
		},
		fire: () => take(5_000),
		fireHung: () => take(10_000),
		setTimer: ((handler: () => void, ms: number) => {
			const id = nextId++;
			pending.set(id, { run: handler, ms });
			return id as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout,
		clearTimer: ((id: number) => pending.delete(id)) as unknown as typeof clearTimeout,
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
	const emitter = new EventEmitter();
	return Object.assign(emitter, {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		pid: 100,
		kill: (signal?: NodeJS.Signals) => {
			setImmediate(() => emitter.emit("close", null, signal ?? "SIGTERM"));
			return true;
		},
	}) as unknown as TestChild;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

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

		expect(await h.runner.cancel(cancelOf())).toEqual({ cancelled: false });
		expect(signals).toEqual(["SIGTERM"]);
		expect(await h.runner.cancel(cancelOf())).toEqual({ cancelled: false });
		clock.fire();
		await settle();
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		h.children[0]?.emit("close", null, "SIGKILL");
		expect(h.sent[0]).toMatchObject({ outcome: "cancelled", answer: null });
		expect(fs.existsSync(pidfile)).toBe(false);
		expect(await h.runner.cancel(cancelOf())).toEqual({ cancelled: true });
	});

	it("cancels a host orphan through its pidfile only when the process carries that turn", async () => {
		const killed: Array<[number, NodeJS.Signals]> = [];
		const clock = manualTimers();
		let environ = ["PATH=/bin", "SWITCHBOARD_CLAUDE_TURN=turn-9"];
		const h = harness({
			environOf: () => environ,
			killGroup: (pid, signal) => {
				killed.push([pid, signal]);
				return true;
			},
			...clock,
		});
		const pidfile = path.join(h.pidDir, "turn-9.pid");
		fs.writeFileSync(pidfile, "4242");

		expect(await h.runner.cancel(cancelOf({ turnId: "turn-9" }))).toEqual({ cancelled: false });
		clock.fire();
		await settle();
		expect(fs.existsSync(pidfile)).toBe(false);
		expect(await h.runner.cancel(cancelOf({ turnId: "turn-9" }))).toEqual({ cancelled: true });

		// Reused pid, new turn.
		fs.writeFileSync(path.join(h.pidDir, "turn-5.pid"), "4242");
		environ = ["PATH=/bin", "SWITCHBOARD_CLAUDE_TURN=turn-10"];
		await h.runner.cancel(cancelOf({ turnId: "turn-5" }));
		await h.runner.cancel(cancelOf({ turnId: "turn-missing" }));
		await settle();

		expect(killed).toEqual([
			[4242, "SIGTERM"],
			[4242, "SIGKILL"],
		]);
		expect(clock.timers).toHaveLength(0);
	});

	it("retries container cancellation", async () => {
		const clock = manualTimers();
		const h = harness(clock);
		h.runner.start(input({ target: CONTAINER_TARGET }));
		const answer = async (code: number) => {
			await settle();
			h.children.at(-1)?.emit("close", code);
			await settle();
		};

		expect(await h.runner.cancel(cancelOf({ target: CONTAINER_TARGET }))).toEqual({ cancelled: false });
		await answer(4);
		clock.fire();
		await answer(125);
		clock.fire();
		await answer(0);
		clock.fire();
		await answer(0);
		await settle();
		expect(h.launches.slice(1).map((launch) => launch.args.at(-1))).toEqual(["TERM", "TERM", "TERM", "KILL"]);
		expect(h.sent[0]).toMatchObject({ outcome: "cancelled" });
		expect(clock.timers).toHaveLength(0);
		expect(await h.runner.cancel(cancelOf({ target: CONTAINER_TARGET }))).toEqual({ cancelled: true });

		await h.runner.cancel(cancelOf({ target: CONTAINER_TARGET, turnId: "turn-8" }));
		await answer(4);
		while (clock.timers.length > 0) {
			clock.fire();
			await answer(4);
		}
		const late = h.launches.filter((launch) => launch.args.includes("/tmp/switchboard-claude-turn-8.pid"));
		expect(late).toHaveLength(7);
	});

	it("bounds a hung container kill and retries it", async () => {
		const clock = manualTimers();
		const h = harness(clock);
		await h.runner.cancel(cancelOf({ target: CONTAINER_TARGET, turnId: "turn-3" }));
		clock.fireHung();
		await settle();
		clock.fire();
		await settle();
		h.children.at(-1)?.emit("close", 3);
		await settle();
		expect(h.launches).toHaveLength(2);
		expect(await h.runner.cancel(cancelOf({ target: CONTAINER_TARGET, turnId: "turn-3" }))).toEqual({
			cancelled: true,
		});
	});

	it("stops and fails a host turn whose pidfile cannot be written, since no restart could cancel it", async () => {
		const signals: NodeJS.Signals[] = [];
		const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claude-pids-")), "not-a-dir");
		pidDirs.push(path.dirname(blocked));
		fs.writeFileSync(blocked, "");
		const h = harness({ pidDir: blocked, signalGroup: (_child, signal) => signals.push(signal) });

		expect(h.runner.start(input())).toEqual({ kind: "accepted" });
		expect(signals).toEqual(["SIGKILL"]);
		h.children[0]?.emit("close", null, "SIGKILL");
		expect(h.sent[0]).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/could not be recorded/) });
	});

	it("fails a container turn whose wrapper could not write its pidfile and stopped it", async () => {
		const h = harness();
		h.runner.start(input({ target: CONTAINER_TARGET }));
		const run = h.children[0];
		if (!run) throw new Error("missing fake child");
		await finish(run, "", "", 97);
		expect(h.sent[0]).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/could not be recorded/) });
	});

	it("retries failed container KILL", async () => {
		const clock = manualTimers();
		const h = harness(clock);
		h.runner.start(input({ target: CONTAINER_TARGET }));
		const answer = async (code: number) => {
			await settle();
			h.children.at(-1)?.emit("close", code);
			await settle();
		};
		await h.runner.cancel(cancelOf({ target: CONTAINER_TARGET }));
		await answer(0);

		clock.fire();
		await answer(125);
		await settle();
		expect(h.sent[0]).toMatchObject({ outcome: "cancelled" });
		clock.fire();
		await answer(0);

		const kills = h.launches.filter((launch) => launch.args.at(-1) === "KILL");
		expect(kills).toHaveLength(2);
		expect(clock.timers).toHaveLength(0);
	});

	it("kills active turns when the daemon stops", () => {
		const signals: NodeJS.Signals[] = [];
		const h = harness({ signalGroup: (_child, signal) => signals.push(signal) });
		h.runner.start(input());

		h.runner.stop();

		expect(signals).toEqual(["SIGKILL"]);
	});

	it("reports missing container CLI", async () => {
		const h = harness();
		h.runner.start(input({ target: CONTAINER_TARGET }));
		const run = h.children[0];
		if (!run) throw new Error("missing fake child");
		await finish(run, "", "timeout: failed to run command 'claude': No such file or directory", 127);
		expect(h.sent[0]).toMatchObject({ outcome: "failed", reason: "binaryMissing" });
	});

	it("refuses a host turn when Claude is missing", () => {
		const h = harness({ hasBinary: () => false });
		expect(h.runner.start(input())).toEqual({ kind: "refused", code: "binaryMissing" });
		expect(h.launches).toHaveLength(0);
	});
});
