import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGENT_BACKENDS, type AgentBackendId, agentBackend, agentBackendOf } from "../../shared/agent-backend.js";
import { AgentOutputSchemaSchema } from "../../shared/agent-record.js";
import {
	AgentListInputSchema,
	AgentMessageInputSchema,
	type AgentServiceTier,
	AgentServiceTierSchema,
	AgentStartInputSchema,
} from "../../shared/agent-state.js";
import type { AgentDispatch } from "../agentDispatch.js";
import { agentRequestBody, postAgentRequest } from "../agentRequest.js";

export type AgentDispatches = Partial<Record<AgentBackendId, AgentDispatch>>;

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const AgentIdSchema = z.string().refine((id) => agentBackendOf(id) !== undefined, "not an agent id");

const START_DESCRIPTION = `
# Start Agent

Start an agent for a self-contained task.

\`backend\` sets the backend. If more than one is installed, you must specify which. \`tier\` is Codex only; \`effort\` is Copilot only. \`schema\` constrains the final answer; validate it yourself. Set \`model\` and \`cwd\` to start with. Use \`agentListModels\` to list the models.

Returns when the agent accepts the turn. Call \`agentCollect\` after its completion notice. Running agents send progress notices every 10 minutes.

The agent's thread is deleted 24 hours after its last use.

Agents have full access. State allowed writes, network access, and completion criteria in the prompt. See \`switchboard_capabilities\` for backend notes.
`.trim();

const MESSAGE_DESCRIPTION = `
# Message Agent

Send a follow-up prompt. Running turns are steered; idle agents start a new turn.

The agent keeps its history. Repeat any guardrails that still apply. Codex \`tier\` and \`schema\` apply to the next new turn.

Returns when the agent accepts the message. Call \`agentCollect\` after its completion notice.

A thread unused for 24 hours is deleted.
`.trim();

const COLLECT_DESCRIPTION = `
# Collect Agent

Answers at once with every ended turn not yet collected, oldest first, and the running turn's id. A running turn ends later with a notice naming this tool.

A collected turn is not handed back again.
`.trim();

const STOP_DESCRIPTION = `
# Stop Agent

Interrupt the current turn. Returns once the request is durable; the outcome arrives later. The agent remains usable with \`agentMessage\`. Started background processes keep running.
`.trim();

const DELETE_DESCRIPTION = `
# Delete Agent

Delete an agent and its thread. A running turn is stopped first.
`.trim();

const LIST_DESCRIPTION = `
# List Agents

Agents starting, running, or holding an uncollected turn, newest first. No answers.

- \`backend\` limits the list to one backend.
- \`agentId\` returns that one agent, collected or not.
- \`limit\` caps each backend's rows.

Keep the ids of agents you will message again.
`.trim();

const MODELS_DESCRIPTION = `
# List Agent Models

List the newest models in all enabled model families.
- \`backend\` lists for just that backend
`.trim();

function refused(text: string): ToolText {
	return { content: [{ type: "text", text }], isError: true };
}

function backendOf(agentId: string): AgentBackendId {
	const backend = agentBackendOf(agentId);
	if (!backend) throw new Error(`not an agent id`);
	return backend;
}

const descriptor = agentBackend;

function issues(error: z.ZodError): string {
	return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

/** Preserve caller option names. */
function untakenOption(
	backend: AgentBackendId,
	args: { effort?: string; tier?: AgentServiceTier },
): string | undefined {
	const { displayName, options } = descriptor(backend);
	if (args.effort !== undefined && !options.reasoningEffort) return `\`effort\` is not a ${displayName} option`;
	if (args.tier !== undefined && !options.serviceTier) return `\`tier\` is not a ${displayName} option`;
	return undefined;
}

interface StartArgs {
	prompt: string;
	backend?: AgentBackendId;
	model?: string;
	effort?: string;
	tier?: AgentServiceTier;
	schema?: Record<string, unknown>;
	cwd?: string;
}

export function startBody(backend: AgentBackendId, args: StartArgs): Record<string, unknown> | string {
	const untaken = untakenOption(backend, args);
	if (untaken) return untaken;
	const checked = AgentStartInputSchema.safeParse({
		prompt: args.prompt,
		...(args.model === undefined ? {} : { model: args.model }),
		...(args.cwd === undefined ? {} : { cwd: args.cwd }),
		...(args.tier === undefined ? {} : { serviceTier: args.tier }),
		...(args.effort === undefined ? {} : { reasoningEffort: args.effort }),
		...(args.schema === undefined ? {} : { outputSchema: args.schema }),
	});
	return checked.success ? agentRequestBody(descriptor(backend), "start", checked.data) : issues(checked.error);
}

interface MessageArgs {
	agentId: string;
	prompt: string;
	tier?: AgentServiceTier;
	schema?: Record<string, unknown>;
}

export function messageBody(args: MessageArgs): Record<string, unknown> | string {
	const backend = backendOf(args.agentId);
	const untaken = untakenOption(backend, args);
	if (untaken) return untaken;
	const checked = AgentMessageInputSchema.safeParse({
		agentId: args.agentId,
		prompt: args.prompt,
		...(args.tier === undefined ? {} : { serviceTier: args.tier }),
		...(args.schema === undefined ? {} : { outputSchema: args.schema }),
	});
	return checked.success ? agentRequestBody(descriptor(backend), "message", checked.data) : issues(checked.error);
}

function idBody(kind: "await" | "stop" | "delete", agentId: string): Record<string, unknown> {
	return agentRequestBody(descriptor(backendOf(agentId)), kind, { agentId });
}

export function registerAgentTools(mcpServer: McpServer, dispatches: AgentDispatches): void {
	const enabled = AGENT_BACKENDS.map((backend) => backend.id).filter((id) => dispatches[id] !== undefined);
	const [first, ...rest] = enabled;
	if (first === undefined) return;
	const BackendSchema = z.enum([first, ...rest]);
	// Caller selects among backends.
	const sole = rest.length === 0 ? first : undefined;

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
			backend: sole ? BackendSchema.optional() : BackendSchema,
			model: z
				.string()
				.describe(`Model ID as listed by \`agentListModels\`. Omit to use the backend's default.`)
				.optional(),
			effort: z.string().optional(),
			tier: AgentServiceTierSchema.optional(),
			schema: AgentOutputSchemaSchema.optional(),
			cwd: z.string().optional(),
		})
		.strict();
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const messageSchema: any = z
		.object({
			agentId: AgentIdSchema,
			prompt: z.string(),
			tier: AgentServiceTierSchema.optional(),
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
			limit: AgentListInputSchema.shape.limit,
		})
		.strict();
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const modelsSchema: any = z.object({ backend: BackendSchema.optional() }).strict();

	mcpServer.registerTool(
		"agentStart",
		{ title: `Start Agent`, description: START_DESCRIPTION, inputSchema: startSchema },
		async (args: StartArgs) => {
			const backend = args.backend ?? sole;
			if (!backend) return refused(`Specify \`backend\`: ${enabled.join(", ")}`);
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
		"agentDelete",
		{ title: `Delete Agent`, description: DELETE_DESCRIPTION, inputSchema: idSchema },
		async (args: { agentId: string }) => send(backendOf(args.agentId), idBody("delete", args.agentId)),
	);

	mcpServer.registerTool(
		"agentList",
		{ title: `List Agents`, description: LIST_DESCRIPTION, inputSchema: listSchema },
		async (args: { backend?: AgentBackendId; agentId?: string; limit?: number }) => {
			const listBody = (backend: AgentBackendId) => {
				const query = { agentId: args.agentId, limit: args.limit };
				return agentRequestBody(descriptor(backend), "list", query);
			};
			if (args.agentId !== undefined) {
				const backend = backendOf(args.agentId);
				if (args.backend !== undefined && args.backend !== backend) {
					return refused(`${args.agentId} is not a ${descriptor(args.backend).displayName} agent`);
				}
				return send(backend, listBody(backend));
			}
			const families = args.backend ? [args.backend] : enabled;
			const answers = await Promise.all(families.map((backend) => send(backend, listBody(backend))));
			return {
				content: answers.flatMap((answer) => answer.content),
				...(answers.some((answer) => answer.isError) ? { isError: true } : {}),
			};
		},
	);

	mcpServer.registerTool(
		"agentListModels",
		{ title: `List Agent Models`, description: MODELS_DESCRIPTION, inputSchema: modelsSchema },
		async (args: { backend?: AgentBackendId }) => {
			const rows = await Promise.all(
				(args.backend ? [args.backend] : enabled).map(async (backend) => {
					try {
						const listed = await dispatches[backend]?.(agentRequestBody(descriptor(backend), "models"));
						return { backend, ...(listed as { models?: unknown }) };
					} catch (error) {
						return { backend, error: error instanceof Error ? error.message : String(error) };
					}
				}),
			);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
				...(rows.every((row) => "error" in row) ? { isError: true } : {}),
			};
		},
	);
}
