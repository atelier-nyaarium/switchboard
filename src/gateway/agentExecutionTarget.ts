import { type AgentExecutionTarget, AgentExecutionTargetSchema } from "../shared/agent-execution-target.js";
import { isHostSpawn } from "../shared/host-spawn.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";

/** Where an owner's agent runs. Null for an uncatalogued container. */
export function resolveAgentExecutionTarget(
	owner: SessionRecord,
	cwd: string | undefined,
	sessionStore: Pick<SessionStore, "hostWorkdirHint">,
	offlineCatalog: ReadonlyMap<string, string>,
): AgentExecutionTarget | null {
	let target: AgentExecutionTarget;
	if (isHostSpawn(owner.spawn)) {
		target = { kind: "host", workdirHint: cwd ?? sessionStore.hostWorkdirHint(owner) };
	} else {
		const hostProjectPath = offlineCatalog.get(owner.spawn);
		if (!hostProjectPath) return null;
		target = { kind: "devcontainer", project: owner.spawn, hostProjectPath };
	}
	const validated = AgentExecutionTargetSchema.safeParse(target);
	return validated.success ? validated.data : null;
}
