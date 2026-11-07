import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGENT_BACKENDS, type AgentBackendId } from "../../shared/agent-backend.js";
import { AgentOutputSchemaSchema } from "../../shared/agent-record.js";
import {
	CODEX_AGENT_ID_RE,
	CodexListAgentsInputSchema,
	CodexMessageAgentInputSchema,
	CodexServiceTierSchema,
	CodexStartAgentInputSchema,
} from "../../shared/codex-agent.js";
import {
	COPILOT_AGENT_ID_RE,
	CopilotMessageAgentInputSchema,
	CopilotStartAgentInputSchema,
} from "../../shared/copilot-agent.js";
import type { AgentDispatch } from "../agentDispatch.js";
import { postAgentRequest } from "../agentRequest.js";
import { codexRequestBody } from "../codex/codexTools.js";
import { copilotRequestBody } from "../copilot/copilotTools.js";

export type AgentDispatches = Partial<Record<AgentBackendId, AgentDispatch>>;

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const AgentIdSchema = z
	.string()
	.refine((id) => CODEX_AGENT_ID_RE.test(id) || COPILOT_AGENT_ID_RE.test(id), "not an agent id");

const START_DESCRIPTION = `
# Start Agent

Start an agent for a self-contained task.

\`backend\` selects an enabled backend and defaults to the first enabled one. \`effort\` is Copilot only; \`tier\` is Codex only. \`schema\` constrains the final answer; validate it yourself. Set \`model\` and \`cwd\` at start.

Returns when the agent accepts the turn. Call \`agentCollect\` after its completion notice. Running agents send progress notices every 10 minutes.

Agents have full access. State allowed writes, network access, and completion criteria in the prompt. See \`switchboard_capabilities\` for backend notes.
`.trim();

const MESSAGE_DESCRIPTION = `
# Message Agent

Send a follow-up prompt. Running turns are steered; idle agents start a new turn.

The agent keeps its history. Repeat any guardrails that still apply. Codex \`tier\` and \`schema\` apply to the next new turn.

Returns when the agent accepts the message. Call \`agentCollect\` after its completion notice.
`.trim();

const COLLECT_DESCRIPTION = `
# Collect Agent

Return an agent's turn outcome. Call after a completion notice. Waits for a running turn; with none running, returns the latest settled state.
`.trim();

const STOP_DESCRIPTION = `
# Stop Agent

Interrupt the current turn. Returns once the request is durable; the outcome arrives later. The agent remains usable with \`agentMessage\`. Started background processes keep running.
`.trim();

const LIST_DESCRIPTION = `
# List Agents

List agents managed by this session.

- \`backend\` limits the list to one family.
- \`agentId\` returns that one agent.
- \`detail\` and \`limit\` apply to Codex.

Use \`agentId\` with \`agentMessage\` to continue existing work.
`.trim();

function refused(text: string): ToolText {
	return { content: [{ type: "text", text }], isError: true };
}

function backendOf(agentId: string): AgentBackendId {
	return CODEX_AGENT_ID_RE.test(agentId) ? "codex" : "copilot";
}

function descriptor(id: AgentBackendId) {
	const found = AGENT_BACKENDS.find((backend) => backend.id === id);
	if (!found) throw new Error(`unknown agent backend ${id}`);
	return found;
}

function issues(error: z.ZodError): string {
	return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

interface StartArgs {
	prompt: string;
	backend?: AgentBackendId;
	model?: string;
	effort?: string;
	tier?: z.infer<typeof CodexServiceTierSchema>;
	schema?: Record<string, unknown>;
	cwd?: string;
}

export function startBody(backend: AgentBackendId, args: StartArgs): Record<string, unknown> | string {
	const common = {
		prompt: args.prompt,
		...(args.model === undefined ? {} : { model: args.model }),
		...(args.cwd === undefined ? {} : { cwd: args.cwd }),
		...(args.schema === undefined ? {} : { outputSchema: args.schema }),
	};
	if (backend === "codex") {
		if (args.effort !== undefined) return "`effort` is not a Codex option";
		const input = { ...common, ...(args.tier === undefined ? {} : { serviceTier: args.tier }) };
		const checked = CodexStartAgentInputSchema.safeParse(input);
		return checked.success ? codexRequestBody("start", checked.data) : issues(checked.error);
	}
	if (args.tier !== undefined) return "`tier` is not a Copilot option";
	const input = { ...common, ...(args.effort === undefined ? {} : { reasoningEffort: args.effort }) };
	const checked = CopilotStartAgentInputSchema.safeParse(input);
	return checked.success ? copilotRequestBody("start", checked.data) : issues(checked.error);
}

interface MessageArgs {
	agentId: string;
	prompt: string;
	tier?: z.infer<typeof CodexServiceTierSchema>;
	schema?: Record<string, unknown>;
}

export function messageBody(args: MessageArgs): Record<string, unknown> | string {
	const common = {
		agentId: args.agentId,
		prompt: args.prompt,
		...(args.schema === undefined ? {} : { outputSchema: args.schema }),
	};
	if (backendOf(args.agentId) === "codex") {
		const input = { ...common, ...(args.tier === undefined ? {} : { serviceTier: args.tier }) };
		const checked = CodexMessageAgentInputSchema.safeParse(input);
		return checked.success ? codexRequestBody("message", checked.data) : issues(checked.error);
	}
	if (args.tier !== undefined) return "`tier` is not a Copilot option";
	const checked = CopilotMessageAgentInputSchema.safeParse(common);
	return checked.success ? copilotRequestBody("message", checked.data) : issues(checked.error);
}

function idBody(kind: "await" | "stop", agentId: string): Record<string, unknown> {
	return backendOf(agentId) === "codex" ? codexRequestBody(kind, { agentId }) : copilotRequestBody(kind, { agentId });
}

/** Registers enabled agent tools. */
export function registerAgentTools(mcpServer: McpServer, dispatches: AgentDispatches): void {
	const enabled = AGENT_BACKENDS.map((backend) => backend.id).filter((id) => dispatches[id] !== undefined);
	const [first, ...rest] = enabled;
	if (first === undefined) return;
	const BackendSchema = z.enum([first, ...rest]);

	const send = (backend: AgentBackendId, body: Record<string, unknown> | string): Promise<ToolText> => {
		const dispatch = dispatches[backend];
		if (!dispatch) return Promise.resolve(refused(`${descriptor(backend).displayName} agents are not enabled`));
		if (typeof body === "string") return Promise.resolve(refused(body));
		return postAgentRequest(descriptor(backend), dispatch, body);
	};

	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const startSchema: any = z
		.object({
			prompt: z.string(),
			backend: BackendSchema.optional(),
			model: z.string().optional(),
			effort: z.string().optional(),
			tier: CodexServiceTierSchema.optional(),
			schema: AgentOutputSchemaSchema.optional(),
			cwd: z.string().optional(),
		})
		.strict();
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const messageSchema: any = z
		.object({
			agentId: AgentIdSchema,
			prompt: z.string(),
			tier: CodexServiceTierSchema.optional(),
			schema: AgentOutputSchemaSchema.optional(),
		})
		.strict();
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const idSchema: any = z.object({ agentId: AgentIdSchema }).strict();
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const listSchema: any = z
		.object({
			backend: BackendSchema.optional(),
			agentId: AgentIdSchema.optional(),
			detail: CodexListAgentsInputSchema.shape.detail,
			limit: CodexListAgentsInputSchema.shape.limit,
		})
		.strict();

	mcpServer.registerTool(
		"agentStart",
		{ title: `Start Agent`, description: START_DESCRIPTION, inputSchema: startSchema },
		async (args: StartArgs) => {
			const backend = args.backend ?? first;
			return send(backend, startBody(backend, args));
		},
	);

	mcpServer.registerTool(
		"agentMessage",
		{ title: `Message Agent`, description: MESSAGE_DESCRIPTION, inputSchema: messageSchema },
		async (args: MessageArgs) => send(backendOf(args.agentId), messageBody(args)),
	);

	mcpServer.registerTool(
		"agentCollect",
		{ title: `Collect Agent`, description: COLLECT_DESCRIPTION, inputSchema: idSchema },
		async (args: { agentId: string }) => send(backendOf(args.agentId), idBody("await", args.agentId)),
	);

	mcpServer.registerTool(
		"agentStop",
		{ title: `Stop Agent`, description: STOP_DESCRIPTION, inputSchema: idSchema },
		async (args: { agentId: string }) => send(backendOf(args.agentId), idBody("stop", args.agentId)),
	);

	mcpServer.registerTool(
		"agentList",
		{ title: `List Agents`, description: LIST_DESCRIPTION, inputSchema: listSchema },
		async (args: { backend?: AgentBackendId; agentId?: string; detail?: "summary" | "full"; limit?: number }) => {
			const listBody = (backend: AgentBackendId) =>
				backend === "codex"
					? codexRequestBody("list", { agentId: args.agentId, detail: args.detail, limit: args.limit })
					: copilotRequestBody("list");
			if (args.agentId !== undefined) {
				const backend = backendOf(args.agentId);
				if (args.backend !== undefined && args.backend !== backend) {
					return refused(`${args.agentId} is not a ${descriptor(args.backend).displayName} agent`);
				}
				if (backend === "codex") return send(backend, listBody(backend));
				const dispatch = dispatches.copilot;
				if (!dispatch) return refused("Copilot agents are not enabled");
				const agentId = args.agentId;
				const one: AgentDispatch = async (body) => {
					const listed = (await dispatch(body)) as { agents?: Array<{ agentId?: string }> };
					return { agents: (listed.agents ?? []).filter((agent) => agent.agentId === agentId) };
				};
				return postAgentRequest(descriptor(backend), one, listBody(backend));
			}
			const families = args.backend ? [args.backend] : enabled;
			const answers = await Promise.all(families.map((backend) => send(backend, listBody(backend))));
			return {
				content: answers.flatMap((answer) => answer.content),
				...(answers.some((answer) => answer.isError) ? { isError: true } : {}),
			};
		},
	);
}
