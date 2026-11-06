// Registers every tool group through the guard, which throws on a definition a GPT host would refuse.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEveryTool } from "../src/mcp/everyTool.js";
import { guardTools } from "../src/mcp/toolGuard.js";

const server = new McpServer({ name: "tool-definition-check", version: "0.0.0" });
guardTools(server);
try {
	registerEveryTool(server);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
process.exit(0);
