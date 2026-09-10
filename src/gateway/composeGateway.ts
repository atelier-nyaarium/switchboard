// The whole gateway graph, one stage at a time.

import { hostSpawnPoint } from "../shared/host-spawn.js";
import { ownerKeyId } from "../shared/owner-id.js";
import type { ChannelDeliveryCoordinator } from "./channelDelivery.js";
import { composeAgents } from "./compose/composeAgents.js";
import { composeAwareness } from "./compose/composeAwareness.js";
import { composeBootstrap } from "./compose/composeBootstrap.js";
import { composeEnrollment } from "./compose/composeEnrollment.js";
import { composeFaults } from "./compose/composeFaults.js";
import { composeFederation, type FederationStage } from "./compose/composeFederation.js";
import { composeHost } from "./compose/composeHost.js";
import { composeListener } from "./compose/composeListener.js";
import { composePersistence } from "./compose/composePersistence.js";
import { composePolicies } from "./compose/composePolicies.js";
import { composeRouterFrames, type RouterFramesBuild, type RouterFramesStage } from "./compose/composeRouterFrames.js";
import {
	composeRouterPresence,
	type RouterPresenceBuild,
	type RouterPresenceStage,
} from "./compose/composeRouterPresence.js";
import { composeRoutes, type GatewayRoutes, type RoutesStage } from "./compose/composeRoutes.js";
import { composeRoutines } from "./compose/composeRoutines.js";
import { composeRunbooks } from "./compose/composeRunbooks.js";
import { composeSessions } from "./compose/composeSessions.js";
import { composeStores } from "./compose/composeStores.js";
import { composeVault, type VaultStage } from "./compose/composeVault.js";
import { composeWebSockets, type WebSocketsStage } from "./compose/composeWebSockets.js";
import { FederationContext } from "./compose/federationContext.js";
import type { GatewayDeps, GatewayGraph } from "./compose/gatewayTypes.js";
import { readOwnerSignPub } from "./federation/allowlist.js";
import { routineOwns, routineTeam } from "./routines/reservation.js";

export { createProjectPredicates } from "./compose/composeSessions.js";
export type {
	EnrollTlsListener,
	GatewayConfig,
	GatewayDeps,
	GatewayFaultPort,
	GatewayGraph,
	OpenEnrollTls,
} from "./compose/gatewayTypes.js";

/** The whole gateway graph. */
export function composeGateway(deps: GatewayDeps): GatewayGraph {
	const { config } = deps;
	const bootstrap = composeBootstrap(deps);

	// Stages the earlier ones reach forward into. Every read is a call, never a captured value.
	let federation: FederationStage | undefined;
	let websockets: WebSocketsStage | undefined;
	let routes: RoutesStage | undefined;
	let routerPresence: RouterPresenceStage | undefined;
	let routerFrames: RouterFramesStage | undefined;
	let frames: RouterFramesBuild | undefined;
	let presenceHandlers: RouterPresenceBuild | undefined;
	let vault: VaultStage | undefined;

	const requireRoutes = (): GatewayRoutes => {
		if (!routes) throw new Error("the routes stage is not composed yet");
		return routes.current();
	};
	const requireDeliveries = (): ChannelDeliveryCoordinator => {
		if (!websockets) throw new Error("the websockets stage is not composed yet");
		return websockets.channelDeliveries;
	};

	const context = new FederationContext({
		contentKeys: bootstrap.contentKeyStore,
		initialDomainId: bootstrap.initialDomainId,
		domainIdOnDisk: bootstrap.domainIdOnDisk,
		buildSlice: (boot) => {
			if (!federation) throw new Error("the federation stage is not composed yet");
			return federation.buildSlice(boot);
		},
		onActivate: (slice) => {
			if (!routes || !routerPresence || !routerFrames || !federation) {
				throw new Error("federation activated before the graph was composed");
			}
			routes.rebuild();
			presenceHandlers = routerPresence.build(slice);
			frames = routerFrames.build(slice, presenceHandlers);
			slice.handlers = { frames, presence: presenceHandlers };
			federation.startShareSweep(slice);
			// Here rather than beside the active boot, so enrolling into an arming one arms this too.
			routines?.start();
		},
	});

	const ownerSignPubOnDisk = readOwnerSignPub(bootstrap.federationDir);
	const stores = composeStores({
		dataDir: bootstrap.dataDir,
		maxBlobStoreBytes: config.maxBlobStoreBytes,
		ambient: bootstrap.ambient,
		onJobChange: () => federation?.attest(),
		legacyOwnerId: ownerSignPubOnDisk ? ownerKeyId(ownerSignPubOnDisk) : null,
	});
	const sessions = composeSessions({
		localGatewayId: bootstrap.localGatewayId,
		ambient: bootstrap.ambient,
		stores,
		context,
	});
	const persistence = composePersistence({
		ambient: bootstrap.ambient,
		stores,
		sessions,
		context,
		sessionEnded: (team) => {
			vault?.sessionEnded(team);
			routines.sessionEnded(team);
		},
		reservedByRoutine: (team) => routines.reserves(team),
	});
	const host = composeHost({ sessions, wakeTimeoutMs: config.wakeTimeoutMs, ambient: bootstrap.ambient });
	const agents = composeAgents({ sessions, host, ambient: bootstrap.ambient });
	const awareness = composeAwareness({ sessions, host, ambient: bootstrap.ambient });

	federation = composeFederation({
		dataDir: bootstrap.dataDir,
		federationDir: bootstrap.federationDir,
		localGatewayId: bootstrap.localGatewayId,
		routerBootstrapUrl: config.routerBootstrapUrl,
		ambient: bootstrap.ambient,
		context,
		stores,
		sessions,
		host,
		awareness,
		routes: requireRoutes,
		channelDeliveries: requireDeliveries,
		consoleDispatch: () => frames?.consoleDelivery ?? null,
		peerHandleOp: () => frames?.peerHandleOp ?? null,
		unlinkDomain: () => presenceHandlers?.unlinkDomain ?? null,
		entryGone: (entryId) => vault?.entryDeleted(entryId),
		entriesListed: (entryIds) => vault?.entriesListed(entryIds),
	});

	const enrollment = composeEnrollment({
		federationDir: bootstrap.federationDir,
		localGatewayId: bootstrap.localGatewayId,
		enrollTlsPort: config.enrollTlsPort,
		enrollLanHost: config.enrollLanHost,
		openEnrollTls: deps.openEnrollTls,
		ambient: bootstrap.ambient,
		identity: bootstrap.identity,
		contentKeyStore: bootstrap.contentKeyStore,
		resolveBoot: bootstrap.resolveBoot,
		context,
	});

	websockets = composeWebSockets({
		hostWsToken: config.hostWsToken,
		ambient: bootstrap.ambient,
		stores,
		sessions,
		host,
		agents,
		federation,
	});
	routes = composeRoutes({
		dataDir: bootstrap.dataDir,
		localGatewayId: bootstrap.localGatewayId,
		ambient: bootstrap.ambient,
		identity: bootstrap.identity,
		context,
		stores,
		sessions,
		host,
		awareness,
		websockets,
	});
	vault = composeVault({
		dataDir: bootstrap.dataDir,
		localGatewayId: bootstrap.localGatewayId,
		hostWsToken: config.hostWsToken,
		ambient: bootstrap.ambient,
		context,
		routes: requireRoutes,
		sessions,
		// Read late; composed below.
		workingRoutine: (target) => routines.workingRoutine(target),
		secretUnanswered: (target, entryId) => routines.secretUnanswered(target, entryId),
		policies: () => policies.store,
	});
	routerPresence = composeRouterPresence({
		ambient: bootstrap.ambient,
		context,
		stores,
		sessions,
		federation,
		routes: requireRoutes,
	});
	const runbooks = composeRunbooks({
		dataDir: bootstrap.dataDir,
		onRunbookMoved: (runbookId) => routines.runbookMoved(runbookId),
	});
	const routines = composeRoutines({
		dataDir: bootstrap.dataDir,
		ambient: bootstrap.ambient,
		getRunbook: (runbookId) => runbooks.console.get(runbookId),
		knowsSpawn: (spawn) => {
			if (hostSpawnPoint(spawn)?.alwaysAvailable) return true;
			// Never announced is not a no.
			if (!sessions.hostSpawnPoints.known) return true;
			return sessions.hostSpawnPoints.ids.includes(spawn) || sessions.offlineCatalog.has(spawn);
		},
		sessionOwned: (team, routine) => routineOwns(sessions.sessionStore.getByTeam(team), routine),
		setRoutineGrants: (routineId, entryIds) => vault?.setRoutineGrants(routineId, entryIds),
		resolveCaller: (req) => {
			const record = sessions.sessionAuthority.resolveConfirmedManagedSession(req);
			return record ? sessions.sessionStore.teamOf(record) : null;
		},
	});
	const policies = composePolicies({
		dataDir: bootstrap.dataDir,
		onPolicyMoved: (policyId) => vault?.policyMoved(policyId),
		onPoliciesListed: (listed) => vault?.policiesListed(listed),
	});
	routerFrames = composeRouterFrames({
		localGatewayId: bootstrap.localGatewayId,
		wakeTimeoutMs: config.wakeTimeoutMs,
		ambient: bootstrap.ambient,
		context,
		stores,
		sessions,
		host,
		routes: requireRoutes,
		vault,
		runbooks,
		routines,
		policies,
	});

	if (bootstrap.gatewayBoot.kind === "arming") enrollment.enterArming(bootstrap.gatewayBoot.nonce);
	if (bootstrap.gatewayBoot.kind === "active") context.activate(bootstrap.gatewayBoot.boot);

	const listener = composeListener({
		dataDir: bootstrap.dataDir,
		enrollNonce: config.enrollNonce,
		ambient: bootstrap.ambient,
		context,
		stores,
		sessions,
		persistence,
		routines,
		host,
		agents,
		awareness,
		federation,
		enrollment,
		websockets,
		routes,
		routerPresence,
		vault,
	});

	return {
		router: listener.router,
		wsHandlers: websockets.wsHandlers,
		close: listener.close,
		faults: composeFaults({ context, sessions, routines }),
	};
}
