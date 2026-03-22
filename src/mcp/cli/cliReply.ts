import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReplyTool } from "../../shared/schemas.js";

export function registerCliReply(mcpServer: McpServer): void {
	registerReplyTool(
		mcpServer,
		"crosstalk_reply",
		"Crosstalk Reply",
		`Reply to an incoming bridge request. Call this once when you are done handling the request.`,
		"bridge",
	);
}
