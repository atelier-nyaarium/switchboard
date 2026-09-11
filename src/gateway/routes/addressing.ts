import {
	Address,
	composeSessionName,
	DEFAULT_SESSION,
	parseSessionName,
	parseTarget,
	SpawnPoint,
} from "../../shared/session-id.js";
import type { GatewayConfig } from "../../shared/types.js";

export interface AddressingDeps {
	config: GatewayConfig;
}

export type Addressing = ReturnType<typeof createAddressing>;

export function createAddressing({ config }: AddressingDeps) {
	const { localGatewayId, localDomainId: localDomain } = config;

	function localAddress(name: string): Address {
		// This is the sole producer of local session canonical addresses.
		const { project, session } = parseSessionName(name);
		return Address.of(localDomain, localGatewayId, project, session);
	}

	function consoleSelfAddress(ownerId: string): Address {
		// Owner id is the address segment; device names are display-only.
		return Address.of(localDomain, localGatewayId, ownerId, DEFAULT_SESSION);
	}

	function tryLocalAddress(name: string): Address | null {
		// Non-addressable registry keys are skipped instead of thrown.
		try {
			return localAddress(name);
		} catch {
			return null;
		}
	}

	function resolveLocalTarget(to: string): { name: string; address: Address } | null {
		// Spawn points and remote gateways stay outside local resolution.
		const t = parseTarget(to, localDomain, localGatewayId);
		if (t instanceof SpawnPoint) return null;
		if (t.domain !== localDomain || t.gateway !== localGatewayId) return null;
		return { name: composeSessionName(t.spawn, t.session), address: t };
	}

	return { localDomain, localAddress, consoleSelfAddress, tryLocalAddress, resolveLocalTarget };
}
