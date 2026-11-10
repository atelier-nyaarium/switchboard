import { describe, expect, it, vi } from "vitest";
import { type PluginProfile, pluginProfile, resolvePluginCli } from "../mcp/sessionCli.js";
import { SESSION_HARNESSES, type SessionHarness } from "../shared/session-harness.js";

describe("resolving the plugin's CLI", () => {
	it("takes the env word without asking the detector", () => {
		const detect = vi.fn(() => "claude");

		const cli = resolvePluginCli({ AGENT_TYPE: "copilot" }, detect);

		expect(cli).toEqual({ agentType: "copilot", profile: pluginProfile("copilot") });
		expect(detect).not.toHaveBeenCalled();
	});

	it("asks the detector once when the env names none", () => {
		const detect = vi.fn(() => "copilot");

		expect(resolvePluginCli({}, detect)).toEqual({ agentType: "copilot", profile: pluginProfile("copilot") });
		expect(resolvePluginCli({ AGENT_TYPE: "" }, detect).agentType).toBe("copilot");
		expect(detect).toHaveBeenCalledTimes(2);
	});
});

describe("a session CLI's profile", () => {
	const PROFILES: Record<SessionHarness, Omit<PluginProfile, "harness">> = {
		claude: {
			answersHandshake: true,
			delivery: "channel",
			apiServer: null,
			channelCapability: true,
			instructions: "handshake",
			claudeSlashTools: true,
			workflowTools: true,
		},
		opencode: {
			answersHandshake: false,
			delivery: "api",
			apiServer: "opencode",
			channelCapability: false,
			instructions: "whole",
			claudeSlashTools: false,
			workflowTools: true,
		},
		copilot: {
			answersHandshake: false,
			delivery: "typed",
			apiServer: null,
			channelCapability: false,
			instructions: "whole",
			claudeSlashTools: false,
			workflowTools: true,
		},
	};

	it.each(SESSION_HARNESSES)("%s gets its own road in and its own tools", (harness) => {
		expect(pluginProfile(harness)).toEqual({ harness, ...PROFILES[harness] });
	});
});

describe("a CLI with no row", () => {
	it.each(["cursor", "codex", "no-such-cli"])("%s gets the other-agent answers", (agentType) => {
		expect(resolvePluginCli({ AGENT_TYPE: agentType }, () => "claude")).toEqual({
			agentType,
			profile: {
				harness: null,
				answersHandshake: true,
				delivery: "none",
				apiServer: null,
				channelCapability: false,
				instructions: "none",
				claudeSlashTools: true,
				workflowTools: false,
			},
		});
	});
});
