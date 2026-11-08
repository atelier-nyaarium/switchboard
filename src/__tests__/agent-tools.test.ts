import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { messageBody, registerAgentTools, startBody } from "../mcp/agents/agentTools.js";

const CODEX_ID = "codex_0123456789abcdef0123456789abcdef";
const COPILOT_ID = "copilot_0123456789abcdef0123456789abcdef";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function tools(server: McpServer): Record<string, { handler: Handler }> {
	return (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
}

function toolNames(server: McpServer): string[] {
	return Object.keys(tools(server));
}

describe("one agent tool set", () => {
	it("maps start options onto each backend and refuses another backend's option", () => {
		expect(startBody("codex", { prompt: "Audit", tier: "standard", schema: { type: "object" } })).toMatchObject({
			kind: "start",
			prompt: "Audit",
			serviceTier: "standard",
			outputSchema: { type: "object" },
		});
		expect(startBody("copilot", { prompt: "Review", effort: "high", cwd: "/w" })).toMatchObject({
			kind: "start",
			reasoningEffort: "high",
			cwd: "/w",
		});
		expect(typeof startBody("codex", { prompt: "Audit", effort: "high" })).toBe("string");
		expect(typeof startBody("copilot", { prompt: "Review", tier: "priority" })).toBe("string");
		expect(typeof startBody("codex", { prompt: "   " })).toBe("string");
	});

	it("routes a follow-up by its agent id", () => {
		expect(messageBody({ agentId: CODEX_ID, prompt: "Go on", tier: "priority" })).toMatchObject({
			kind: "message",
			agentId: CODEX_ID,
			serviceTier: "priority",
		});
		expect(messageBody({ agentId: COPILOT_ID, prompt: "Go on", schema: { type: "string" } })).toMatchObject({
			kind: "message",
			agentId: COPILOT_ID,
			outputSchema: { type: "string" },
		});
		expect(typeof messageBody({ agentId: COPILOT_ID, prompt: "Go on", tier: "priority" })).toBe("string");
	});

	it("registers five tools when a backend is enabled, and none when none is", () => {
		const none = new McpServer({ name: "none", version: "0.0.0" });
		registerAgentTools(none, {});
		expect(toolNames(none)).toEqual([]);

		const one = new McpServer({ name: "one", version: "0.0.0" });
		registerAgentTools(one, { codex: async () => ({}) });
		expect(toolNames(one).sort()).toEqual(["agentCollect", "agentList", "agentMessage", "agentStart", "agentStop"]);
	});

	it("asks for one agent by id, refuses a conflicting backend, and marks a failed request", async () => {
		const asked: Array<Record<string, unknown>> = [];
		const server = new McpServer({ name: "both", version: "0.0.0" });
		registerAgentTools(server, {
			codex: async () => {
				throw new Error("offline");
			},
			copilot: async (body) => {
				asked.push(body);
				return { agents: [{ agentId: COPILOT_ID }] };
			},
		});
		const list = tools(server).agentList!.handler;

		const one = await list({ agentId: COPILOT_ID, limit: 3 });
		expect(JSON.parse(one.content[0]!.text)).toEqual({ agents: [{ agentId: COPILOT_ID }] });
		expect(asked[0]).toEqual({ kind: "list", agentId: COPILOT_ID, limit: 3 });
		expect((await list({ agentId: COPILOT_ID, backend: "codex" })).isError).toBe(true);
		expect((await list({})).isError).toBe(true);
		expect((await tools(server).agentCollect!.handler({ agentId: CODEX_ID })).isError).toBe(true);
	});
});
