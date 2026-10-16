import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

/** Every tool registered afterwards answers neutralized, since a result can echo foreign text. */
export function guardToolResults(server: McpServer): void {
	const register = server.registerTool.bind(server) as unknown as Register;
	const guardedRegister: Register = (name, config, callback) => {
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
