import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { routerPostMock } = vi.hoisted(() => ({ routerPostMock: vi.fn() }));

vi.mock("../mcp/bridge/helpers.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../mcp/bridge/helpers.js")>();
	return { ...original, routerPost: routerPostMock };
});

import { registerWorkflowTools } from "../mcp/workflows/workflowTools.js";
import type { AgentBackendId } from "../shared/agent-backend.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	routerPostMock.mockReset().mockResolvedValue({ runId: "run-a" });
});

async function callStart(args: Record<string, unknown>, agentBackends: readonly AgentBackendId[] = []) {
	const server = new McpServer({ name: "workflows", version: "0.0.0" });
	registerWorkflowTools(server, agentBackends);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: "workflow-test", version: "0.0.0" });
	await client.connect(clientSide);
	const result = await client.callTool({ name: "workflowStart", arguments: args });
	await client.close();
	await server.close();
	return result;
}

describe("workflow MCP start", () => {
	it("posts inline script text without reading a path", async () => {
		const script = "export const meta = {}; return true;";
		const result = await callStart({ script, backend: "codex" }, ["codex", "copilot"]);
		expect(result.isError).not.toBe(true);
		expect(routerPostMock).toHaveBeenCalledWith(
			"/workflow/start",
			expect.objectContaining({ script, args: {}, backend: "codex", resumeFrom: null }),
		);
	});

	it("runs on the one backend there is, and asks which when there are several", async () => {
		const script = "export const meta = {}; return true;";

		const alone = await callStart({ script });
		const several = await callStart({ script }, ["opencode", "codex"]);

		expect(alone.isError).not.toBe(true);
		expect(routerPostMock).toHaveBeenCalledTimes(1);
		expect(routerPostMock).toHaveBeenCalledWith("/workflow/start", expect.objectContaining({ backend: "claude" }));
		expect(several.isError).toBe(true);
		expect(JSON.stringify(several.content)).toContain("Specify `backend`: opencode, codex, claude");
	});

	it("reads one path and refuses missing or competing script inputs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-tool-"));
		roots.push(root);
		const script = 'export const meta = {}; return "from file";';
		const filename = path.join(root, "workflow.js");
		fs.writeFileSync(filename, script);
		const fromPath = await callStart({ scriptPath: filename });
		expect(fromPath.isError).not.toBe(true);
		expect(routerPostMock).toHaveBeenLastCalledWith("/workflow/start", expect.objectContaining({ script }));

		const missing = await callStart({});
		const both = await callStart({ script, scriptPath: filename });
		expect(missing.isError).toBe(true);
		expect(both.isError).toBe(true);
		expect(routerPostMock).toHaveBeenCalledTimes(1);
	});
});
