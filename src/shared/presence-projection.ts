import type { CrossDomainPresenceSession } from "./federation-protocol.js";
import type { Address } from "./session-id.js";
import type { TeamInfo } from "./types.js";

/** Projects shareable session fields across the Domain trust boundary. */
export function toCrossDomainPresenceSession(
	t: TeamInfo,
	tryLocalAddress: (name: string) => Address | null,
): CrossDomainPresenceSession | null {
	if (t.kind !== "devcontainer" && t.kind !== "loose") return null;
	if (!tryLocalAddress(t.team)) return null;
	return {
		team: t.team,
		gatewayId: t.gatewayId,
		status: t.status,
		kind: t.kind,
		sessionLabel: t.sessionLabel?.slice(0, 64),
		description: t.description?.slice(0, 120),
		lastActive: t.lastActive,
		queueDepth: t.queue_depth,
		working: t.working,
		needsLogin: t.needsLogin,
	};
}
