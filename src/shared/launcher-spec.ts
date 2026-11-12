// Each API server's launcher, for the build, the launch and the availability check.

import type { AgentBackendId } from "./agent-backend.js";
import type { ApiRoad } from "./session-harness.js";

////////////////////////////////
//  Interfaces & Types

export interface LauncherArgs {
	sessionId: string;
	statusFile: string;
	greet: boolean;
}

export interface LauncherSpec {
	/** Source entry. */
	entry: string;
	/** Under `dist/`. */
	bundle: string;
	argv(args: LauncherArgs): string[];
}

/** An agent driver's own child. */
export interface BridgeSpec {
	/** Source entry. */
	entry: string;
	/** Under `dist/`. */
	bundle: string;
}

////////////////////////////////
//  Constants

/** A driver whose child is this build's own entry point. */
export const AGENT_BRIDGES = {
	opencode: { entry: "src/main-opencode-agent.ts", bundle: "main-opencode-agent.js" },
} satisfies Partial<Record<AgentBackendId, BridgeSpec>>;

////////////////////////////////
//  Functions & Helpers

/** A bundled entry's bun arguments: a project's bun settings and env never apply. */
export function bundledEntryArgs(root: string, bundle: string): string[] {
	return [`--config=${root}/launch/bunfig.toml`, "--no-env-file", "--no-install", `${root}/dist/${bundle}`];
}

export const LAUNCHERS: Record<ApiRoad["server"], LauncherSpec> = {
	opencode: {
		entry: "src/main-opencode-launch.ts",
		bundle: "main-opencode-launch.js",
		argv: ({ sessionId, statusFile, greet }) => [
			"--session",
			sessionId,
			"--status",
			statusFile,
			...(greet ? ["--greet"] : []),
		],
	},
};
