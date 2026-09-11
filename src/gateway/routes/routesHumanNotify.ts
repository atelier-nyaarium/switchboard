import type { Ambient } from "../../shared/ambient.js";
import type { Address } from "../../shared/session-id.js";
import type { GatewayConfig } from "../../shared/types.js";
import { createConsolePushOps } from "../consolePushOps.js";
import type { CallerScope } from "./callerGuards.js";

export interface HumanNotifyRoutesDeps {
	dataDir: string;
	config: GatewayConfig;
	ambient: Pick<Ambient, "now" | "newId" | "setInterval" | "clearInterval">;
	// This Gateway's Domain owner id (hash of the signing key); keys this device's push rows.
	ownerId?: (() => string | null) | null;
	ownerSignPub?: (() => string | null) | null;
	producerSignPriv?: string;
	routerClient?: import("../router/routerClient.js").RouterClient | null;
	contentKeyStore?: Pick<import("../federation/contentKeyStore.js").ContentKeyStore, "keyFor" | "seal">;
	blobUploader?: ReturnType<typeof import("../router/blobUploader.js").createBlobUploader>;
	blobStore?: import("../../shared/blob-store.js").BlobStore;
	deliveries?: import("../channelDelivery.js").ChannelDeliveryCoordinator;
	localAddress: (name: string) => Address;
	refuseImpersonation: (req: Request, claimed: string, scope: CallerScope) => Response | null;
}

export function createHumanNotifyRoutes({
	dataDir,
	config,
	ambient,
	ownerId,
	ownerSignPub,
	producerSignPriv,
	routerClient,
	contentKeyStore,
	blobUploader,
	blobStore,
	deliveries,
	localAddress,
	refuseImpersonation,
}: HumanNotifyRoutesDeps) {
	// Constructed per createRoutes call, never hoisted: a rebuild (federation activating mid-session).
	return createConsolePushOps({
		dataDir,
		ownerId,
		routerClient,
		localDomainId: config.localDomainId,
		producerSignPriv,
		ownerSignPub,
		contentKeyStore,
		localGatewayId: config.localGatewayId,
		localAddress,
		ambient,
		blobUploader,
		blobStore,
		deliveries,
		refuseImpersonation,
	});
}
