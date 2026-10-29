// The whole gateway graph, one stage at a time.

import { hostSpawnPoint } from "../shared/host-spawn.js";
import type { ChannelDeliveryCoordinator } from "./channelDelivery.js";
import { composeAgents } from "./compose/composeAgents.js";
import { composeAssistant } from "./compose/composeAssistant.js";
import { composeAwareness } from "./compose/composeAwareness.js";
import { composeBaseline } from "./compose/composeBaseline.js";
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
import { routineOwns } from "./routines/reservation.js";

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
	let closing = false;
	let closePromise: Promise<void> | null = null;
	const isClosing = () => closing;

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
		const current = routes.current();
		if (!current) throw new Error("no Domain is active, so no route is built");
		return current;
	};
	const requireDeliveries = (): ChannelDeliveryCoordinator => {
		if (!websockets) throw new Error("the websockets stage is not composed yet");
		return websockets.channelDeliveries;
	};

	const context = new FederationContext({
		contentKeys: bootstrap.contentKeyStore,
		initialDomainId: bootstrap.initialDomainId,
		domainIdOnDisk: bootstrap.domainIdOnDisk,
		isClosing,
		buildSlice: (boot) => {
			if (!federation) throw new Error("the federation stage is not composed yet");
			return federation.buildSlice(boot);
		},
		onActivate: (slice) => {
			if (isClosing()) return;
			if (!routes || !routerPresence || !routerFrames || !federation) {
				throw new Error("federation activated before the graph was composed");
			}
			routes.rebuild();
			presenceHandlers = routerPresence.build(slice);
			frames = routerFrames.build(slice, presenceHandlers);
			slice.handlers = { frames };
			// Here rather than beside the active boot, so enrolling into an arming one arms this too.
			routines?.start();
			assistant.start();
			vault?.retractStale();
		},
		onDomainChanged: () => sessions.presence.markDirty(),
	});

	const stores = composeStores({
		dataDir: bootstrap.dataDir,
		maxBlobStoreBytes: config.maxBlobStoreBytes,
		ambient: bootstrap.ambient,
		onJobChange: () => federation?.attest(),
	});
	const sessions = composeSessions({
		localGatewayId: bootstrap.localGatewayId,
		ambient: bootstrap.ambient,
		stores,
		context,
	});
	const assistant = composeAssistant({
		dataDir: bootstrap.dataDir,
		localGatewayId: bootstrap.localGatewayId,
		domainId: () => context.domainId(),
		ambient: bootstrap.ambient,
		sessions,
		saveSessions: () => sessions.saveSessionsChecked(),
		// Read late; composed below.
		vault: {
			watcherGrants: (watcherId) => vault?.watcherGrants(watcherId) ?? [],
			setWatcherGrants: (watcherId, entryIds) => {
				if (!vault) throw new Error("the vault is not composed yet");
				vault.setWatcherGrants(watcherId, entryIds);
			},
			readForWatcher: async (watcherId, entryId) =>
				vault
					? vault.readForWatcher(watcherId, entryId)
					: { kind: "unready", reason: "the vault is not composed yet" },
			usableHere: async (entryId) => (vault ? vault.usableHere(entryId) : false),
		},
		routes: requireRoutes,
		blobSize: (blobId) => {
			try {
				const stat = stores.blobStore.stat(blobId);
				return stat.complete ? (stat.size ?? null) : null;
			} catch {
				return null;
			}
		},
		lastDeliverySeq: () => stores.pendingDeliveries.lastSeq(),
		fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
		...(deps.assistantWatchers ? { watchers: deps.assistantWatchers } : {}),
	});
	const persistence = composePersistence({
		ambient: bootstrap.ambient,
		stores,
		sessions,
		context,
		sessionEnded: (team) => {
			vault?.sessionEnded(team);
			routines.sessionEnded(team);
			assistant.sessionEnded(team);
		},
		sessionReserved: (team) => routines.reserves(team) || assistant.reserves(team),
		sweepDeliveries: () => websockets?.channelDeliveries.sweep(),
		namesBlob: (blobId) => assistant.namesBlob(blobId) || (routes?.current()?.namesBlob(blobId) ?? true),
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
		isClosing,
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
		isClosing,
	});

	websockets = composeWebSockets({
		hostWsToken: config.hostWsToken,
		ambient: bootstrap.ambient,
		stores,
		sessions,
		host,
		agents,
		federation,
		retireStaging: (blobIds) => routes?.current()?.retireStaging(blobIds),
		observer: {
			offered: (row) => assistant.offered(row),
			acknowledged: (row) => assistant.delivered(row),
		},
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
		onReplyPushed: (team) => assistant.replyPushed(team),
	});
	vault = composeVault({
		dataDir: bootstrap.dataDir,
		localGatewayId: bootstrap.localGatewayId,
		ambient: bootstrap.ambient,
		context,
		routes: requireRoutes,
		sessions,
		// Read late; composed below.
		workingRoutine: (target) => routines.workingRoutine(target),
		secretUnanswered: (target, entryId) => routines.secretUnanswered(target, entryId),
		policies: () => policies.store,
	});
	routerPresence = composeRouterPresence({ stores, sessions, federation });
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
		assistantPlaced: () => assistant.placed(),
		sessionOwned: (team, routine) => routineOwns(sessions.sessionStore.getByTeam(team), routine),
		setRoutineGrants: (routineId, entryIds) => vault?.setRoutineGrants(routineId, entryIds),
		resolveCaller: (req) => {
			const record = sessions.sessionAuthority.resolveConfirmedManagedSession(req);
			return record ? sessions.sessionStore.teamOf(record) : null;
		},
	});
	const baseline = composeBaseline({ context, stores, sessions, routines, assistant });
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
		workspacePlane: websockets.workspacePlane,
		awareness,
		assistant,
	});

	if (bootstrap.gatewayBoot.kind === "arming") enrollment.enterArming(bootstrap.gatewayBoot.nonce);
	if (bootstrap.gatewayBoot.kind === "active") context.activate(bootstrap.gatewayBoot.boot);

	const listener = composeListener({
		dataDir: bootstrap.dataDir,
		localGatewayId: bootstrap.localGatewayId,
		enrollNonce: config.enrollNonce,
		hostWsToken: config.hostWsToken,
		ambient: bootstrap.ambient,
		isClosing,
		context,
		stores,
		sessions,
		agents,
		enrollment,
		routines,
		routes,
		vault,
		baseline,
		assistant,
	});
	const close = (): Promise<void> => {
		if (closePromise) return closePromise;
		closing = true;
		closePromise = Promise.resolve().then(async () => {
			let failed = false;
			let firstError: unknown;
			const capture = async (run: () => unknown): Promise<void> => {
				try {
					await run();
				} catch (error) {
					if (failed) return;
					failed = true;
					firstError = error;
				}
			};
			try {
				await capture(() => enrollment.stop());
				await capture(() => federation?.drainInboxPump());
				await capture(() => routines.stop());
				await capture(() => assistant.stop());
				await capture(() => stores.jobsDurable.saveChecked(stores.jobs.snapshot()));
				await capture(() => stores.sessionResumeDurable.saveChecked(sessions.sessionResumeSnapshot(true)));
				await capture(() => persistence.persistDelivery(true));
			} finally {
				await capture(() => bootstrap.ambient.clearInterval(sessions.tripwireTimer));
				await capture(() => bootstrap.ambient.clearInterval(persistence.persistTimer));
				await capture(() => bootstrap.ambient.clearInterval(host.presenceWatchTimer));
				await capture(() => bootstrap.ambient.clearInterval(awareness.awarenessTimer));
				await capture(() => bootstrap.ambient.clearInterval(websockets.wsHandlers.heartbeatInterval));
				await capture(() => routes?.stop());
				await capture(() => stores.jobs.stopCleanup());
				await capture(() => awareness.awareness.stop());
				await capture(() => federation?.stop());
				await capture(() => sessions.sessionReporter.detach());
				await capture(() => federation?.stopInboxPump());
				await capture(() => context.slice()?.routerClient.stop());
			}
			if (failed) throw firstError;
		});
		return closePromise;
	};
	const wsHandlers: GatewayGraph["wsHandlers"] = {
		...websockets.wsHandlers,
		open: (ws) => {
			if (isClosing()) {
				ws.data.isStale = true;
				ws.close();
				return;
			}
			websockets.wsHandlers.open(ws);
		},
	};

	return {
		router: listener.router,
		wsHandlers,
		close,
		faults: composeFaults({ context, sessions, routines, persistence }),
	};
}
