// The OpenCode bridge as an agent child, on the host or inside a container.

import { spawn } from "node:child_process";
import packageJson from "../../../package.json";
import { agentEnvPrefix } from "../../shared/agent-backend.js";
import { parseAgentTargetId } from "../../shared/agent-execution-target.js";
import { AGENT_BRIDGES, bundledEntryArgs } from "../../shared/launcher-spec.js";
import { moduleDir, packageRoot } from "../../shared/plugin-root.js";
import { type AgentChild, adoptProcess, containerEnvArgs, type ExecutionTargetLauncher } from "./agentTargets.js";
import { CONTAINER_BUN, containerRuntimeRoot } from "./containerSite.js";
import { containerFor } from "./containers.js";

////////////////////////////////
//  Constants

const BRIDGE = AGENT_BRIDGES.opencode;

////////////////////////////////
//  Functions & Helpers

function spawnBridge(command: string, args: string[], env?: Record<string, string>): AgentChild {
	return adoptProcess(spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] }));
}

export const opencodeLauncher: ExecutionTargetLauncher = {
	launch(target, env) {
		switch (target.kind) {
			case "host": {
				if (parseAgentTargetId(target.targetId)?.kind !== "host") {
					throw Object.assign(new Error("target is not a host id"), { code: "badTarget" });
				}
				const root = packageRoot(moduleDir(import.meta.url));
				return spawnBridge(process.execPath, bundledEntryArgs(root, BRIDGE.bundle), env);
			}
			case "devcontainer": {
				const parsed = parseAgentTargetId(target.targetId);
				if (parsed?.kind !== "devcontainer") {
					throw Object.assign(new Error("target is not a container id"), { code: "badTarget" });
				}
				// The daemon places this runtime before a launch.
				const root = containerRuntimeRoot(packageJson.version);
				return spawnBridge("docker", [
					"exec",
					"-i",
					"-u",
					"vscode",
					"-w",
					`/workspace/${parsed.project}`,
					...containerEnvArgs(env, agentEnvPrefix("opencode")),
					containerFor(parsed.project),
					CONTAINER_BUN,
					...bundledEntryArgs(root, BRIDGE.bundle),
				]);
			}
			default:
				throw Object.assign(new Error("unknown execution target kind"), { code: "badTarget" });
		}
	},
};
