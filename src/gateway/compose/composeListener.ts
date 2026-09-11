// The HTTP entry point, and the shutdown that flushes before it stops anything.

import type { Ambient } from "../../shared/ambient.js";
import { reportUnrecognizedDataEntries } from "../dataDirInventory.js";
import { createHttpRouter } from "../httpRouter.js";
import { createBlobMigrationRoute } from "../router/blobMigrationRoute.js";
import { unenrolledHealth } from "../routes/routesStatus.js";
import type { AgentsStage } from "./composeAgents.js";
import type { AwarenessStage } from "./composeAwareness.js";
import type { EnrollmentStage } from "./composeEnrollment.js";
import type { FederationStage } from "./composeFederation.js";
import type { HostStage } from "./composeHost.js";
import type { PersistenceStage } from "./composePersistence.js";
import type { RoutesStage } from "./composeRoutes.js";
import type { RoutineStage } from "./composeRoutines.js";
import type { SessionsStage } from "./composeSessions.js";
import type { StoresStage } from "./composeStores.js";
import type { VaultStage } from "./composeVault.js";
import type { WebSocketsStage } from "./composeWebSockets.js";
import type { FederationContext } from "./federationContext.js";

export interface ListenerStageDeps {
	dataDir: string;
	localGatewayId: string;
	enrollNonce?: string;
	// Remove-by: 2026-09-25, with the blob migration route.
	routerBlobMigrationToken?: string;
	ambient: Pick<Ambient, "clearInterval">;
	context: FederationContext;
	stores: Pick<StoresStage, "blobStore" | "jobs" | "jobsDurable" | "sessionResumeDurable">;
	sessions: Pick<SessionsStage, "sessionAuthority" | "sessionResumeSnapshot" | "tripwireTimer" | "sessionReporter">;
	persistence: PersistenceStage;
	host: Pick<HostStage, "presenceWatchTimer">;
	agents: Pick<AgentsStage, "agentRoutes">;
	awareness: Pick<AwarenessStage, "awareness" | "awarenessTimer">;
	federation: Pick<FederationStage, "stop">;
	enrollment: Pick<EnrollmentStage, "handleEnrollPost" | "stop">;
	websockets: Pick<WebSocketsStage, "wsHandlers" | "channelDeliveries">;
	routes: Pick<RoutesStage, "current" | "stop">;
	/** Required: an omitted stage leaves a routine's own session with no door, and typechecks. */
	routines: Pick<RoutineStage, "stop" | "routes">;
	vault: Pick<VaultStage, "routes">;
}

export interface ListenerStage {
	router: (req: Request) => Promise<Response>;
	close: () => Promise<void>;
}

export function composeListener(deps: ListenerStageDeps): ListenerStage {
	const { ambient, context, stores, sessions, persistence, host, awareness, websockets, routes } = deps;

	// Remove-by: 2026-09-25, with the blob migration route.
	const migration = createBlobMigrationRoute({
		token: deps.routerBlobMigrationToken,
		blobs: stores.blobStore,
		slice: () => {
			const slice = context.slice();
			return slice
				? {
						call: (action, params) => slice.routerClient.callInboxTool(action, params),
						uploader: slice.blobUploader,
					}
				: null;
		},
		namedHere: (blobId) => routes.current()?.namesBlob(blobId) ?? true,
		sweepDeliveries: () => websockets.channelDeliveries.sweep(),
	});

	const router = createHttpRouter({
		handleEnrollPost: deps.enrollment.handleEnrollPost,
		enrollNonce: deps.enrollNonce,
		admitPayload: () => context.arming()?.admitPayload,
		blobStore: stores.blobStore,
		sessionAuthority: sessions.sessionAuthority,
		loopbackRoutes: new Map([
			...deps.agents.agentRoutes,
			...deps.vault.routes,
			...(deps.routines?.routes ?? []),
			...migration,
		]),
		routes: routes.current,
		unenrolledHealth: () => unenrolledHealth(deps.localGatewayId),
	});

	reportUnrecognizedDataEntries(deps.dataDir);

	async function close(): Promise<void> {
		// Stop taking work and let the attempt in flight finish, so the flush below sees a settled
		// occurrence rather than one halfway through its own writes.
		await deps.routines?.stop();
		// Flush while writers are live.
		stores.jobsDurable.saveChecked(stores.jobs.snapshot());
		stores.sessionResumeDurable.saveChecked(sessions.sessionResumeSnapshot(true));
		persistence.persistDelivery(true);
		ambient.clearInterval(sessions.tripwireTimer);
		ambient.clearInterval(persistence.persistTimer);
		ambient.clearInterval(host.presenceWatchTimer);
		ambient.clearInterval(awareness.awarenessTimer);
		ambient.clearInterval(websockets.wsHandlers.heartbeatInterval);
		deps.enrollment.stop();
		routes.stop();
		stores.jobs.stopCleanup();
		awareness.awareness.stop();
		deps.federation.stop();
		sessions.sessionReporter.detach();
		context.slice()?.routerClient.stop();
	}

	return { router, close };
}
