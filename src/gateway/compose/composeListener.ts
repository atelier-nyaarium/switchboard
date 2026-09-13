// The HTTP entry point, and the shutdown that flushes before it stops anything.

import { signSelfRevocation } from "../../shared/admission.js";
import type { Ambient } from "../../shared/ambient.js";
import { WIRE_NONCE_BYTES } from "../../shared/wire-vocabulary.js";
import { reportUnrecognizedDataEntries } from "../dataDirInventory.js";
import { createHttpRouter } from "../httpRouter.js";
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
	hostWsToken?: string;
	ambient: Pick<Ambient, "now" | "randomBytes" | "clearInterval">;
	context: FederationContext;
	stores: Pick<StoresStage, "blobStore" | "jobs" | "jobsDurable" | "sessionResumeDurable">;
	sessions: Pick<SessionsStage, "sessionAuthority" | "sessionResumeSnapshot" | "tripwireTimer" | "sessionReporter">;
	persistence: PersistenceStage;
	host: Pick<HostStage, "presenceWatchTimer">;
	agents: Pick<AgentsStage, "agentRoutes">;
	awareness: Pick<AwarenessStage, "awareness" | "awarenessTimer">;
	federation: Pick<FederationStage, "stop">;
	enrollment: Pick<EnrollmentStage, "handleEnrollPost" | "stop">;
	websockets: Pick<WebSocketsStage, "wsHandlers">;
	routes: Pick<RoutesStage, "current" | "stop">;
	/** Required: an omitted stage leaves a routine's own session with no door, and typechecks. */
	routines: Pick<RoutineStage, "stop" | "routes">;
	vault: Pick<VaultStage, "routes">;
}

export interface ListenerStage {
	router: (req: Request) => Promise<Response>;
	close: () => Promise<void>;
}

export interface GatewayRetireDeps {
	ambient: Pick<Ambient, "now" | "randomBytes">;
	gatewayId: string;
	identity: { sign: { pub: string; priv: string } } | null;
	routerClient: {
		isConnected: () => boolean;
		callInboxTool: (
			action: string,
			params: Record<string, unknown>,
		) => Promise<{ result?: unknown; error?: string }>;
	} | null;
}

export async function retireGateway(deps: GatewayRetireDeps): Promise<{ outcome: string; error?: string }> {
	if (!deps.identity || !deps.routerClient?.isConnected()) return { outcome: "unreachable" };
	const revocation = {
		signPub: deps.identity.sign.pub,
		issuedAt: deps.ambient.now(),
		nonce: deps.ambient.randomBytes(WIRE_NONCE_BYTES).toString("base64url"),
	};
	try {
		const answer = await deps.routerClient.callInboxTool("gateway_retire", {
			revocation: signSelfRevocation(revocation, deps.gatewayId, deps.identity.sign.priv),
		});
		if (answer.error) {
			if (answer.error.includes("unsupported gateway action")) return { outcome: "unsupported" };
			return { outcome: "unreachable", error: answer.error };
		}
		const result = answer.result as { ok?: unknown; error?: unknown } | undefined;
		if (result?.ok === true) return { outcome: "retired" };
		return { outcome: "refused", error: typeof result?.error === "string" ? result.error : "refused" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return message.includes("unsupported gateway action")
			? { outcome: "unsupported" }
			: { outcome: "unreachable", error: message };
	}
}

export function composeListener(deps: ListenerStageDeps): ListenerStage {
	const { ambient, context, stores, sessions, persistence, host, awareness, websockets, routes } = deps;
	const retire = () =>
		retireGateway({
			ambient,
			gatewayId: deps.localGatewayId,
			identity: context.boot()?.identity ?? null,
			routerClient: context.slice()?.routerClient ?? null,
		});

	const router = createHttpRouter({
		handleEnrollPost: deps.enrollment.handleEnrollPost,
		enrollNonce: deps.enrollNonce,
		admitPayload: () => context.arming()?.admitPayload,
		blobStore: stores.blobStore,
		sessionAuthority: sessions.sessionAuthority,
		loopbackRoutes: new Map([...deps.agents.agentRoutes, ...deps.vault.routes, ...(deps.routines?.routes ?? [])]),
		routes: routes.current,
		unenrolledHealth: () => unenrolledHealth(deps.localGatewayId),
		hostWsToken: deps.hostWsToken,
		retire,
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
