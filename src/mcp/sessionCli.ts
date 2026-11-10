// What the plugin's own CLI gets.

import {
	type ApiRoad,
	deliveryOf,
	HARNESS,
	type HarnessRow,
	isSessionHarness,
	type SessionDelivery,
	type SessionHarness,
} from "../shared/session-harness.js";

////////////////////////////////
//  Interfaces & Types

export interface PluginProfile {
	/** Named on the register frame. */
	readonly harness: SessionHarness | null;
	/** Auto-answers a repeat handshake. */
	readonly answersHandshake: boolean;
	/** How a pushed row enters. */
	readonly delivery: SessionDelivery | "none";
	/** The CLI's own server, when the plugin drives it. */
	readonly apiServer: ApiRoad["server"] | null;
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

const CHANNEL_CAPABILITY: Record<SessionDelivery, boolean> = { channel: true, typed: false, api: false };

const INSTRUCTIONS: Record<HarnessRow["guidance"], PluginProfile["instructions"]> = {
	handshake: "handshake",
	instructions: "whole",
};

/** A CLI with no row. */
export const OTHER_AGENT: PluginProfile = {
	harness: null,
	answersHandshake: true,
	delivery: "none",
	apiServer: null,
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
		delivery: deliveryOf(harness),
		apiServer: row.road.kind === "api" ? row.road.server : null,
		channelCapability: CHANNEL_CAPABILITY[deliveryOf(harness)],
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
