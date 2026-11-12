// The OpenCode bridge as an agent child, on the host or inside a container.

import { spawn } from "node:child_process";
import packageJson from "../../../package.json";
import { agentEnvPrefix } from "../../shared/agent-backend.js";
import { parseAgentTargetId } from "../../shared/agent-execution-target.js";
import { AGENT_BRIDGES, bundledEntryArgs } from "../../shared/launcher-spec.js";
import { moduleDir, packageRoot } from "../../shared/plugin-root.js";
import {
	type AgentChild,
	classifyAgentStderr,
	containerEnvArgs,
	type ExecutionTargetLauncher,
} from "./codexTargets.js";
import { CONTAINER_BUN, containerRuntimeRoot } from "./containerSite.js";
import { containerFor } from "./containers.js";

////////////////////////////////
//  Constants

const BRIDGE = AGENT_BRIDGES.opencode;

////////////////////////////////
//  Functions & Helpers

function spawnBridge(command: string, args: string[], env?: Record<string, string>): AgentChild {
	const proc = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	proc.stderr?.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-2_000);
	});
	proc.stdin?.on("error", () => {});
	proc.stdout?.on("error", () => {});
	proc.stderr?.on("error", () => {});
	return {
		stdin: proc.stdin!,
		stdout: proc.stdout!,
		kill: () => proc.kill(),
		onExit(listener) {
			const fire = (code: number | null, signal: string | null) => {
				listener({ code, signal, reason: classifyAgentStderr(stderr) });
			};
			proc.once("exit", (code, signal) => fire(code, signal));
			proc.once("error", () => fire(null, null));
		},
	};
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
