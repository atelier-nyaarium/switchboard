import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Claude Code starts the server inside the user's project. Without these flags bun would run that
// project's bunfig.toml preload and load its .env inside a process holding vault access.

const root = path.resolve(import.meta.dirname, "../..");

describe("the plugin's MCP launch", () => {
	it("pins switchboard's own settings files and turns off .env loading and auto-install", () => {
		const config = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")) as {
			mcpServers: Record<string, { args: string[] }>;
		};
		const args = config.mcpServers.switchboard?.args ?? [];

		expect({
			flags: args.slice(0, 4),
			files: ["launch/bunfig.toml", "launch/tsconfig.json"].map((file) => fs.existsSync(path.join(root, file))),
		}).toEqual({
			flags: [
				"--config=${CLAUDE_PLUGIN_ROOT}/launch/bunfig.toml",
				"--tsconfig-override=${CLAUDE_PLUGIN_ROOT}/launch/tsconfig.json",
				"--no-env-file",
				"--no-install",
			],
			files: [true, true],
		});
	});
});
