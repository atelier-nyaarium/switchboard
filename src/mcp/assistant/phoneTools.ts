import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	capabilityNeedsLine,
	PHONE_CAPABILITIES,
	PHONE_CAPABILITY_KEYS,
	PHONE_CAPABILITY_PATH,
	type PhoneCapabilityResult,
	PhoneCapabilityResultSchema,
} from "../../shared/schemasPhoneCapabilities.js";
import { RouterHttpError, routerPost } from "../bridge/helpers.js";

export function registerPhoneTools(mcpServer: McpServer): void {
	for (const key of PHONE_CAPABILITY_KEYS) {
		const declaration = PHONE_CAPABILITIES[key];
		mcpServer.registerTool(
			key,
			{
				title: declaration.label,
				description: `${declaration.describe}\n\n${capabilityNeedsLine(key)}`,
				inputSchema: declaration.request.shape,
			},
			async (params: Record<string, unknown>) => {
				let result: PhoneCapabilityResult;
				try {
					result = PhoneCapabilityResultSchema.parse(
						await routerPost(PHONE_CAPABILITY_PATH, { key, callId: randomUUID(), params }, { retries: 2 }),
					);
				} catch (error) {
					const status = error instanceof RouterHttpError ? error.status : null;
					const suffix = status === null ? "the Gateway may still be working" : `HTTP ${status}`;
					return {
						content: [
							{
								type: "text" as const,
								text: `Could not get a phone answer (${suffix}): ${(error as Error).message}`,
							},
						],
						isError: true,
					};
				}

				if (result.kind !== "ok") {
					const text =
						result.kind === "unavailable"
							? `Unavailable: ${result.reason}${result.needs?.length ? `; needs ${result.needs.join(", ")}` : ""}${result.detail ? `; ${result.detail}` : ""}`
							: result.kind === "refused"
								? `Refused: ${result.reason}`
								: result.kind === "not_assistant"
									? "This session is not the assistant."
									: "This session is not bound to the Gateway.";
					return { content: [{ type: "text" as const, text }], isError: true };
				}

				const answer = declaration.answer.safeParse(result.answer);
				if (!answer.success)
					return {
						content: [
							{ type: "text" as const, text: "The Gateway returned an answer this tool cannot read." },
						],
						isError: true,
					};
				return {
					content: [{ type: "text" as const, text: JSON.stringify(answer.data) }],
					...(result.recorded ? {} : { isError: true }),
				};
			},
		);
	}
}
