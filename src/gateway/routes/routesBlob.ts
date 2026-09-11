import type { GatewayConfig } from "../../shared/types.js";
import type { BlobReader } from "../blobOps.js";
import { createRouterBlobReader } from "../router/routerBlobReader.js";

export interface BlobRoutesDeps {
	config: GatewayConfig;
	contentKeyStore?: Pick<import("../federation/contentKeyStore.js").ContentKeyStore, "keyFor">;
	ownerSignPub?: (() => string | null) | null;
	routerClient?: Pick<import("../router/routerClient.js").RouterClient, "callInboxTool"> | null;
}

/** Router range read. */
export function createBlobRoutes({ config, contentKeyStore, ownerSignPub, routerClient }: BlobRoutesDeps): {
	readBlob: BlobReader;
} {
	if (!routerClient || !contentKeyStore) return { readBlob: async () => "unreachable" };
	return {
		readBlob: createRouterBlobReader({
			call: (action, params) => routerClient.callInboxTool(action, params),
			domainId: config.localDomainId,
			ownerSignPub: () => ownerSignPub?.() ?? null,
			keys: contentKeyStore,
		}),
	};
}
