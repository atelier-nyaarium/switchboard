import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { neutralizeMarkup } from "../shared/system-reminder.js";

////////////////////////////////
//  Interfaces & Types

type ToolCallback = (...args: unknown[]) => unknown;

type Register = (name: string, config: unknown, callback: ToolCallback) => { update: (updates: object) => void };

////////////////////////////////
//  Functions & Helpers

/** Every string, at any depth. */
export function neutralizedResult(value: unknown): unknown {
	if (typeof value === "string") return neutralizeMarkup(value);
	if (Array.isArray(value)) return value.map(neutralizedResult);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, neutralizedResult(item)]));
}

function guarded(callback: ToolCallback): ToolCallback {
	return async (...args) => {
		try {
			return neutralizedResult(await callback(...args));
		} catch (err) {
			// The SDK answers a throw with its message.
			if (!(err instanceof Error)) throw new Error(neutralizeMarkup(String(err)));
			err.message = neutralizeMarkup(err.message);
			throw err;
		}
	};
}

/**
 * An OpenAI-style function API refuses a longer description, and a Copilot or Codex host sends every
 * tool with every request, so one long tool fails every message the session sends.
 */
export const TOOL_DESCRIPTION_LIMIT = 1024;

/** Every `description` in a JSON Schema, with the path that leads to it. */
function schemaDescriptions(node: unknown, at: string, found: [string, string][] = []): [string, string][] {
	if (Array.isArray(node)) {
		for (const [index, item] of node.entries()) schemaDescriptions(item, `${at}[${index}]`, found);
	} else if (node && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			if (key === "description" && typeof value === "string") found.push([at, value]);
			else schemaDescriptions(value, `${at}.${key}`, found);
		}
	}
	return found;
}

/** What an OpenAI-style API would refuse in one tool, as the SDK will list it. */
export function toolDefinitionProblems(name: string, config: unknown): string[] {
	const { description, inputSchema } = (config ?? {}) as { description?: unknown; inputSchema?: unknown };
	const texts: [string, string][] = typeof description === "string" ? [[name, description]] : [];
	if (inputSchema && typeof inputSchema === "object") {
		const values = Object.values(inputSchema);
		// A raw shape lists as the object the SDK wraps it in; a listed tool is already JSON Schema.
		const json =
			inputSchema instanceof z.ZodType
				? z.toJSONSchema(inputSchema, { io: "input" })
				: values.length > 0 && values.every((value) => value instanceof z.ZodType)
					? z.toJSONSchema(z.object(inputSchema as z.ZodRawShape), { io: "input" })
					: inputSchema;
		texts.push(...schemaDescriptions(json, name));
	}
	return texts
		.filter(([, text]) => text.length > TOOL_DESCRIPTION_LIMIT)
		.map(([where, text]) => `${where}: description is ${text.length} characters, over ${TOOL_DESCRIPTION_LIMIT}`);
}

/**
 * Every tool registered afterwards is refused at once if a GPT host would refuse it, and answers
 * neutralized, since a result can echo foreign text.
 */
export function guardTools(server: McpServer): void {
	const register = server.registerTool.bind(server) as unknown as Register;
	const guardedRegister: Register = (name, config, callback) => {
		const problems = toolDefinitionProblems(name, config);
		if (problems.length > 0) throw new Error(`tool definition refused: ${problems.join("; ")}`);
		const tool = register(name, config, guarded(callback));
		const update = tool.update.bind(tool);
		tool.update = (updates) =>
			update(
				"callback" in updates && typeof updates.callback === "function"
					? { ...updates, callback: guarded(updates.callback as ToolCallback) }
					: updates,
			);
		return tool;
	};
	server.registerTool = guardedRegister as unknown as McpServer["registerTool"];
	// Bypasses the guard.
	server.tool = (() => {
		throw new Error("Register tools with registerTool");
	}) as McpServer["tool"];
}
