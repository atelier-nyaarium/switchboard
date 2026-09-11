// The HTTP route surface, rebuilt whenever federation activates.

import type { Ambient } from "../../shared/ambient.js";
import type { Identity } from "../../shared/crypto.js";
import { ownerKeyId } from "../../shared/owner-id.js";
import { createRoutes, createRoutesCarryOver } from "../routes.js";
import type { AwarenessStage } from "./composeAwareness.js";
import type { HostStage } from "./composeHost.js";
import type { SessionsStage } from "./composeSessions.js";
import type { StoresStage } from "./composeStores.js";
import type { WebSocketsStage } from "./composeWebSockets.js";
import type { FederationContext } from "./federationContext.js";

export type GatewayRoutes = ReturnType<typeof createRoutes>;

export interface RoutesStageDeps {
	dataDir: string;
	localGatewayId: string;
	ambient: Ambient;
	identity: () => Identity;
	context: FederationContext;
	stores: Pick<StoresStage, "jobs" | "capabilityStore" | "daemonCapabilityStore" | "blobStore" | "boardReplays">;
	sessions: Pick<
		SessionsStage,
		"registry" | "conversationRegistry" | "sessionAuthority" | "sessionStore" | "presence" | "hostSpawnPoints"
	>;
	host: Pick<HostStage, "wakeService">;
	awareness: Pick<AwarenessStage, "awareness">;
	websockets: WebSocketsStage;
}

export interface RoutesStage {
	/** Null until a Domain is active: no route mints an address before then. */
	current: () => GatewayRoutes | null;
	/** Stops the live routes and builds them again over the current federation state. */
	rebuild: () => void;
	stop: () => void;
}

export function composeRoutes(deps: RoutesStageDeps): RoutesStage {
	const { context, stores, sessions, host, websockets } = deps;
	const carryOver = createRoutesCarryOver();

	function build(): GatewayRoutes | null {
		const localDomainId = context.domainId();
		if (localDomainId === null) return null;
		const f = context.slice();
		return createRoutes({
			dataDir: deps.dataDir,
			carryOver,
			routerCertFp: context.routerCertFp(),
			registry: sessions.registry,
			conversationRegistry: sessions.conversationRegistry,
			store: stores.jobs,
			capabilityStore: stores.capabilityStore,
			daemonCapabilityStore: stores.daemonCapabilityStore,
			blobStore: stores.blobStore,
			blobUploader: f?.blobUploader,
			contentKeyStore: f?.contentKeyStore,
			ownerSignPub: f ? () => f.allowlist.ownerSignPub : null,
			auth: sessions.sessionAuthority,
			config: { localGatewayId: deps.localGatewayId, localDomainId },
			producerSignPriv: f ? deps.identity().sign.priv : undefined,
			tryWakeTeam: (team, createOpts) => host.wakeService.tryWakeTeam(team, createOpts),
			sessionStore: sessions.sessionStore,
			presence: sessions.presence,
			hostSpawnPoints: sessions.hostSpawnPoints,
			routerClient: f?.routerClient ?? null,
			sealer: f?.sealer ?? null,
			crossDomainPeers: f?.crossDomainPeers ?? null,
			resolvesLocalGateway: f ? (gatewayId) => f.allowlist.resolveGateway(gatewayId) !== null : null,
			isSharedToForReply: f
				? (sessionTarget, domainId) =>
						f.shareState.isSharedTo(sessionTarget, domainId, (id) => context.isLinkedDomain(id))
				: null,
			resolveHandshake: websockets.wsHandlers.resolveHandshake,
			findPendingHandshake: websockets.wsHandlers.findPendingHandshakeId,
			repushHandshake: websockets.wsHandlers.repushHandshake,
			deliveries: websockets.channelDeliveries,
			ownerId: f ? () => (f.allowlist.ownerSignPub ? ownerKeyId(f.allowlist.ownerSignPub) : null) : null,
			boardClient: f?.boardClient,
			boardReplays: stores.boardReplays,
			awareness: deps.awareness.awareness,
			ambient: deps.ambient,
		});
	}

	let routes = build();
	return {
		current: () => routes,
		rebuild: () => {
			routes?.stop();
			routes = build();
		},
		stop: () => routes?.stop(),
	};
}
