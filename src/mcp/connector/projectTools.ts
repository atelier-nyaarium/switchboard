import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invokeOnClient } from "./listener.js";
import { registerStubTool, textResult } from "./utils.js";

const TAG = "[connector]";

////////////////////////////////
//  Schemas

const McpToolSchema = z.object({
	name: z.string(),
	title: z.string(),
	description: z.string(),
	schema: z.instanceof(z.ZodObject),
});

type McpTool = z.infer<typeof McpToolSchema>;

////////////////////////////////
//  State

// biome-ignore lint/suspicious/noExplicitAny: Zod schema generic
const loadedToolSchemas = new Map<string, z.ZodObject<any>>();

////////////////////////////////
//  Functions & Helpers

export function getToolSchema(name: string): z.ZodObject<z.ZodRawShape> | undefined {
	return loadedToolSchemas.get(name);
}

export function getLoadedToolNames(): string[] {
	return Array.from(loadedToolSchemas.keys());
}

export async function registerProjectTools(
	mcpServer: McpServer,
	projectName: string,
	connectorDir: string,
): Promise<void> {
	const schemaPath = `${connectorDir}/mcp-schema.js`;

	if (!existsSync(schemaPath)) {
		// mcpConnectorCreateSchema stub is handled by connectorTools.ts
		console.error(`${TAG} No schema at ${schemaPath}`);
		return;
	}

	let schema: { default?: unknown };
	try {
		schema = await import(schemaPath);
	} catch (error) {
		const err = error as Error;
		console.error(`${TAG} Failed to load schema from ${schemaPath}: ${err.message}`);
		registerStubTool(
			mcpServer,
			"projectMcpConnectorStatus",
			`Project MCP connector failed to load. Call this tool for error details.`,
			() => `${err.message}\n${err.stack}`,
		);
		return;
	}

	const schemaFn = schema.default;
	if (typeof schemaFn !== "function") {
		const msg = `Schema must default export a function. Got: ${typeof schemaFn}`;
		console.error(`${TAG} ${msg}`);
		registerStubTool(
			mcpServer,
			"projectMcpConnectorStatus",
			`Project MCP connector failed to load. Call this tool for error details.`,
			() => msg,
		);
		return;
	}

	let rawTools: unknown;
	try {
		rawTools = schemaFn(z);
	} catch (error) {
		const err = error as Error;
		console.error(`${TAG} Schema function threw: ${err.message}`);
		registerStubTool(
			mcpServer,
			"projectMcpConnectorStatus",
			`Project MCP connector failed to load. Call this tool for error details.`,
			() => `${err.message}\n${err.stack}`,
		);
		return;
	}

	const parsed = z.array(McpToolSchema).safeParse(rawTools);
	if (!parsed.success) {
		const msg = `Schema function returned invalid tools: ${parsed.error.message}`;
		console.error(`${TAG} ${msg}`);
		registerStubTool(
			mcpServer,
			"projectMcpConnectorStatus",
			`Project MCP connector failed to load. Call this tool for error details.`,
			() => msg,
		);
		return;
	}

	const tools: McpTool[] = parsed.data;

	// Store schemas for validation by listener
	loadedToolSchemas.clear();
	for (const tool of tools) {
		loadedToolSchemas.set(tool.name, tool.schema);
	}

	for (const tool of tools) {
		const extendedShape = {
			clientId: z.string().describe(`6-char client hash from mcpConnectorStatus`),
			...tool.schema.shape,
		};

		// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
		const toolSchema: any = z.object(extendedShape);

		mcpServer.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: toolSchema,
			},
			async (args: Record<string, unknown>) => {
				try {
					const { clientId, ...toolArgs } = args;

					if (!clientId || typeof clientId !== "string") {
						return textResult(
							`clientId is required. Call mcpConnectorStatus to get connected client IDs.`,
							true,
						);
					}

					const result = await invokeOnClient(clientId, tool.name, toolArgs);
					return textResult(JSON.stringify(result, null, 2));
				} catch (error) {
					return textResult(
						JSON.stringify({ errors: [{ message: (error as Error).message }] }, null, 2),
						true,
					);
				}
			},
		);
	}

	console.error(`${TAG} Loaded ${tools.length} project tool(s) from ${projectName}`);
}
