import type { AgentBackendId } from "../../shared/agent-backend.js";
import { codexLauncher } from "../devcontainer/codexTargets.js";
import { copilotLauncher } from "../devcontainer/copilotTargets.js";
import { opencodeLauncher } from "../devcontainer/opencodeTargets.js";
import type { AgentDriver } from "./backendSession.js";
import { CodexBackendSession } from "./codexSession.js";
import { CopilotBackendSession, copilotFailureCode } from "./copilotSession.js";
import { OpencodeBackendSession, opencodeFailureCode } from "./opencodeSession.js";

/** Backend rows require drivers. */
export const AGENT_DRIVERS: Record<AgentBackendId, AgentDriver> = {
	codex: {
		launcher: codexLauncher,
		open: (child) => CodexBackendSession.open(child),
		threadsResumable: true,
	},
	copilot: {
		launcher: copilotLauncher,
		open: (child) => CopilotBackendSession.open(child),
		// Child owns session lifetime.
		threadsResumable: false,
		failureCode: copilotFailureCode,
	},
	opencode: {
		launcher: opencodeLauncher,
		open: (child) => OpencodeBackendSession.open(child),
		// OpenCode keeps sessions in its own database.
		threadsResumable: true,
		failureCode: opencodeFailureCode,
		ownRuntime: true,
	},
};
