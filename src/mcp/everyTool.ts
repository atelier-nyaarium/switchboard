// Every tool group a session can list, with every capability on: what the build and the tests check.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AGENT_BACKENDS } from "../shared/agent-backend.js";
import type { Capability } from "../shared/capabilities.js";
import { registerAgentTools } from "./agents/agentTools.js";
import { registerActionFront } from "./assistant/actionFront.js";
import { registerDeviceTool } from "./assistant/deviceTool.js";
import { registerInboxTool } from "./assistant/inboxTool.js";
import { registerAssistantSendTools } from "./assistant/sendTools.js";
import { registerBoardTools } from "./board/boardTools.js";
import { registerBridgeDiscover } from "./bridge/bridgeDiscover.js";
import { registerBridgeSend } from "./bridge/bridgeSend.js";
import { registerBridgeWait } from "./bridge/bridgeWait.js";
import { GATED_CAPABILITY_IDS } from "./capabilities.js";
import { registerCapabilitiesTool } from "./capabilitiesTool.js";
import { registerChannelReply, registerChannelReplyStructured } from "./channel/channelReply.js";
import { registerHumanTools } from "./channel/humanTools.js";
import { registerDesignerTools } from "./designer/designerTools.js";
import { registerCompactSession } from "./devcontainer/compactSession.js";
import { registerReloadPlugins } from "./devcontainer/reloadPlugins.js";
import { registerSetEffortLevel } from "./devcontainer/setEffortLevel.js";
import { registerRoutineTools } from "./routines/routineTools.js";
import { registerVaultTools } from "./vault/vaultTools.js";
import { registerWorkflowTools } from "./workflows/workflowTools.js";

/** The registrars `index.ts` calls, listed by name so a fence can compare the two. */
export const EVERY_TOOL_REGISTRAR = [
	"registerBridgeTools",
	"registerCapabilitiesTool",
	"registerReloadPlugins",
	"registerSetEffortLevel",
	"registerCompactSession",
	"registerHumanTools",
	"registerDesignerTools",
	"registerAgentTools",
	"registerBoardTools",
	"registerVaultTools",
	"registerRoutineTools",
	"registerWorkflowTools",
	"registerInboxTool",
	"registerActionFront",
	"registerDeviceTool",
	"registerAssistantSendTools",
] as const;

export function registerEveryTool(server: McpServer): void {
	const capabilities = GATED_CAPABILITY_IDS.map((id) => ({ id })) as Capability[];
	const dispatch = async () => ({});
	// `registerBridgeTools` opens the bridge, so its parts register here directly.
	registerBridgeDiscover(server);
	registerBridgeSend(server);
	registerBridgeWait(server);
	registerChannelReply(server, capabilities);
	registerChannelReplyStructured(server);
	registerCapabilitiesTool(server, capabilities, { assistant: false });
	registerReloadPlugins(server);
	registerSetEffortLevel(server);
	registerCompactSession(server);
	registerHumanTools(server, capabilities);
	registerDesignerTools(server);
	registerAgentTools(server, Object.fromEntries(AGENT_BACKENDS.map((backend) => [backend.id, dispatch])));
	registerBoardTools(server);
	registerVaultTools(server);
	registerRoutineTools(server);
	registerWorkflowTools(server);
	registerInboxTool(server);
	registerActionFront(server);
	registerDeviceTool(server);
	registerAssistantSendTools(server);
}
