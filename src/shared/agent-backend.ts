// The delegated-agent backend registry: which second-model backends exist, and every name derived
// from a backend's id. Sole source of the capability id, enable switch, env prefix, HTTP path, wire
// frame types and tool prefix, so the layers that read them cannot disagree on a spelling. A pure
// leaf: no imports, readable by the MCP, the gateway and the daemon alike.

////////////////////////////////
//  Interfaces & Types

export type AgentBackendId = "codex" | "copilot";

/** Descriptors contain data only. */
export interface AgentBackendDescriptor {
	readonly id: AgentBackendId;
	readonly displayName: string;
	/** The executable that must be on PATH for this backend to run. Its presence IS the switch: both
	 * the daemon's declaration and the plugin's tool gate probe for it, so installing the CLI is the
	 * whole opt-in. */
	readonly binaryName: string;
	/** Under the Gateway idle timeout. */
	readonly waitBudgetMs: number;
	readonly defaultModel: string;
	readonly options: { readonly serviceTier: boolean; readonly reasoningEffort: boolean };
	readonly legacyModellessStart?: "trailing-separator";
}

export type AgentFrameKind = "command" | "receipt" | "event" | "ack" | "hello";

////////////////////////////////
//  Functions & Helpers

export const AGENT_WAIT_BUDGET_MS = 240_000;

export const CODEX_BACKEND: AgentBackendDescriptor & { id: "codex" } = {
	id: "codex",
	displayName: "Codex",
	binaryName: "codex",
	waitBudgetMs: AGENT_WAIT_BUDGET_MS,
	defaultModel: "gpt-6-luna",
	options: { serviceTier: true, reasoningEffort: false },
};

export const COPILOT_BACKEND: AgentBackendDescriptor & { id: "copilot" } = {
	id: "copilot",
	displayName: "Copilot",
	binaryName: "copilot",
	waitBudgetMs: AGENT_WAIT_BUDGET_MS,
	defaultModel: "gpt-6-luna",
	options: { serviceTier: false, reasoningEffort: true },
	legacyModellessStart: "trailing-separator",
};

/** Every id needs its own row, or this does not compile. */
const BACKEND_ROWS: { readonly [Id in AgentBackendId]: AgentBackendDescriptor & { id: Id } } = {
	codex: CODEX_BACKEND,
	copilot: COPILOT_BACKEND,
};

export const AGENT_BACKEND_IDS = Object.keys(BACKEND_ROWS) as [AgentBackendId, ...AgentBackendId[]];

export const AGENT_BACKENDS: readonly AgentBackendDescriptor[] = Object.values(BACKEND_ROWS);

/** A workflow step also runs on `claude -p`, which is no agent backend. */
export const WORKFLOW_BACKEND_IDS = [...AGENT_BACKEND_IDS, "claude"] as [
	AgentBackendId | "claude",
	...(AgentBackendId | "claude")[],
];

// FIXME: Codex joins when it takes the generic stack, and this list goes.
export const GENERIC_AGENT_BACKENDS: readonly AgentBackendDescriptor[] = AGENT_BACKENDS.filter(
	(backend) => backend.id !== "codex",
);

export function agentBackend(id: AgentBackendId): AgentBackendDescriptor {
	return BACKEND_ROWS[id];
}

export function agentIdPattern(id: AgentBackendId): RegExp {
	return new RegExp(`^${id}_[0-9a-f]{32}$`);
}

export function agentBackendOf(agentId: string): AgentBackendId | undefined {
	return AGENT_BACKENDS.find((backend) => agentIdPattern(backend.id).test(agentId))?.id;
}

export function agentCapabilityId<Id extends AgentBackendId>(id: Id): `${Id}-agent` {
	return `${id}-agent`;
}

/** Backend env prefixes bypass child-env scrubbing. */
export function agentEnvPrefix(id: AgentBackendId): string {
	return `${id.toUpperCase()}_`;
}

export function agentHttpPath(id: AgentBackendId): string {
	return `/${id}`;
}

export function agentFrameType(id: AgentBackendId, kind: AgentFrameKind): string {
	return `${id}_${kind}`;
}

export function agentInboundFrameTypes(id: AgentBackendId): ReadonlySet<string> {
	return new Set([agentFrameType(id, "hello"), agentFrameType(id, "receipt"), agentFrameType(id, "event")]);
}
