import { AGENT_BACKENDS, type AgentBackendId, agentEnvPrefix, agentFrameType } from "../../shared/agent-backend.js";
import type { AgentExecutionTarget, AgentResolvedTarget } from "../../shared/agent-execution-target.js";
import { agentWire } from "../../shared/agent-wire.js";
import type { HostAgentModelsResult } from "../../shared/host-op.js";
import type { AgentDriver } from "../agents/backendSession.js";
import { type AgentDaemonDeps, AgentDaemonService } from "./agentDaemonService.js";
import { ExecutionTargetManager, type TargetLogEvent, targetLogger } from "./agentTargets.js";

////////////////////////////////
//  Interfaces & Types

export interface AgentDaemonRuntimeDeps {
	/** One ID per process. */
	daemonInstanceId: string;
	/** Outbox replays relevant drops. */
	send(frame: Record<string, unknown>): void;
	resolveHostCwd(hint: string | undefined): string;
	drivers: Record<AgentBackendId, AgentDriver>;
	/** Before own child opens. */
	placeRuntime?(target: AgentResolvedTarget): Promise<void>;
	log?(backend: AgentBackendId): (event: TargetLogEvent) => void;
	baseEnv?: Record<string, string | undefined>;
	clock?: Pick<AgentDaemonDeps, "now" | "setSweep" | "clearSweep">;
}

export interface AgentDaemonRuntime {
	/** Hello precedes replay. */
	connected(): void;
	/** True for handled frames. */
	receive(frame: Record<string, unknown>): boolean;
	listModels(backend: AgentBackendId, target: AgentExecutionTarget): Promise<HostAgentModelsResult>;
	shutdown(): void;
}

////////////////////////////////
//  Functions & Helpers

/**
 * The daemon's agent side: a target manager and a service per backend.
 *
 * It lives as long as the process. A reconnect calls `connected` on the same runtime; a daemon
 * restart builds another under a new id.
 */
export function createAgentDaemonRuntime(deps: AgentDaemonRuntimeDeps): AgentDaemonRuntime {
	const bindings = AGENT_BACKENDS.map((descriptor) => {
		const driver = deps.drivers[descriptor.id];
		const targets = new ExecutionTargetManager({
			launcher: driver.launcher,
			log: deps.log?.(descriptor.id) ?? targetLogger(`${descriptor.id}-target`),
			envPrefix: agentEnvPrefix(descriptor.id),
			...(deps.clock?.now ? { now: deps.clock.now } : {}),
			...(deps.baseEnv ? { baseEnv: deps.baseEnv } : {}),
		});
		const service = new AgentDaemonService({
			backend: descriptor,
			targets,
			daemonInstanceId: deps.daemonInstanceId,
			send: deps.send,
			open: driver.open,
			resolveHostCwd: deps.resolveHostCwd,
			failureCode: driver.failureCode,
			threadsResumable: driver.threadsResumable,
			prepareTarget: driver.ownRuntime ? deps.placeRuntime : undefined,
			...deps.clock,
		});
		return {
			id: descriptor.id,
			targets,
			service,
			command: agentFrameType(descriptor.id, "command"),
			ack: agentFrameType(descriptor.id, "ack"),
			parseAck: agentWire(descriptor.id).ack,
		};
	});

	return {
		connected() {
			for (const { service } of bindings) {
				deps.send(service.hello());
				service.replay();
			}
		},
		receive(frame) {
			for (const binding of bindings) {
				if (frame.type === binding.command) {
					binding.service.handleCommand(frame);
					return true;
				}
				if (frame.type === binding.ack) {
					const ack = binding.parseAck.safeParse(frame);
					if (ack.success) binding.service.acknowledge(ack.data);
					return true;
				}
			}
			return false;
		},
		listModels(backend, target) {
			const binding = bindings.find((candidate) => candidate.id === backend);
			return binding
				? binding.service.listModels(target)
				: Promise.resolve({ kind: "refused", reason: `no ${backend} daemon` });
		},
		shutdown() {
			for (const { service, targets } of bindings) {
				service.shutdown();
				targets.shutdown();
			}
		},
	};
}
