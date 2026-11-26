import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LiveConsoleAnswer } from "../../shared/schemasLiveConsole.js";
import { SESSION_COMMANDS } from "../../shared/session-commands.js";
import { RouterHttpError, routerPost } from "../bridge/helpers.js";

const COMMAND = SESSION_COMMANDS.console;
const UNREADABLE = "The Gateway's answer was unreadable.";

const DESCRIPTION = `
# Console

Read this Gateway's live state with a small expression language. Read-only: nothing here changes anything.

Call it with no \`expr\` first. It lists every entity, its members and their signatures.

Examples:
- \`sensors.list\`
- \`sensors.read("Outside thermometer").readings\`
- \`automations.log.take(5)\`
- \`automations.list\`
- \`definitions.decode("govee-h5110", sensors.payloads("Freezer")[0])\`

Several statements: separate them with \`;\`. \`name = expression\` saves a result for the rest of the call, and every other statement prints in order:
- \`out = sensors.read("Outside thermometer"); out.readings; sensors.extremes("Outside thermometer", "temperature")\`

A list shows 50 items, and a cut says how to \`.skip(n)\` past them. An error points a caret at the part it means.
`.trim();

export function consoleTextOf(answer: LiveConsoleAnswer): { text: string; isError: boolean } {
	switch (answer.kind) {
		case "ok":
			return { text: answer.text, isError: false };
		case "error":
			return { text: answer.text, isError: true };
		case "unauthenticated":
			return { text: "This session is not bound to the Gateway.", isError: true };
		case "not_served":
			return { text: "The console serves host sessions only.", isError: true };
	}
}

export function registerConsoleTool(mcpServer: McpServer): void {
	mcpServer.registerTool(
		COMMAND.tool,
		{ title: "Console", description: DESCRIPTION, inputSchema: COMMAND.request },
		async (args: { expr?: string; limit?: number }) => {
			const refused = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
			let raw: unknown;
			try {
				raw = await routerPost(
					COMMAND.path,
					{
						...(args.expr === undefined ? {} : { expr: args.expr }),
						...(args.limit === undefined ? {} : { limit: args.limit }),
					},
					{ retries: 0 },
				);
			} catch (error) {
				if (!(error instanceof RouterHttpError))
					return refused(`Could not reach the Gateway: ${(error as Error).message}`);
				if (error.status === 404)
					return refused("This Gateway does not serve the console yet. Restart it on a newer build.");
				return refused(error.status < 300 ? UNREADABLE : `The Gateway refused the read: ${error.message}`);
			}
			const parsed = COMMAND.answer.safeParse(raw);
			if (!parsed.success) return refused(UNREADABLE);
			const { text, isError } = consoleTextOf(parsed.data as LiveConsoleAnswer);
			return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
		},
	);
}
