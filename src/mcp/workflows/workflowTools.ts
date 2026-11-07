import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requestHead } from "../agentRequest.js";
import { routerPost } from "../bridge/helpers.js";

export const WORKFLOW_START_DESCRIPTION = `
# Start a Switchboard Workflow

This is Switchboard's own Workflow. It runs steps on other providers' CLIs (Codex, Copilot, and \`claude -p\`). Use it over built-in Workflow when a step needs GPT or another model family.

\`parallel\`, \`pipeline\`, \`phase\`, \`log\`, \`args\`, and \`label\` work as in Workflow.

\`agent()\` options that differ:
\`\`\`js
agent(prompt, {
  backend,  // "codex" | "copilot" | "claude"; defaults to the run's
  model,    // that backend's model id
  effort,   // Copilot and claude only
  tier,     // Codex only: "priority" or "standard"
  thread,   // reuse one agent for every call naming this key
  skills,   // skill file paths prepended to the prompt
  schema,   // JSON Schema; the answer is validated, null on failure
})
\`\`\`

Provide exactly one of \`script\` or \`scriptPath\`; paths are read from the session's working directory. Full reference: \`switchboard_capabilities\`.
`.trim();

export const WORKFLOW_COLLECT_DESCRIPTION = `Collect by runId; waits up to 240 seconds.`;
export const WORKFLOW_LIST_DESCRIPTION = `List this session's workflows.`;
export const WORKFLOW_STOP_DESCRIPTION = `Cancel by runId.`;

const StartInputSchema = z
	.object({
		script: z.string().optional(),
		scriptPath: z.string().min(1).optional(),
		args: z.record(z.string(), z.unknown()).optional(),
		backend: z.enum(["codex", "copilot", "claude"]).optional(),
		resumeFrom: z.string().min(1).nullable().optional(),
	})
	.strict();
const RunInputSchema = z.object({ runId: z.string().min(1) }).strict();
const EmptyInputSchema = z.object({}).strict();

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK schema compatibility
const startInputSchema: any = StartInputSchema;
// biome-ignore lint/suspicious/noExplicitAny: MCP SDK schema compatibility
const runInputSchema: any = RunInputSchema;
// biome-ignore lint/suspicious/noExplicitAny: MCP SDK schema compatibility
const emptyInputSchema: any = EmptyInputSchema;

type ToolAnswer = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function answer(text: string, isError = false): ToolAnswer {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

async function post(pathname: string, payload: Record<string, unknown>): Promise<ToolAnswer> {
	try {
		const result = await routerPost(pathname, payload);
		return answer(JSON.stringify(result, null, 2));
	} catch (error) {
		return answer(`Workflow request failed: ${(error as Error).message}`, true);
	}
}

export function registerWorkflowTools(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"workflowStart",
		{ title: "Start Workflow", description: WORKFLOW_START_DESCRIPTION, inputSchema: startInputSchema },
		async ({
			script: inlineScript,
			scriptPath,
			args = {},
			backend = "codex",
			resumeFrom = null,
		}: {
			script?: string;
			scriptPath?: string;
			args?: Record<string, unknown>;
			backend?: "codex" | "copilot" | "claude";
			resumeFrom?: string | null;
		}) => {
			if ((inlineScript === undefined) === (scriptPath === undefined)) {
				return answer("Provide exactly one of script or scriptPath.", true);
			}
			let script: string;
			try {
				script = inlineScript ?? fs.readFileSync(path.resolve(process.cwd(), scriptPath ?? ""), "utf8");
			} catch (error) {
				return answer(`Could not read workflow script: ${(error as Error).message}`, true);
			}
			const { operationId } = requestHead("start");
			return post("/workflow/start", {
				operationId,
				script,
				args,
				backend,
				resumeFrom,
			});
		},
	);
	mcpServer.registerTool(
		"workflowCollect",
		{ title: "Collect Workflow", description: WORKFLOW_COLLECT_DESCRIPTION, inputSchema: runInputSchema },
		async ({ runId }: { runId: string }) => post("/workflow/collect", { runId }),
	);
	mcpServer.registerTool(
		"workflowList",
		{ title: "List Workflows", description: WORKFLOW_LIST_DESCRIPTION, inputSchema: emptyInputSchema },
		async () => post("/workflow/list", {}),
	);
	mcpServer.registerTool(
		"workflowStop",
		{ title: "Stop Workflow", description: WORKFLOW_STOP_DESCRIPTION, inputSchema: runInputSchema },
		async ({ runId }: { runId: string }) => post("/workflow/stop", { runId }),
	);
}
