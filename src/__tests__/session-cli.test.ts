import { describe, expect, it, vi } from "vitest";
import { pluginProfile, resolvePluginCli } from "../mcp/sessionCli.js";
import { HARNESS, SESSION_HARNESSES } from "../shared/session-harness.js";

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
	it.each(SESSION_HARNESSES)("%s answers what its row says", (harness) => {
		const row = HARNESS[harness];

		expect(pluginProfile(harness)).toEqual({
			harness,
			answersHandshake: row.handshake,
			delivery: row.delivery,
			channelCapability: row.delivery === "channel",
			instructions: row.guidance === "handshake" ? "handshake" : "whole",
			claudeSlashTools: row.claudeSlashTools,
			workflowTools: row.workflowTools,
		});
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
				channelCapability: false,
				instructions: "none",
				claudeSlashTools: true,
				workflowTools: false,
			},
		});
	});
});
