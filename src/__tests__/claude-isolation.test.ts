import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeRunner } from "../mcp/devcontainer/claudeRunner.js";
import { isBinaryOnPath } from "../shared/agent-binary.js";
import type { ClaudeTurnResultFrame } from "../shared/host-op.js";

function parseJsonLines(value: string): Record<string, unknown>[] {
	return value.split(/\r?\n/).flatMap((line) => {
		try {
			const parsed: unknown = JSON.parse(line);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? [parsed as Record<string, unknown>]
				: [];
		} catch {
			return [];
		}
	});
}

// A real model call on the owner's login, so it runs only when asked: SWITCHBOARD_CLAUDE_LIVE=1.
const LIVE = process.env.SWITCHBOARD_CLAUDE_LIVE === "1" && isBinaryOnPath("claude");

describe.skipIf(!LIVE)("Claude workflow isolation", () => {
	it("reads AGENTS.md when told to, without project hooks, plugins or MCP servers", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-claude-isolation-"));
		const project = path.join(root, "project");
		const marker = path.join(root, "hook-ran");
		const hook = path.join(root, "session-start.cjs");
		fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(project, "AGENTS.md"), "The canary word is AGENTS_CANARY.\n");
		fs.writeFileSync(path.join(project, "CLAUDE.md"), "The canary word is CLAUDE_CANARY.\n");
		fs.writeFileSync(hook, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
		fs.writeFileSync(
			path.join(project, ".claude", "settings.json"),
			JSON.stringify({
				enabledPlugins: { "isolation-probe@fixture-marketplace": true },
				hooks: {
					SessionStart: [
						{
							matcher: "startup",
							hooks: [
								{
									type: "command",
									command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`,
								},
							],
						},
					],
				},
			}),
		);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let resolveResult!: (frame: ClaudeTurnResultFrame) => void;
		const result = new Promise<ClaudeTurnResultFrame>((resolve) => (resolveResult = resolve));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const runner = createClaudeRunner({
			env: process.env,
			hasBinary: (name) => isBinaryOnPath(name),
			resolveHostCwd: (hint) => path.resolve(hint),
			spawn: (command, args, options) => {
				const streamArgs = [...args];
				const format = streamArgs.indexOf("--output-format");
				if (format >= 0) {
					streamArgs[format + 1] = "stream-json";
					streamArgs.push("--verbose");
				}
				const child = nodeSpawn(command, streamArgs, options);
				child.stdout?.on("data", (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
				child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
				return child;
			},
			send: resolveResult,
		});
		try {
			const started = runner.start({
				kind: "claudeRun",
				target: { kind: "host", workdirHint: project },
				runId: randomUUID(),
				turnId: "isolation-turn",
				sessionId: randomUUID(),
				resume: false,
				prompt: "Read AGENTS.md first.\n\nReply with the canary word from your instructions and nothing else.",
				appendSystemPrompt: null,
				jsonSchema: {
					type: "object",
					properties: { canary: { type: "string" } },
					required: ["canary"],
					additionalProperties: false,
				},
			});
			expect(started).toEqual({ kind: "accepted" });
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Claude isolation run timed out")), 110_000);
			});
			const frame = await Promise.race([result, timeout]);
			const cliOutput = `${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`;
			expect(frame.outcome, `${frame.reason ?? ""}\n${cliOutput}`).toBe("completed");
			expect(frame.answer).toEqual({ canary: "AGENTS_CANARY" });
			const objects = parseJsonLines(Buffer.concat(stdout).toString("utf8"));
			const init = objects.find((entry) => entry.type === "system" && entry.subtype === "init");
			expect(init?.skills).toEqual([]);
			expect(init?.mcp_servers).toEqual([]);
			expect(fs.existsSync(marker)).toBe(false);
		} finally {
			if (timer) clearTimeout(timer);
			runner.stop();
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);
});
