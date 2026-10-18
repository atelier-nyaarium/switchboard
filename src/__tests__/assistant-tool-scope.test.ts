import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { scopeTools } from "../mcp/assistant/instructions.js";
import { guardToolResults } from "../mcp/toolResultGuard.js";
import { ASSISTANT_SWITCHBOARD_TOOLS } from "../shared/assistant-session.js";

describe("the assistant's tool scope", () => {
	it("lists only the assistant's tools, even after a removed one is updated", async () => {
		const server = new McpServer({ name: "probe", version: "0.0.0" });
		guardToolResults(server);
		scopeTools(server, new Set(ASSISTANT_SWITCHBOARD_TOOLS));
		const noop = async () => ({ content: [] });
		for (const name of ["channel_reply", "vault_run", "codexStartAgent", "switchboard_capabilities"]) {
			server.registerTool(name, { description: name, inputSchema: {} }, noop);
		}
		server.registerTool("crosstalk_send", { description: "x", inputSchema: {} }, noop).update({ callback: noop });
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await server.connect(serverSide);
		const client = new Client({ name: "probe-client", version: "0.0.0" });
		await client.connect(clientSide);

		const { tools } = await client.listTools();

		expect(tools.map((tool) => tool.name).sort()).toEqual(["channel_reply", "switchboard_capabilities"]);
	});
});
