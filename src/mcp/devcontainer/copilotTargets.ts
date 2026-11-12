import { spawn } from "node:child_process";
import { agentEnvPrefix } from "../../shared/agent-backend.js";
import { parseAgentTargetId } from "../../shared/agent-execution-target.js";
import { type AgentChild, adoptProcess, containerEnvArgs, type ExecutionTargetLauncher } from "./agentTargets.js";
import { containerFor } from "./containers.js";

export const copilotLauncher: ExecutionTargetLauncher = {
	launch(target, env) {
		switch (target.kind) {
			case "devcontainer": {
				const parsed = parseAgentTargetId(target.targetId);
				if (parsed?.kind !== "devcontainer")
					throw Object.assign(new Error(`target is not a container id`), { code: "badTarget" });
				return spawnCopilot([
					"docker",
					"exec",
					"-i",
					"-u",
					"vscode",
					"-w",
					`/workspace/${parsed.project}`,
					...containerEnvArgs(env, agentEnvPrefix("copilot")),
					containerFor(parsed.project),
					"copilot",
					"--headless",
					"--stdio",
				]);
			}
			case "host":
				if (parseAgentTargetId(target.targetId)?.kind !== "host") {
					throw Object.assign(new Error(`target is not a host id`), { code: "badTarget" });
				}
				return spawnCopilot(["copilot", "--headless", "--stdio"], env);
			default:
				throw Object.assign(new Error(`unknown execution target kind`), { code: "badTarget" });
		}
	},
};

function spawnCopilot(args: string[], env?: Record<string, string>): AgentChild {
	const [command, ...argv] = args;
	return adoptProcess(spawn(command!, argv, { env, stdio: ["pipe", "pipe", "pipe"] }), (stderr) =>
		/authentication|required|login/i.test(stderr) ? "authFailed" : undefined,
	);
}
