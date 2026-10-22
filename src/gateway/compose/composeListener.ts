import { signSelfRevocation } from "../../shared/admission.js";
import type { Ambient } from "../../shared/ambient.js";
import { WIRE_NONCE_BYTES } from "../../shared/wire-vocabulary.js";
import { reportUnrecognizedDataEntries } from "../dataDirInventory.js";
import { createHttpRouter } from "../httpRouter.js";
import { unenrolledHealth } from "../routes/routesStatus.js";
import type { AgentsStage } from "./composeAgents.js";
import type { AssistantStage } from "./composeAssistant.js";
import type { BaselineStage } from "./composeBaseline.js";
import type { EnrollmentStage } from "./composeEnrollment.js";
import type { RoutesStage } from "./composeRoutes.js";
import type { RoutineStage } from "./composeRoutines.js";
import type { SessionsStage } from "./composeSessions.js";
import type { StoresStage } from "./composeStores.js";
import type { VaultStage } from "./composeVault.js";
import type { FederationContext } from "./federationContext.js";

export interface ListenerStageDeps {
	dataDir: string;
	localGatewayId: string;
	enrollNonce?: string;
	hostWsToken?: string;
	ambient: Pick<Ambient, "now" | "randomBytes">;
	isClosing: () => boolean;
	context: FederationContext;
	stores: Pick<StoresStage, "blobStore">;
	sessions: Pick<SessionsStage, "sessionAuthority">;
	agents: Pick<AgentsStage, "agentRoutes">;
	enrollment: Pick<EnrollmentStage, "handleEnrollPost">;
	routes: Pick<RoutesStage, "current">;
	/** Required: an omitted stage leaves a routine's own session with no door, and typechecks. */
	routines: Pick<RoutineStage, "routes">;
	vault: Pick<VaultStage, "routes">;
	baseline: Pick<BaselineStage, "routes">;
	assistant: Pick<AssistantStage, "routes">;
}

export interface ListenerStage {
	router: (req: Request) => Promise<Response>;
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
	const { ambient, context, stores, sessions, routes } = deps;
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
		loopbackRoutes: new Map([
			...deps.agents.agentRoutes,
			...deps.vault.routes,
			...(deps.routines?.routes ?? []),
			...deps.baseline.routes,
			...deps.assistant.routes,
		]),
		routes: routes.current,
		unenrolledHealth: () => unenrolledHealth(deps.localGatewayId),
		hostWsToken: deps.hostWsToken,
		retire,
		isClosing: deps.isClosing,
	});

	reportUnrecognizedDataEntries(deps.dataDir);
	return { router };
}
