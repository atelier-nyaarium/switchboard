import crypto from "node:crypto";
import { z } from "zod";
import type { AgentBackendId } from "./agent-backend.js";

////////////////////////////////
//  Bounds

export const AGENT_PROMPT_MAX_BYTES = 256 * 1024;
export const AGENT_ACTIVITY_MAX_BYTES = 16 * 1024;
export const AGENT_ACTIVITY_MAX_ITEMS = 32;
export const AGENT_ERROR_MAX_BYTES = 16 * 1024;
export const AGENT_TURN_LOST_REASON = "turn lost: its agent process ended";
export const AGENT_TURN_UNACCOUNTED_REASON = "turn lost: its daemon could not account for it";

////////////////////////////////
//  Interfaces & Types

export interface AgentActivityView {
	kind: "commentary" | "truncated";
	itemId?: string;
}

export interface AgentTurnHistoryView {
	agentState: string;
	activeTurnId?: string;
	turns: ReadonlyArray<{ id: string; state: string; updatedAt: number }>;
	createdAt: number;
	updatedAt: number;
}

export type AgentStoredActivity =
	| { kind: "commentary"; itemId: string; text: string }
	| { kind: "truncated"; omitted: number };

/** Replay decisions use every field. */
export interface AgentReplayOperation {
	operationId: string;
	fingerprint: string;
	state: string;
	/** Unfenced acceptances cannot be replayed. */
	acceptanceUnverified?: boolean;
}

export interface AgentReplayHolder<Operation extends AgentReplayOperation> {
	operations: readonly Operation[];
}

export type AgentReplayOutcome<Agent, Operation> =
	| { kind: "none" }
	| { kind: "conflict"; reason: string }
	| { kind: "match"; agent: Agent; operation: Operation; replayable: boolean };

////////////////////////////////
//  Functions & Helpers

export const AGENT_OUTPUT_SCHEMA_MAX_BYTES = 32 * 1024;

/** Callers validate provider-constrained answers. */
export const AgentOutputSchemaSchema = z
	.record(z.string(), z.unknown())
	.refine((schema) => new TextEncoder().encode(JSON.stringify(schema)).byteLength <= AGENT_OUTPUT_SCHEMA_MAX_BYTES, {
		message: `output schema must be at most ${AGENT_OUTPUT_SCHEMA_MAX_BYTES} UTF-8 bytes`,
	});

export function boundedUtf8(maxBytes: number, name: string) {
	return z.string().refine((value) => new TextEncoder().encode(value).byteLength <= maxBytes, {
		message: `${name} must be at most ${maxBytes} UTF-8 bytes`,
	});
}

export function sanitizeAgentErrorText(raw: string, maxBytes: number): string {
	const normalized = raw
		.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return cutUtf8(normalized, maxBytes).trimEnd();
}

export function cutUtf8(text: string, maxBytes: number): string {
	const encoder = new TextEncoder();
	if (encoder.encode(text).byteLength <= maxBytes) return text;
	let result = "";
	let bytes = 0;
	for (const character of text) {
		const characterBytes = encoder.encode(character).byteLength;
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

/** Derived from the operation id, so a start's retry names the same agent. The domain tag is each backend's stored literal. */
export function agentIdForOperation(backendId: AgentBackendId, operationId: string): string {
	const digest = crypto
		.createHash("sha256")
		.update(`${backendId.toUpperCase()}_AGENT_V1\n${operationId}`)
		.digest("hex");
	return `${backendId}_${digest.slice(0, 32)}`;
}

export function agentOperationFingerprint(
	kind: "start" | "message" | "stop",
	agentId: string,
	prompt?: string,
): string {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify([kind, agentId, prompt ?? null]))
		.digest("hex");
}

/** Fingerprints include the requested model. */
export interface AgentOperationIdentity {
	kind: "start" | "message" | "stop";
	agentId: string;
	prompt?: string;
	/** Start operations only. */
	model?: string;
	/** Copilot legacy fingerprints include a trailing separator. */
	legacyModellessStart?: "trailing-separator";
}

/** Legacy model-less starts can be unverifiable. */
export type AgentFingerprintVerdict = "match" | "mismatch" | "unverifiable";

/** Omit absent models to preserve legacy fingerprints. */
export function agentOperationFingerprintOf(identity: AgentOperationIdentity): string {
	if (identity.kind === "start") {
		const input = identity.model === undefined ? identity.prompt : `${identity.prompt ?? ""}\n${identity.model}`;
		return agentOperationFingerprint("start", identity.agentId, input);
	}
	if (identity.kind === "message") return agentOperationFingerprint("message", identity.agentId, identity.prompt);
	return agentOperationFingerprint("stop", identity.agentId);
}

/** Legacy tolerance applies only without a stored model. */
export function agentFingerprintVerdict(stored: string, identity: AgentOperationIdentity): AgentFingerprintVerdict {
	if (stored === agentOperationFingerprintOf(identity)) return "match";
	if (identity.kind !== "start" || identity.model !== undefined) return "mismatch";
	if (identity.legacyModellessStart !== "trailing-separator") return "mismatch";
	// The legacy spelling, recomputed exactly.
	if (stored === agentOperationFingerprint("start", identity.agentId, `${identity.prompt ?? ""}\n`)) return "match";
	// Nothing left to recompute from. Not a mismatch: that would drop the agent.
	return "unverifiable";
}

/** Markers require full windows, and stored item IDs must be unique. */
export function agentActivityIssues(activities: ReadonlyArray<AgentActivityView>, maxItems: number): string[] {
	const issues: string[] = [];
	const commentary = activities.filter((activity) => activity.kind === "commentary");
	const markerIndexes = activities.flatMap((activity, index) => (activity.kind === "truncated" ? [index] : []));
	if (commentary.length > maxItems) issues.push("too many commentary activities");
	const withItemIds = commentary.flatMap((activity) => (activity.itemId === undefined ? [] : [activity.itemId]));
	if (new Set(withItemIds).size !== withItemIds.length) issues.push("stored activity item IDs must be unique");
	if (markerIndexes.length > 1 || (markerIndexes.length === 1 && markerIndexes[0] !== activities.length - 1)) {
		issues.push("the truncation marker must appear once at the end");
	}
	if (markerIndexes.length === 1 && commentary.length !== maxItems) {
		issues.push("truncation requires a full retained activity window");
	}
	return issues;
}

/** Retain newest items and count omissions. */
export function appendAgentActivity(
	existing: readonly AgentStoredActivity[],
	itemId: string,
	text: string,
	maxItems: number,
): AgentStoredActivity[] | null {
	const commentary = existing.filter((activity) => activity.kind === "commentary");
	if (commentary.some((activity) => activity.itemId === itemId)) return null;
	if (commentary.length < maxItems) return [...commentary, { kind: "commentary", itemId, text }];
	const omitted = existing.find((activity) => activity.kind === "truncated")?.omitted ?? 0;
	return [
		...commentary.slice(commentary.length - maxItems + 1),
		{ kind: "commentary", itemId, text },
		{ kind: "truncated", omitted: omitted + commentary.length - maxItems + 1 },
	];
}

/** Item IDs remain internal to daemon deduplication. */
export function publishedActivities(
	stored: readonly AgentStoredActivity[] | undefined,
): Array<{ kind: "commentary"; text: string } | { kind: "truncated"; omitted: number }> {
	return (stored ?? []).map((activity) =>
		activity.kind === "commentary" ? { kind: activity.kind, text: activity.text } : activity,
	);
}

/** Replays only an accepted, fenced operation on a durable catalog. `ensureDurable` may flush, so it runs last. */
export function agentOperationReplayable(operation: AgentReplayOperation, ensureDurable: () => boolean): boolean {
	if (operation.state !== "accepted") return false;
	if (operation.acceptanceUnverified) return false;
	return ensureDurable();
}

/** Ambiguous IDs and mismatched fingerprints conflict. */
export function resolveAgentReplay<Agent extends AgentReplayHolder<AgentReplayOperation>>(
	agents: readonly Agent[],
	operationId: string,
	identity: AgentOperationIdentity,
	ensureDurable: () => boolean,
): AgentReplayOutcome<Agent, Agent["operations"][number]> {
	const matches = agents.flatMap((agent) =>
		agent.operations.flatMap((operation) => (operation.operationId === operationId ? [{ agent, operation }] : [])),
	);
	if (matches.length === 0) return { kind: "none" };
	if (matches.length > 1) return { kind: "conflict", reason: "operation ID was reused with different input" };
	const { agent, operation } = matches[0]!;
	// Unverifiable fingerprints cannot prove replay identity.
	if (agentFingerprintVerdict(operation.fingerprint, identity) !== "match")
		return { kind: "conflict", reason: "operation ID was reused with different input" };
	return { kind: "match", agent, operation, replayable: agentOperationReplayable(operation, ensureDurable) };
}

export function agentTurnHistoryIssues(view: AgentTurnHistoryView): string[] {
	const issues: string[] = [];
	if (view.updatedAt < view.createdAt) issues.push("agent update cannot predate creation");

	const activeTurns = view.activeTurnId ? view.turns.filter((turn) => turn.id === view.activeTurnId) : [];
	const inProgressTurns = view.turns.filter((turn) => turn.state === "inProgress");
	if (
		view.activeTurnId &&
		(activeTurns.length !== 1 || activeTurns[0]?.state !== "inProgress" || inProgressTurns.length !== 1)
	) {
		issues.push("active turn must resolve to one in-progress turn");
	}
	if (!view.activeTurnId && inProgressTurns.length > 0) {
		issues.push("an in-progress turn must be the active turn");
	}
	if (view.agentState === "working" && !view.activeTurnId) issues.push("working agent requires an active turn");
	if (view.agentState === "idle" && view.activeTurnId) issues.push("idle agent cannot retain an active turn");
	if (new Set(view.turns.map((turn) => turn.id)).size !== view.turns.length) {
		issues.push("turn IDs must be unique");
	}
	for (const turn of view.turns) {
		if (turn.updatedAt < view.createdAt || turn.updatedAt > view.updatedAt) {
			issues.push("turn timestamp is outside its agent lifetime");
		}
	}
	return issues;
}

/** Invalid entries drop alone. Duplicate IDs drop every claimant. */
export function restoreAgentCatalog<
	Agent extends { agentId: string; operations: ReadonlyArray<{ operationId: string }> },
>(
	raw: unknown,
	parseAgent: (candidate: unknown) => Agent | undefined,
): { version: 1; revision: number; agents: Agent[] } | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const envelope = raw as { version?: unknown; revision?: unknown; agents?: unknown };
	if (
		envelope.version !== 1 ||
		typeof envelope.revision !== "number" ||
		!Number.isInteger(envelope.revision) ||
		envelope.revision < 0 ||
		!Array.isArray(envelope.agents)
	)
		return undefined;

	const parsed = envelope.agents.flatMap((candidate) => {
		const agent = parseAgent(candidate);
		return agent === undefined ? [] : [agent];
	});
	const agentIdCounts = new Map<string, number>();
	const operationIdCounts = new Map<string, number>();
	for (const agent of parsed) {
		agentIdCounts.set(agent.agentId, (agentIdCounts.get(agent.agentId) ?? 0) + 1);
		for (const operation of agent.operations) {
			operationIdCounts.set(operation.operationId, (operationIdCounts.get(operation.operationId) ?? 0) + 1);
		}
	}
	const agents = parsed.filter(
		(agent) =>
			agentIdCounts.get(agent.agentId) === 1 &&
			agent.operations.every((operation) => operationIdCounts.get(operation.operationId) === 1),
	);
	return { version: 1, revision: envelope.revision, agents };
}

/** A start never ran; a prompt may have; a refused stop leaves the turn as it was. */
export function uncertainDeliveryState<State extends string>(
	kind: "start" | "message" | "stop",
	current: State,
): State | "unavailable" | "recovering" {
	if (kind === "start") return "unavailable";
	if (kind === "message") return "recovering";
	return current;
}

export function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
	return values.map((current, currentIndex) => (currentIndex === index ? value : current));
}
