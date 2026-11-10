// What the plugin's own CLI gets.

import { HARNESS, type HarnessRow, isSessionHarness, type SessionHarness } from "../shared/session-harness.js";

////////////////////////////////
//  Interfaces & Types

export interface PluginProfile {
	/** Named on the register frame. */
	readonly harness: SessionHarness | null;
	/** Auto-answers a repeat handshake. */
	readonly answersHandshake: boolean;
	/** How a pushed row enters. */
	readonly delivery: HarnessRow["delivery"] | "none";
	/** Declares Claude's channel capability. */
	readonly channelCapability: boolean;
	/** `whole` carries the capability guidance. */
	readonly instructions: "handshake" | "whole" | "none";
	readonly claudeSlashTools: boolean;
	readonly workflowTools: boolean;
}

export interface PluginCli {
	readonly agentType: string;
	readonly profile: PluginProfile;
}

////////////////////////////////
//  Constants

const CHANNEL_CAPABILITY: Record<HarnessRow["delivery"], boolean> = { channel: true, typed: false };

const INSTRUCTIONS: Record<HarnessRow["guidance"], PluginProfile["instructions"]> = {
	handshake: "handshake",
	instructions: "whole",
};

/** A CLI with no row. */
export const OTHER_AGENT: PluginProfile = {
	harness: null,
	answersHandshake: true,
	delivery: "none",
	channelCapability: false,
	instructions: "none",
	claudeSlashTools: true,
	workflowTools: false,
};

////////////////////////////////
//  Functions & Helpers

function sessionProfile(harness: SessionHarness): PluginProfile {
	const row = HARNESS[harness];
	return {
		harness,
		answersHandshake: row.handshake,
		delivery: row.delivery,
		channelCapability: CHANNEL_CAPABILITY[row.delivery],
		instructions: INSTRUCTIONS[row.guidance],
		claudeSlashTools: row.claudeSlashTools,
		workflowTools: row.workflowTools,
	};
}

export function pluginProfile(agentType: string): PluginProfile {
	return isSessionHarness(agentType) ? sessionProfile(agentType) : OTHER_AGENT;
}

/** `detect` runs only unnamed. */
export function resolvePluginCli(env: Readonly<Record<string, string | undefined>>, detect: () => string): PluginCli {
	const agentType = env.AGENT_TYPE || detect();
	return { agentType, profile: pluginProfile(agentType) };
}
