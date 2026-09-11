import type { CrossDomainPeers } from "./crossDomainPeers.js";
import type { SealTarget } from "./sealer.js";

////////////////////////////////
//  Interfaces & Types

/** Both deps follow federation activation, so they arrive per call rather than as a field. */
export interface SealTargetDeps {
	resolvesLocalGateway?: ((gatewayId: string) => boolean) | null;
	crossDomainPeers?: CrossDomainPeers | null;
}

export type SealTargetAnswer = { ok: true; target: SealTarget } | { ok: false; reason: string };

////////////////////////////////
//  Functions & Helpers

/**
 * Local first: a gateway id the local allowlist admits is this Domain's, and seals as the bare
 * id, so a friend's gateway with the same id can never take a local send. A caller naming the
 * Domain selects that peer; a bare id resolves only when exactly one linked peer carries it.
 */
export function sealTargetFor(deps: SealTargetDeps, targetGateway: string, targetDomain?: string): SealTargetAnswer {
	const { resolvesLocalGateway, crossDomainPeers } = deps;
	if (resolvesLocalGateway?.(targetGateway)) return { ok: true, target: targetGateway };
	if (targetDomain && crossDomainPeers?.resolveByGateway(targetDomain, targetGateway)) {
		return { ok: true, target: { domainId: targetDomain, gatewayId: targetGateway } };
	}
	const peers = crossDomainPeers?.all().filter((p) => p.friendGatewayId === targetGateway) ?? [];
	if (peers.length === 1)
		return { ok: true, target: { domainId: peers[0].friendDomainId, gatewayId: targetGateway } };
	if (peers.length > 1) return { ok: false, reason: `Gateway "${targetGateway}" is ambiguous across linked Domains` };
	return { ok: false, reason: `Gateway "${targetGateway}" is neither this Domain's nor a linked peer's` };
}
