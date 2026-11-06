import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EVERY_TOOL_REGISTRAR, registerEveryTool } from "../mcp/everyTool.js";
import { guardTools, TOOL_DESCRIPTION_LIMIT, toolDefinitionProblems } from "../mcp/toolGuard.js";
import {
	WORKFLOW_COLLECT_DESCRIPTION,
	WORKFLOW_LIST_DESCRIPTION,
	WORKFLOW_START_DESCRIPTION,
	WORKFLOW_STOP_DESCRIPTION,
} from "../mcp/workflows/workflowTools.js";

////////////////////////////////
//  Functions & Helpers

async function listed(): Promise<{ name: string; description?: string; inputSchema: unknown }[]> {
	const server = new McpServer({ name: "probe", version: "0.0.0" });
	guardTools(server);
	registerEveryTool(server);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: "probe-client", version: "0.0.0" });
	await client.connect(clientSide);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

////////////////////////////////
//  Tests

describe("every tool a session lists", () => {
	it("registers through the guard and lists definitions a GPT host accepts", async () => {
		const tools = await listed();

		expect(tools.length).toBeGreaterThan(30);
		expect(tools.flatMap((tool) => toolDefinitionProblems(tool.name, tool))).toEqual([]);
		expect(tools.filter((tool) => (tool.inputSchema as { type?: unknown }).type !== "object")).toEqual([]);
	});

	it("keeps workflow descriptions short and carries the requested agent options", () => {
		const descriptions = [
			WORKFLOW_START_DESCRIPTION,
			WORKFLOW_COLLECT_DESCRIPTION,
			WORKFLOW_LIST_DESCRIPTION,
			WORKFLOW_STOP_DESCRIPTION,
		];

		expect(descriptions.every((description) => description.length <= TOOL_DESCRIPTION_LIMIT)).toBe(true);
		expect(WORKFLOW_START_DESCRIPTION).toContain(
			'backend,  // "codex" | "copilot" | "claude"; defaults to the run\'s',
		);
		expect(WORKFLOW_START_DESCRIPTION).toContain(
			"schema,   // JSON Schema; the answer is validated, null on failure",
		);
		expect(WORKFLOW_START_DESCRIPTION).toContain("when a step needs GPT or another model family");
	});

	it("covers every registrar the server calls", () => {
		const index = fs.readFileSync(path.join(import.meta.dirname, "..", "mcp", "index.ts"), "utf8");
		const called = new Set([...index.matchAll(/\b(register[A-Z]\w*)\(mcpServer\b/g)].map((m) => m[1]));
		// Connector mode is a different server.
		for (const name of ["registerConnectorTools", "registerProjectTools", "registerStubTool"]) called.delete(name);

		expect([...called].sort()).toEqual([...EVERY_TOOL_REGISTRAR].sort());
	});
});

describe("the guard", () => {
	const server = () => {
		const made = new McpServer({ name: "probe", version: "0.0.0" });
		guardTools(made);
		return made;
	};

	it("refuses a tool at registration when its description or a field's is too long", () => {
		const long = "x".repeat(TOOL_DESCRIPTION_LIMIT + 1);

		expect(() => server().registerTool("wordy", { description: long }, async () => ({ content: [] }))).toThrow(
			/wordy: description is 1025 characters/,
		);
		expect(() =>
			server().registerTool(
				"fieldy",
				{ description: "Fine.", inputSchema: { note: z.string().describe(long) } },
				async () => ({ content: [] }),
			),
		).toThrow(/fieldy\.properties\.note/);
		expect(() =>
			server().registerTool("fits", { description: "x".repeat(TOOL_DESCRIPTION_LIMIT) }, async () => ({
				content: [],
			})),
		).not.toThrow();
	});
});
