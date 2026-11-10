// The phone's Start and Stop of a dev container.

import type { ConsoleOp } from "../../shared/console-protocol.js";
import type { HostOp, HostOpResult } from "../../shared/host-op.js";
import { isHostSpawn } from "../../shared/host-spawn.js";
import type { ConsoleTargets } from "./consoleTargets.js";

////////////////////////////////
//  Interfaces & Types

export interface ContainerHandlersDeps {
	targets: Pick<ConsoleTargets, "localSpawn">;
	relayToHost?: (op: HostOp) => Promise<HostOpResult>;
}

type ContainerOp = Extract<ConsoleOp, { kind: "container_start" | "container_stop" }>;

////////////////////////////////
//  Functions & Helpers

/** Each answers once queued; how it went rides the container state. */
export function createContainerHandlers({ targets, relayToHost }: ContainerHandlersDeps) {
	async function relay(op: ContainerOp, conversationId: string, opId: string): Promise<{ accepted: true }> {
		if (!relayToHost) throw new Error("the host daemon is unavailable on this Gateway");
		const project = targets.localSpawn(op.target);
		if (isHostSpawn(project)) throw new Error(`"${project}" is a host shell, not a dev container`);
		const result = await relayToHost({
			kind: op.kind === "container_start" ? "containerStart" : "containerStop",
			project,
			dedupKey: `${conversationId}:${opId}`,
		});
		if (!result.ok) throw new Error(result.error ?? "the host daemon refused it");
		return { accepted: true };
	}

	return { relay };
}
