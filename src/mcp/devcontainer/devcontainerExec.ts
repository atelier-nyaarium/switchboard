import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertNotContainer, ensureContainerUp, execInContainer, resolveProject } from "./helpers.js";

////////////////////////////////
//  Schemas

const DevcontainerExecSchema = z.object({
	projectPath: z.string().describe(`Path to the project directory. Absolute or relative to ~/.`),
	command: z.string().describe(`Shell command to execute inside the devcontainer`),
	background: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			`If true, runs the command in a persistent tmux session inside the container. The process will keep running after this tool returns.`,
		),
	tmuxSession: z
		.string()
		.optional()
		.default("host-to-container")
		.describe(`Tmux session name for background mode. Defaults to 'host-to-container'.`),
});
type DevcontainerExecArgs = z.infer<typeof DevcontainerExecSchema>;

////////////////////////////////
//  Functions & Helpers

const description = `
Execute a shell command inside a project's devcontainer.
Automatically starts the container if needed.
Set background: true to run in a persistent tmux session that survives after this tool returns.
`.trim();

export function registerDevcontainerExec(mcpServer: McpServer): void {
	mcpServer.tool("devcontainerExec", description, DevcontainerExecSchema.shape, async (rawArgs) => {
		try {
			const args: DevcontainerExecArgs = DevcontainerExecSchema.parse(rawArgs);
			assertNotContainer();
			const projectPath = resolveProject(args.projectPath);

			ensureContainerUp(projectPath);

			if (!args.background) {
				const output = await execInContainer({ projectPath, command: ["bash", "-c", args.command] });
				return { content: [{ type: "text" as const, text: JSON.stringify({ output }, null, 2) }] };
			}

			// Background mode: ensure tmux session exists, send command via base64 to avoid escaping issues
			const session = args.tmuxSession || "host-to-container";
			const b64 = Buffer.from(args.command).toString("base64");
			const script = [
				`tmux has-session -t '${session}' 2>/dev/null || tmux new-session -d -s '${session}'`,
				`tmux send-keys -t '${session}' -l "$(echo '${b64}' | base64 -d)"`,
				`tmux send-keys -t '${session}' Enter`,
			].join(" && ");

			await execInContainer({ projectPath, command: ["bash", "-c", script] });
			const result = {
				status: "started_in_background",
				tmuxSession: session,
				command: args.command,
				hint: `To check output, use this tool with command: tmux capture-pane -t '${session}' -p -S -50\nTo send input, use: tmux send-keys -t '${session}' 'your input' Enter\nTo stop the process, use: tmux send-keys -t '${session}' C-c`,
			};
			return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ errors: [{ message: (error as Error).message }] }, null, 2),
					},
				],
				isError: true,
			};
		}
	});
}
