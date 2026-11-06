import type { ServerWebSocket } from "bun";
import type { AgentExecutionTarget } from "../shared/agent-execution-target.js";
import type { WsData } from "./wsTypes.js";

export interface HostLiveness {
	socket: ServerWebSocket<WsData> | undefined;
	daemonInstanceId: string | undefined;
	containerInCatalog: (target: AgentExecutionTarget) => boolean;
}

export type HostLivenessReader = () => HostLiveness;
