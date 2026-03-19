import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	AGENT_TYPES,
	assertNotContainer,
	buildAgentCommand,
	EFFORT_LEVELS,
	ensureContainerUp,
	execInContainer,
	resolveDevcontainerModel,
	resolveProject,
} from "./helpers.js";

////////////////////////////////
//  Schemas

const DevcontainerChatSchema = z.object({
	projectPath: z.string().describe(`Path to the project directory. Absolute or relative to ~/.`),
	prompt: z
		.string()
		.optional()
		.describe(
			`Full markdown prompt to send. Required for new chats and follow-ups. Omit only when polling with jobId.`,
		),
	jobId: z
		.string()
		.optional()
		.describe(
			`Job ID returned when a previous call timed out with status "running". Provide this with projectPath (no prompt) to poll for the result.`,
		),
	sessionId: z
		.string()
		.optional()
		.describe(
			`Session ID returned in a previous response. Pass it back along with a new prompt to continue the same conversation. Omit to start a fresh conversation.`,
		),
	agent: z
		.enum(AGENT_TYPES)
		.describe(
			`Agent CLI to use: claude, cursor, copilot, or codex. Try claude first. If it is not installed in the container, use dispatch_exec to run "which claude cursor copilot codex" to see which are available.`,
		),
	effort: z
		.enum(EFFORT_LEVELS)
		.describe(`Effort level: simple, standard, or complex. Controls which model the agent uses.`),
});
type DevcontainerChatArgs = z.infer<typeof DevcontainerChatSchema>;

////////////////////////////////
//  Interfaces & Types

interface PollJobResult {
	jobId: string;
	status: "completed" | "error" | "running";
	exitCode?: number;
	response?: string;
	stderr?: string;
	hint?: string;
}

////////////////////////////////
//  Functions & Helpers

const SAFE_ID = /^[a-f0-9-]+$/i;
const CHAT_DIR = "/tmp/devcontainer-chat";
const INITIAL_WAIT_MS = 120_000;
const POLL_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;

const description = `
Send a prompt to an agent CLI inside a project's devcontainer.
Automatically starts the container if needed.
Supports claude, cursor, copilot, and codex agents.

Three call patterns:
1. New chat: provide projectPath + prompt + agent + effort. Returns response, sessionId, and jobId.
2. Follow-up: provide projectPath + prompt + agent + effort + sessionId (from a previous response). Continues the same conversation.
3. Poll a running job: provide projectPath + jobId only (no prompt). Checks if the job finished.

The response includes a sessionId. Pass it back with your next prompt to continue the conversation.
If the job takes longer than 2 minutes, status will be "running" with a jobId. Call again with that jobId to check.
`.trim();

async function pollJob(projectPath: string, jobId: string, waitMs: number): Promise<PollJobResult> {
	const exitFile = `${CHAT_DIR}/${jobId}/exit.txt`;
	const responseFile = `${CHAT_DIR}/${jobId}/response.txt`;
	const stderrFile = `${CHAT_DIR}/${jobId}/stderr.txt`;
	const deadline = Date.now() + waitMs;

	while (Date.now() < deadline) {
		try {
			const exitCode = await execInContainer({
				projectPath,
				command: ["bash", "-c", `cat ${exitFile}`],
				timeoutMs: 10_000,
			});

			let response = "";
			try {
				response = await execInContainer({
					projectPath,
					command: ["bash", "-c", `cat ${responseFile}`],
					timeoutMs: 10_000,
				});
			} catch {
				/* empty response */
			}

			let stderr = "";
			try {
				stderr = await execInContainer({
					projectPath,
					command: ["bash", "-c", `cat ${stderrFile}`],
					timeoutMs: 10_000,
				});
			} catch {
				/* no stderr */
			}

			await execInContainer({
				projectPath,
				command: ["bash", "-c", `rm -rf ${CHAT_DIR}/${jobId}`],
				timeoutMs: 10_000,
			}).catch(() => {});

			const code = Number.parseInt(exitCode.trim(), 10);
			if (code !== 0) {
				return { jobId, status: "error", exitCode: code, response, stderr };
			}
			return {
				jobId,
				status: "completed",
				response,
				hint: `To send a follow-up message, call this tool again with projectPath + prompt + sessionId.`,
			};
		} catch {
			// exit file doesn't exist yet, still running
		}

		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}

	return {
		jobId,
		status: "running",
		hint: `The job is still running inside the container. To check again, call this tool with projectPath + jobId (no prompt). You may also let the user know it is still in progress.`,
	};
}

export function registerDevcontainerChat(mcpServer: McpServer): void {
	mcpServer.tool(
		"dispatch_chat",
		description,
		// biome-ignore lint/suspicious/noExplicitAny: zod v4 / MCP SDK type compat
		DevcontainerChatSchema.shape as any,
		async (rawArgs: Record<string, unknown>) => {
			try {
				const args: DevcontainerChatArgs = DevcontainerChatSchema.parse(rawArgs);
				assertNotContainer();
				const projectPath = resolveProject(args.projectPath);

				ensureContainerUp(projectPath);

				// Poll mode: check on existing job
				if (args.jobId) {
					if (!SAFE_ID.test(args.jobId)) throw new Error(`Invalid jobId.`);
					const result = await pollJob(projectPath, args.jobId, POLL_WAIT_MS);
					return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
				}

				// Start mode: launch new job
				if (!args.prompt) {
					throw new Error(`Provide either prompt (start new job) or jobId (poll existing job).`);
				}

				const model = resolveDevcontainerModel(args.agent, args.effort);

				const jobId = crypto.randomUUID();
				const sessionId = args.sessionId || crypto.randomUUID();
				const isFollowUp = !!args.sessionId;

				if (isFollowUp && !SAFE_ID.test(sessionId)) {
					throw new Error(`Invalid sessionId format.`);
				}

				// Write prompt into container /tmp via stdin pipe
				const writeCmd = `mkdir -p ${CHAT_DIR}/${jobId} && cat > ${CHAT_DIR}/${jobId}/prompt.md`;
				await execInContainer({
					projectPath,
					command: ["bash", "-c", writeCmd],
					timeoutMs: 30_000,
					stdin: args.prompt,
				});

				// Build the agent-specific command and write runner script
				const agentCmd = buildAgentCommand({
					agent: args.agent,
					model,
					sessionId,
					isFollowUp,
					promptFile: `${CHAT_DIR}/${jobId}/prompt.md`,
					responseFile: `${CHAT_DIR}/${jobId}/response.txt`,
					stderrFile: `${CHAT_DIR}/${jobId}/stderr.txt`,
				});
				const setupCmd = [
					`cat > ${CHAT_DIR}/${jobId}/run.sh << 'ENDSCRIPT'`,
					"#!/bin/bash",
					agentCmd,
					`echo $? > ${CHAT_DIR}/${jobId}/exit.txt`,
					`rm -f ${CHAT_DIR}/${jobId}/prompt.md`,
					"ENDSCRIPT",
					`chmod +x ${CHAT_DIR}/${jobId}/run.sh`,
					`tmux new-session -d -s 'chat-${jobId}' ${CHAT_DIR}/${jobId}/run.sh`,
				].join("\n");
				await execInContainer({ projectPath, command: ["bash", "-c", setupCmd] });

				// Wait for completion, return early if fast
				const result = await pollJob(projectPath, jobId, INITIAL_WAIT_MS);
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ ...result, sessionId }, null, 2) }],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ errors: [{ message: (error as Error).message }] }, null, 2),
						},
					],
					isError: true,
				};
			}
		},
	);
}
