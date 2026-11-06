import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerActionFront } from "../mcp/assistant/actionFront.js";
import { registerDeviceTool } from "../mcp/assistant/deviceTool.js";
import { registerInboxTool } from "../mcp/assistant/inboxTool.js";
import { registerAssistantSendTools } from "../mcp/assistant/sendTools.js";
import { registerBoardTools } from "../mcp/board/boardTools.js";
import { registerBridgeDiscover } from "../mcp/bridge/bridgeDiscover.js";
import { registerBridgeSend } from "../mcp/bridge/bridgeSend.js";
import { registerBridgeWait } from "../mcp/bridge/bridgeWait.js";
import { GATED_CAPABILITY_IDS } from "../mcp/capabilities.js";
import { registerCapabilitiesTool } from "../mcp/capabilitiesTool.js";
import { registerChannelReply, registerChannelReplyStructured } from "../mcp/channel/channelReply.js";
import { registerHumanTools } from "../mcp/channel/humanTools.js";
import { registerCodexTools } from "../mcp/codex/codexTools.js";
import { registerCopilotTools } from "../mcp/copilot/copilotTools.js";
import { registerDesignerTools } from "../mcp/designer/designerTools.js";
import { registerCompactSession } from "../mcp/devcontainer/compactSession.js";
import { registerReloadPlugins } from "../mcp/devcontainer/reloadPlugins.js";
import { registerSetEffortLevel } from "../mcp/devcontainer/setEffortLevel.js";
import { registerRoutineTools } from "../mcp/routines/routineTools.js";
import { registerVaultTools } from "../mcp/vault/vaultTools.js";
import type { Capability } from "../shared/capabilities.js";

////////////////////////////////
//  Functions & Helpers

// An OpenAI-style function API refuses a longer description, and a Copilot or Codex host sends every
// tool on every request, so one long tool fails every message the session sends.
const DESCRIPTION_LIMIT = 1024;

const EVERY_CAPABILITY = GATED_CAPABILITY_IDS.map((id) => ({ id })) as Capability[];

async function listed(): Promise<{ name: string; description?: string; inputSchema: unknown }[]> {
	const server = new McpServer({ name: "probe", version: "0.0.0" });
	const dispatch = async () => ({});
	registerBridgeDiscover(server);
	registerBridgeSend(server);
	registerBridgeWait(server);
	registerChannelReply(server, EVERY_CAPABILITY);
	registerChannelReplyStructured(server);
	registerCapabilitiesTool(server, EVERY_CAPABILITY, { assistant: false });
	registerReloadPlugins(server);
	registerSetEffortLevel(server);
	registerCompactSession(server);
	registerHumanTools(server, EVERY_CAPABILITY);
	registerDesignerTools(server);
	registerCodexTools(server, dispatch);
	registerCopilotTools(server, dispatch);
	registerBoardTools(server);
	registerVaultTools(server);
	registerRoutineTools(server);
	registerInboxTool(server);
	registerActionFront(server);
	registerDeviceTool(server);
	registerAssistantSendTools(server);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: "probe-client", version: "0.0.0" });
	await client.connect(clientSide);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

/** Every `description` in a JSON Schema, with the path that leads to it. */
function fieldDescriptions(node: unknown, at: string, found: [string, string][] = []): [string, string][] {
	if (Array.isArray(node)) {
		for (const [index, item] of node.entries()) fieldDescriptions(item, `${at}[${index}]`, found);
	} else if (node && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			if (key === "description" && typeof value === "string") found.push([at, value]);
			else fieldDescriptions(value, `${at}.${key}`, found);
		}
	}
	return found;
}

////////////////////////////////
//  Tests

describe("every tool a session lists", () => {
	it("fits a description, and each field's, in what an OpenAI-style API accepts", async () => {
		const tools = await listed();
		const over = tools.flatMap((tool) =>
			[
				[tool.name, tool.description ?? ""] as [string, string],
				...fieldDescriptions(tool.inputSchema, tool.name),
			].filter(([, text]) => text.length > DESCRIPTION_LIMIT),
		);

		expect(tools.length).toBeGreaterThan(30);
		expect(over.map(([where, text]) => `${where}: ${text.length}`)).toEqual([]);
	});

	it("gives every tool an object schema at the top, which those APIs require", async () => {
		const tools = await listed();

		expect(tools.filter((tool) => (tool.inputSchema as { type?: unknown }).type !== "object")).toEqual([]);
	});
});
