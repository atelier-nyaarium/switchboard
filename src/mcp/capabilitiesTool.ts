import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Capability, unionCapabilities, VAULT_INSTRUCTIONS } from "../shared/capabilities.js";
import { ASSISTANT_CAPABILITIES, ASSISTANT_INSTRUCTIONS } from "./assistant/instructions.js";
import { readCapabilities } from "./capabilities.js";

/** Tool guidance, appended after the capability's own text. */
const TOOL_GUIDANCE: Record<string, string> = { vault: VAULT_INSTRUCTIONS };

////////////////////////////////
//  Schemas

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const capabilitiesSchema: any = z.object({}).strict();

////////////////////////////////
//  Functions & Helpers

const description = `
# Switchboard Capabilities

List capabilities enabled when this session started.

Call after receiving a channel message or compacting the session.
`.trim();

const assistantDescription = `
# Switchboard Capabilities

List the assistant's capabilities and its standing rules.

Call after receiving a channel message or compacting the session.
`.trim();

/** Ids only: instruction text is served from the startup snapshot either way. */
export function describeDrift(startup: Capability[], current: Capability[] | null): string | null {
	if (!current) return null;
	const before = new Set(startup.map((c) => c.id));
	const after = new Set(current.map((c) => c.id));
	const added = [...after].filter((id) => !before.has(id)).sort();
	const removed = [...before].filter((id) => !after.has(id)).sort();
	if (added.length === 0 && removed.length === 0) return null;

	const changes = [
		...added.map((id) => `${id} is now enabled`),
		...removed.map((id) => `${id} is no longer enabled`),
	].join(", ");
	return `Changed since this session started: ${changes}. A session's tool set is fixed at startup, so restart this session to pick that up.`;
}

// Silence must not read as "checked, unchanged".
const UNVERIFIED = `Could not confirm with the gateway whether this is still current.`;

export function renderCapabilities(startup: Capability[], current: Capability[] | null): string {
	const note = current === null ? UNVERIFIED : describeDrift(startup, current);
	if (startup.length === 0) {
		const lines = [`No Switchboard capabilities are enabled.`];
		if (note) lines.push("", note);
		return lines.join("\n");
	}

	const lines = [`Switchboard capabilities enabled at session start: ${startup.map((c) => c.id).join(", ")}`];
	if (note) lines.push("", note);
	lines.push("");
	for (const capability of startup) {
		const own = TOOL_GUIDANCE[capability.id];
		lines.push(
			`## ${capability.id}`,
			"",
			capability.instructions ?? (own ? "" : `This capability carries no guidance of its own.`),
			...(own ? ["", own] : []),
			"",
		);
	}
	return lines.join("\n").trimEnd();
}

/**
 * The assistant's answer: its own set, which its role fixes rather than its start. What the Gateway
 * enables is named as other sessions', so a list that grew since launch never reads as a restart away.
 */
export function renderAssistantCapabilities(gateway: Capability[] | null): string {
	const lines = [
		`Assistant capabilities: ${ASSISTANT_CAPABILITIES.map((c) => c.id).join(", ")}. This session's role fixes them, so a restart changes nothing.`,
	];
	if (gateway && gateway.length > 0) {
		const ids = gateway.map((c) => c.id).sort();
		lines.push("", `Enabled on this Gateway for other sessions, never this one: ${ids.join(", ")}.`);
	}
	for (const capability of ASSISTANT_CAPABILITIES) {
		lines.push("", `## ${capability.id}`, "", capability.tools.map((tool) => `\`${tool}\``).join(", "));
	}
	lines.push("", ASSISTANT_INSTRUCTIONS);
	return lines.join("\n");
}

// The startup snapshot answers, since it is what the tool set was gated on.
export function registerCapabilitiesTool(
	mcpServer: McpServer,
	capabilities: Capability[],
	options: { assistant?: boolean } = {},
): void {
	mcpServer.registerTool(
		"switchboard_capabilities",
		{
			title: `Switchboard Capabilities`,
			description: options.assistant ? assistantDescription : description,
			inputSchema: capabilitiesSchema,
		},
		async () => {
			const routerUrl = process.env.BRIDGE_ROUTER_URL;
			const bundle = routerUrl ? await readCapabilities(routerUrl) : null;
			// Incomplete is unverifiable, not a change: a silent source owns ids it did not report.
			const fresh = bundle && unionCapabilities(bundle);
			const current = fresh?.known ? fresh.capabilities : null;
			const text = options.assistant
				? renderAssistantCapabilities(current)
				: renderCapabilities(capabilities, current);
			return { content: [{ type: "text" as const, text }] };
		},
	);
}
