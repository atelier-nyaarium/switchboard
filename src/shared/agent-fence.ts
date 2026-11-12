////////////////////////////////
//  Interfaces & Types

export interface AgentFence {
	daemonInstanceId: string;
	targetId: string;
	generation: number;
	lastEventId: number;
}

////////////////////////////////
//  Functions & Helpers

/** Event IDs are fence high-water marks. */
export function fenceOf(message: {
	daemonInstanceId: string;
	targetId: string;
	generation: number;
	eventId: number;
}): AgentFence {
	return {
		daemonInstanceId: message.daemonInstanceId,
		targetId: message.targetId,
		generation: message.generation,
		lastEventId: message.eventId,
	};
}

export function sameFence(left: AgentFence | undefined, right: AgentFence | undefined): boolean {
	if (!left || !right) return left === right;
	return (
		left.daemonInstanceId === right.daemonInstanceId &&
		left.targetId === right.targetId &&
		left.generation === right.generation &&
		left.lastEventId === right.lastEventId
	);
}

/** Acceptances may install the first fence. */
export function classifyAcceptanceFence(
	current: AgentFence | undefined,
	next: AgentFence,
): "advances" | "duplicate" | "foreign" {
	if (!current) return "advances";
	if (
		current.daemonInstanceId !== next.daemonInstanceId ||
		current.targetId !== next.targetId ||
		current.generation !== next.generation
	) {
		return "foreign";
	}
	return next.lastEventId > current.lastEventId ? "advances" : "duplicate";
}

export function advancesFence(current: AgentFence | undefined, next: AgentFence): boolean {
	return classifyAcceptanceFence(current, next) === "advances";
}

/** Retired generations never return. */
export function retiredGeneration(current: AgentFence | undefined, next: AgentFence): boolean {
	return (
		current !== undefined &&
		current.daemonInstanceId === next.daemonInstanceId &&
		current.targetId === next.targetId &&
		next.generation < current.generation
	);
}

/** Follows another stream; an older generation of the same one is stale. */
export function classifyReconciliationFence(
	current: AgentFence | undefined,
	next: AgentFence,
): "follows" | "duplicate" | "stale" {
	if (!current) return "follows";
	if (retiredGeneration(current, next)) return "stale";
	return classifyAcceptanceFence(current, next) === "duplicate" ? "duplicate" : "follows";
}

/** From a daemon a later hello replaced. None before the first hello. */
export function fromReplacedDaemon(liveInstanceId: string | undefined, message: { daemonInstanceId: string }): boolean {
	return liveInstanceId !== undefined && message.daemonInstanceId !== liveInstanceId;
}

/** Unfenced events are foreign and held. */
export function classifyEventFence(
	current: AgentFence | undefined,
	next: AgentFence,
): "advances" | "duplicate" | "foreign" {
	if (!current) return "foreign";
	return classifyAcceptanceFence(current, next);
}
