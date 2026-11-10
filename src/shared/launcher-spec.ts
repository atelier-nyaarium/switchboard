// Each API server's launcher, for the build, the launch and the availability check.

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

////////////////////////////////
//  Constants

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
