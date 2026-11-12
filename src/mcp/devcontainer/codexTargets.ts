import { spawn } from "node:child_process";
import { agentEnvPrefix } from "../../shared/agent-backend.js";
import { parseAgentTargetId } from "../../shared/agent-execution-target.js";
import { adoptProcess, containerEnvArgs, type ExecutionTargetLauncher } from "./agentTargets.js";
import { containerFor } from "./containers.js";

////////////////////////////////
//  Functions & Helpers

// Parsed through the shared grammar, so it cannot drift.
function containerProject(targetId: string): string {
	const parsed = parseAgentTargetId(targetId);
	if (parsed?.kind !== "devcontainer") {
		throw Object.assign(new Error(`target is not a container id`), { code: "badTarget" });
	}
	return parsed.project;
}

/** `docker exec -i`; `devcontainer exec` buffers. No workdir, or a target splits into children. */
export const codexLauncher: ExecutionTargetLauncher = {
	launch(target, env) {
		switch (target.kind) {
			case "devcontainer": {
				const project = containerProject(target.targetId);
				const args = [
					"exec",
					"-i",
					"-u",
					"vscode",
					"-w",
					`/workspace/${project}`,
					...containerEnvArgs(env, agentEnvPrefix("codex")),
					containerFor(project),
					"codex",
					"app-server",
				];
				return adoptProcess(spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] }));
			}
			case "host": {
				// A container-shaped id with kind "host" would run under the daemon's own user.
				if (parseAgentTargetId(target.targetId)?.kind !== "host") {
					throw Object.assign(new Error(`target is not a host id`), { code: "badTarget" });
				}
				return adoptProcess(spawn("codex", ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] }));
			}
			default:
				// Never fall through to the unsandboxed host spawn.
				throw Object.assign(new Error(`unknown execution target kind`), { code: "badTarget" });
		}
	},
};
