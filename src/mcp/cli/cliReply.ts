import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CliReplySchema } from "../../shared/schemas.js";
import { registerReplyTool } from "../bridge/replyTool.js";

export function registerCliReply(mcpServer: McpServer): void {
	registerReplyTool(
		mcpServer,
		"crosstalk_reply",
		"Crosstalk Reply",
		`Reply to an incoming bridge request. Call this when you are done handling the request. Send the response verbatim unless the requester explicitly asked for a summary.`,
		"bridge",
		CliReplySchema,
	);
}
