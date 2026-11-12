import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type AgentBackendId, WORKFLOW_BACKEND_IDS } from "../../shared/agent-backend.js";
import { requestHead } from "../agentRequest.js";
import { routerPost } from "../bridge/helpers.js";

export const WORKFLOW_START_DESCRIPTION = `
# Start a Switchboard Workflow

This is Switchboard's own Workflow. It runs steps on other providers' CLIs (OpenCode, Codex, Copilot, and \`claude -p\`). Use it over built-in Workflow when a step needs GPT or another model family.

The script starts with \`export const meta = {...}\`, a pure literal, as in Workflow. \`parallel\`, \`pipeline\`, \`phase\`, \`log\`, \`args\`, and \`label\` work as in Workflow.

\`agent()\` options that differ:
\`\`\`js
agent(prompt, {
  backend,  // "opencode" | "codex" | "copilot" | "claude"; defaults to the run's
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

export const WORKFLOW_COLLECT_DESCRIPTION = `
# Collect Workflow

Answers at once; a running run settles later with a notice naming this tool.

- Running: step outcomes.
- Settled: the script's \`result\`, or each step's answer when there is none.

A collected run leaves \`workflowList\`. Collect by \`runId\` again for a week.
`.trim();
export const WORKFLOW_LIST_DESCRIPTION = `
# List Workflows

Running and uncollected runs, newest first: id, meta name, status, times, step counts. No results.
`.trim();
export const WORKFLOW_STOP_DESCRIPTION = `Cancel by runId.`;

type WorkflowBackendId = (typeof WORKFLOW_BACKEND_IDS)[number];

const RunInputSchema = z.object({ runId: z.string().min(1) }).strict();
const ListInputSchema = z
	.object({
		limit: z.number().int().positive().max(50).optional().describe(`Maximum runs to return. Default 20.`),
		status: z.enum(["running", "succeeded", "failed", "cancelled"]).optional(),
	})
	.strict();

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK schema compatibility
const runInputSchema: any = RunInputSchema;
// biome-ignore lint/suspicious/noExplicitAny: MCP SDK schema compatibility
const listInputSchema: any = ListInputSchema;

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

/** `agentBackends`: the agent backends this session has enabled. A step also runs on Claude. */
export function registerWorkflowTools(mcpServer: McpServer, agentBackends: readonly AgentBackendId[]): void {
	const [first, ...rest] = WORKFLOW_BACKEND_IDS.filter(
		(id): id is WorkflowBackendId => id === "claude" || agentBackends.includes(id),
	);
	if (first === undefined) return;
	const enabled = [first, ...rest];
	// Caller selects among backends.
	const sole = rest.length === 0 ? first : undefined;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK schema compatibility
	const startInputSchema: any = z
		.object({
			script: z.string().optional(),
			scriptPath: z.string().min(1).optional(),
			args: z.record(z.string(), z.unknown()).optional(),
			backend: z
				.enum([first, ...rest])
				.optional()
				.describe(`Sets the run's backend. If more than one is installed, you must specify which.`),
			resumeFrom: z.string().min(1).nullable().optional(),
		})
		.strict();

	mcpServer.registerTool(
		"workflowStart",
		{ title: "Start Workflow", description: WORKFLOW_START_DESCRIPTION, inputSchema: startInputSchema },
		async ({
			script: inlineScript,
			scriptPath,
			args = {},
			backend = sole,
			resumeFrom = null,
		}: {
			script?: string;
			scriptPath?: string;
			args?: Record<string, unknown>;
			backend?: WorkflowBackendId;
			resumeFrom?: string | null;
		}) => {
			if (!backend) return answer(`Specify \`backend\`: ${enabled.join(", ")}`, true);
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
		{ title: "List Workflows", description: WORKFLOW_LIST_DESCRIPTION, inputSchema: listInputSchema },
		async (args: { limit?: number; status?: string }) => post("/workflow/list", args),
	);
	mcpServer.registerTool(
		"workflowStop",
		{ title: "Stop Workflow", description: WORKFLOW_STOP_DESCRIPTION, inputSchema: runInputSchema },
		async ({ runId }: { runId: string }) => post("/workflow/stop", { runId }),
	);
}
