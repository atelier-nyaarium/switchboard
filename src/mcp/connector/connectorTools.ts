import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	getAuthToken,
	getListenerState,
	restartWithoutTls,
	restartWithTls,
	setAuthToken,
	startListener,
	stopListener,
} from "./listener.js";
import { getAllClients, getClient } from "./sessions.js";
import { generateCaCert, generateServerCert } from "./tls.js";
import { textResult } from "./utils.js";

const SCHEMA_TEMPLATE = `/**
 * MCP Schema - Agent-Team-Bridge Connector
 *
 * Each tool defined here becomes available to IDE agents when a game client
 * connects via WebSocket. The agent calls the tool, the connector forwards it
 * to the game client, and the client returns a result.
 *
 * @param {import("zod").ZodType} z - Zod module for parameter validation.
 * @returns {Array} Array of tool definitions.
 */
export default function (z) {
\treturn [
\t\t{
\t\t\tname: "foo",
\t\t\ttitle: "Foo",
\t\t\tdescription:
\t\t\t\t"A simple test tool for validating the connector works. Accepts a numeric 'bar' parameter and echoes it back.",
\t\t\tschema: z.object({
\t\t\t\tbar: z.number().describe("Some numeric value."),
\t\t\t}),
\t\t},
\t];
}
`;

////////////////////////////////
//  Functions & Helpers

export function registerConnectorTools(
	mcpServer: McpServer,
	projectName: string,
	connectorDir: string,
	port: number,
): void {
	const schemaPath = `${connectorDir}/mcp-schema.js`;
	const hasSchema = existsSync(schemaPath);
	const hasCerts = existsSync(`${connectorDir}/server.crt`) && existsSync(`${connectorDir}/server.key`);

	// mcpConnectorStatus
	mcpServer.registerTool(
		"mcpConnectorStatus",
		{
			title: "MCP Connector Status",
			description: `Show the connector's mode (HTTP/HTTPS), auth status, and connected game clients with their IDs.`,
			// biome-ignore lint/suspicious/noExplicitAny: zod v4 / MCP SDK type compat
			inputSchema: z.object({}).shape as any,
		},
		async () => {
			const listenerState = getListenerState();
			const serving = !!listenerState;
			const clients = getAllClients().map((c) => ({
				clientId: c.shortHash,
				connectedAt: c.connectedAt.toISOString(),
				remoteAddress: c.remoteAddress,
			}));

			const result: Record<string, unknown> = serving
				? {
						serving,
						mode: listenerState.mode,
						hostname: listenerState.hostname,
						port: listenerState.port,
						authEnabled: !!getAuthToken(),
						clients,
					}
				: { serving, port, authEnabled: !!getAuthToken() };

			if (!serving) {
				result.hint = hasSchema
					? `This session is not serving. Another IDE may own port ${port}. Call mcpConnectorServe to take over, or mcpConnectorUnserve in the other session first.`
					: `This session is not serving. Call mcpConnectorServe to start, then mcpConnectorCreateSchema to create a schema.`;
			} else if (!hasSchema) {
				result.hint = `No mcp-schema.js found. Call mcpConnectorCreateSchema to initialize, then /mcp to restart.`;
			} else if (clients.length === 0) {
				result.hint = `Serving but no game clients connected yet.`;
			} else {
				result.hint = `Ready. Use project tools with a clientId from the clients list.`;
			}

			if (!getAuthToken() || !hasCerts) {
				const steps = [];
				if (!getAuthToken()) steps.push("mcpConnectorGenerateToken");
				if (!hasCerts) steps.push("mcpConnectorGenerateCert");
				steps.push("mcpConnectorOpen");
				result.security = `For remote access: ${steps.join(" → ")}`;
			}

			return textResult(JSON.stringify(result, null, 2));
		},
	);

	// mcpConnectorServe
	mcpServer.registerTool(
		"mcpConnectorServe",
		{
			title: "Start Connector",
			description: `Start serving project tools on the connector port. Fails if another session already owns the port.`,
			inputSchema: z.object({}).shape,
		},
		async () => {
			if (getListenerState()) {
				return textResult(`Already serving on port ${port}.`);
			}
			try {
				startListener(port);
				return textResult(`Now serving on port ${port}. Game clients can connect.`);
			} catch {
				return textResult(
					`Port ${port} is held by another IDE session. Call mcpConnectorUnserve in that session first.`,
					true,
				);
			}
		},
	);

	// mcpConnectorUnserve
	mcpServer.registerTool(
		"mcpConnectorUnserve",
		{
			title: "Stop Connector",
			description: `Stop serving project tools. Disconnects all game clients. Another IDE session can then take over with mcpConnectorServe.`,
			inputSchema: z.object({}).shape,
		},
		async () => {
			if (!getListenerState()) {
				return textResult(`Not serving. Nothing to stop.`);
			}
			stopListener();
			return textResult(
				`Stopped serving on port ${port}. Game clients disconnected. Another IDE session can now call mcpConnectorServe.`,
			);
		},
	);

	// mcpConnectorOpen
	mcpServer.registerTool(
		"mcpConnectorOpen",
		{
			title: "Open MCP Connector",
			description: `Open the connector to the public with HTTPS/WSS. Requires both a token (mcpConnectorGenerateToken) and certs (mcpConnectorGenerateCert). Warning: disconnects all currently connected game clients.`,
			inputSchema: z.object({}).shape,
		},
		async () => {
			if (!getListenerState()) {
				return textResult(`Not serving. Call mcpConnectorServe to start.`, true);
			}
			try {
				if (!getAuthToken()) {
					return textResult(
						`Cannot open to public without authentication. Run mcpConnectorGenerateToken first.`,
						true,
					);
				}
				restartWithTls(connectorDir, port);
				const state = getListenerState();
				return textResult(
					JSON.stringify(
						{
							status: "open",
							mode: state?.mode,
							hostname: state?.hostname,
							port: state?.port,
							warning: `All previously connected clients were disconnected. They must reconnect using wss://.`,
						},
						null,
						2,
					),
				);
			} catch (error) {
				return textResult((error as Error).message, true);
			}
		},
	);

	// mcpConnectorClose
	mcpServer.registerTool(
		"mcpConnectorClose",
		{
			title: "Close MCP Connector",
			description: `Revert the connector to localhost-only HTTP. Disconnects remote clients.`,
			// biome-ignore lint/suspicious/noExplicitAny: zod v4 / MCP SDK type compat
			inputSchema: z.object({}).shape as any,
		},
		async () => {
			if (!getListenerState()) {
				return textResult(`Not serving. Call mcpConnectorServe to start.`, true);
			}
			restartWithoutTls(port);
			const state = getListenerState();
			return textResult(
				JSON.stringify(
					{
						status: "closed",
						mode: state?.mode,
						hostname: state?.hostname,
						port: state?.port,
					},
					null,
					2,
				),
			);
		},
	);

	// mcpConnectorGenerateCert
	const generateCertObj = z.object({
		domain: z.string().optional().describe(`Domain for the certificate SAN. Defaults to "localhost".`),
	});
	mcpServer.registerTool(
		"mcpConnectorGenerateCert",
		{
			title: "Generate TLS Certificate",
			description: `Generate a self-signed CA and server certificate. Writes to .claude/connector/. Required before mcpConnectorOpen.`,
			// biome-ignore lint/suspicious/noExplicitAny: zod v4 / MCP SDK type compat
			inputSchema: generateCertObj.shape as any,
		},
		// biome-ignore lint/suspicious/noExplicitAny: zod v4 / MCP SDK type compat
		async (args: any) => {
			try {
				const domain = (args.domain as string) || "localhost";

				if (!existsSync(connectorDir)) {
					mkdirSync(connectorDir, { recursive: true });
				}

				const ca = generateCaCert(projectName);
				const server = generateServerCert({ caCert: ca.caCert, caKey: ca.caKey, domain });

				writeFileSync(`${connectorDir}/ca.crt`, ca.caCert);
				writeFileSync(`${connectorDir}/ca.key`, ca.caKey, { mode: 0o600 });
				writeFileSync(`${connectorDir}/server.crt`, server.serverCert);
				writeFileSync(`${connectorDir}/server.key`, server.serverKey, { mode: 0o600 });

				return textResult(
					JSON.stringify(
						{
							status: "generated",
							domain,
							files: ["ca.crt", "ca.key", "server.crt", "server.key"],
							connectorDir,
							next: `Run mcpConnectorOpen to enable HTTPS/WSS.`,
						},
						null,
						2,
					),
				);
			} catch (error) {
				return textResult((error as Error).message, true);
			}
		},
	);

	// mcpConnectorGenerateToken
	mcpServer.registerTool(
		"mcpConnectorGenerateToken",
		{
			title: "Generate Auth Token",
			description: `Generate a bearer token for authenticating game client connections. Required before mcpConnectorOpen. Token is persisted in .claude/connector/token.`,
			// biome-ignore lint/suspicious/noExplicitAny: zod v4 / MCP SDK type compat
			inputSchema: z.object({}).shape as any,
		},
		async () => {
			const token = randomUUID();

			if (!existsSync(connectorDir)) {
				mkdirSync(connectorDir, { recursive: true });
			}
			writeFileSync(`${connectorDir}/token`, token, { mode: 0o600 });
			setAuthToken(token);

			return textResult(
				JSON.stringify(
					{
						status: "generated",
						token,
						next: `Use mcpConnectorClientBundle to generate a connection bundle for testers.`,
					},
					null,
					2,
				),
			);
		},
	);

	// mcpConnectorDisconnect
	const disconnectObj = z.object({
		clientId: z.string().describe(`6-char client hash from mcpConnectorStatus.`),
	});
	mcpServer.registerTool(
		"mcpConnectorDisconnect",
		{
			title: "Disconnect Game Client",
			description: `Disconnect a game client by its 6-char ID. Pending tool invocations on that client will fail. Get IDs from mcpConnectorStatus.`,
			// biome-ignore lint/suspicious/noExplicitAny: zod v4 / MCP SDK type compat
			inputSchema: disconnectObj.shape as any,
		},
		// biome-ignore lint/suspicious/noExplicitAny: zod v4 / MCP SDK type compat
		async (args: any) => {
			if (!getListenerState()) {
				return textResult(`Not serving. Call mcpConnectorServe to start.`, true);
			}
			const clientId = args.clientId as string;
			const client = getClient(clientId);
			if (!client) {
				return textResult(`Client ${clientId} not found.`, true);
			}
			client.ws.close(1000, "Kicked by agent");
			return textResult(`Disconnected client ${clientId}.`);
		},
	);

	// mcpConnectorClientBundle
	mcpServer.registerTool(
		"mcpConnectorClientBundle",
		{
			title: "Get Client Connection Bundle",
			description: `Generate a connect.json and ca.crt bundle for a game tester to copy into their game's mcp-connector/ folder.`,
			// biome-ignore lint/suspicious/noExplicitAny: zod v4 / MCP SDK type compat
			inputSchema: z.object({}).shape as any,
		},
		async () => {
			const listenerState = getListenerState();
			if (!listenerState) {
				return textResult(`Not serving. Call mcpConnectorServe to start.`, true);
			}

			const protocol = listenerState.mode === "https" ? "wss" : "ws";
			const host = listenerState.hostname === "0.0.0.0" ? "YOUR_HOST_IP" : listenerState.hostname;
			const token = getAuthToken();
			const connectObj: Record<string, string> = { url: `${protocol}://${host}:${listenerState.port}/ws` };
			if (token) {
				connectObj.token = token;
			}
			const connectJson = JSON.stringify(connectObj, null, 2);

			let caCertContent: string | null = null;
			const caCertPath = `${connectorDir}/ca.crt`;
			if (existsSync(caCertPath)) {
				caCertContent = readFileSync(caCertPath, "utf-8");
			}

			const parts = [
				`## connect.json\n\nPlace in your game's mcp-connector/ folder:\n\n\`\`\`json\n${connectJson}\n\`\`\``,
			];

			if (caCertContent) {
				parts.push(
					`\n## ca.crt\n\nPlace alongside connect.json (required for self-signed certs):\n\n\`\`\`\n${caCertContent}\`\`\``,
				);
			}

			return textResult(parts.join("\n"));
		},
	);

	// mcpConnectorCreateSchema (only when no schema exists)
	if (!hasSchema) {
		mcpServer.registerTool(
			"mcpConnectorCreateSchema",
			{
				title: "Create MCP Schema",
				description: `No .claude/connector/mcp-schema.js found. Run this to generate an example schema. Use /mcp to restart after editing.`,
				// biome-ignore lint/suspicious/noExplicitAny: zod v4 / MCP SDK type compat
				inputSchema: z.object({}).shape as any,
			},
			async () => {
				if (!existsSync(connectorDir)) {
					mkdirSync(connectorDir, { recursive: true });
				}
				writeFileSync(schemaPath, SCHEMA_TEMPLATE);

				const gitignorePath = `${connectorDir}/.gitignore`;
				if (!existsSync(gitignorePath)) {
					writeFileSync(gitignorePath, "*.crt\n*.key\ntoken\n");
				}

				return textResult(
					`Created ${schemaPath} with example schema.\nUse /mcp to restart this MCP server to load it.`,
				);
			},
		);
	}
}
