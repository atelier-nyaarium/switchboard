// The whole gateway graph, one stage at a time.

import packageJson from "../../package.json";
import { AGENT_AGE_PASS_MS } from "../shared/agent-collect.js";
import type { AgentExecutionTarget } from "../shared/agent-execution-target.js";
import { ASSISTANT_TEAM, isAssistantRecord } from "../shared/assistant-session.js";
import { openDurable } from "../shared/durable-store.js";
import { HOST_SPAWN, hostSpawnPoint, isHostSpawn } from "../shared/host-spawn.js";
import { SENSORS_SOURCE_ID } from "../shared/schemasAssistantActions.js";
import { formatInboxAddress, parseInboxAddress } from "../shared/schemasInbox.js";
import { createAssistantRestart } from "./assistant/assistantRestart.js";
import { createOutboxSource } from "./assistant/outboxSource.js";
import type { ChannelDeliveryCoordinator } from "./channelDelivery.js";
import { automationActions } from "./compose/automationActions.js";
import { composeAgents } from "./compose/composeAgents.js";
import { composeAssistant } from "./compose/composeAssistant.js";
import { composeAutomations } from "./compose/composeAutomations.js";
import { composeAwareness } from "./compose/composeAwareness.js";
import { composeBaseline } from "./compose/composeBaseline.js";
import { composeBootstrap } from "./compose/composeBootstrap.js";
import { composeDevices, type DeviceStage } from "./compose/composeDevices.js";
import { composeEnrollment } from "./compose/composeEnrollment.js";
import { composeFaults } from "./compose/composeFaults.js";
import { composeFederation, type FederationStage } from "./compose/composeFederation.js";
import { composeHost } from "./compose/composeHost.js";
import { composeListener } from "./compose/composeListener.js";
import { composeLiveConsole } from "./compose/composeLiveConsole.js";
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
import { composeSessionCut, type SessionCutStage } from "./compose/composeSessionCut.js";
import { composeSessions } from "./compose/composeSessions.js";
import { composeStores } from "./compose/composeStores.js";
import { composeVault, type VaultStage } from "./compose/composeVault.js";
import { composeWebSockets, type WebSocketsStage } from "./compose/composeWebSockets.js";
import { composeWorkflows, type WorkflowsStage } from "./compose/composeWorkflows.js";
import { FederationContext } from "./compose/federationContext.js";
import type { GatewayDeps, GatewayGraph } from "./compose/gatewayTypes.js";
import type { Automations } from "./computed/automations.js";
import type { ComputedFields } from "./computed/computedFields.js";
import { createThresholdConversion, type ThresholdConversion } from "./devices/thresholdConversion.js";
import { fireAndForget } from "./fireAndForget.js";
import { purgeHolds } from "./purgeHolds.js";
import { createPurgeSweep, orphanedNames } from "./purgeSweep.js";
import { INBOX_CLAIM_TTL_MS } from "./router/inboxClaims.js";
import { createRouterExchange } from "./router/routerExchange.js";
import { routineOwns, routineOwnsPane } from "./routines/reservation.js";
import { createSessionEnd } from "./sessionEnd.js";
import { claudeThreadsOf } from "./workflows/dispatchCore.js";
import { resolveLiveIncarnation } from "./wsTypes.js";

export { createProjectPredicates } from "./compose/composeSessions.js";
export type { GatewayConfig, GatewayDeps, GatewayFaultPort, GatewayGraph } from "./compose/gatewayTypes.js";

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
	/** The Router this process was armed with. */
	let armedRouterUrl: string | null = null;
	let routes: RoutesStage | undefined;
	let routerPresence: RouterPresenceStage | undefined;
	let routerFrames: RouterFramesStage | undefined;
	let sessionCut: SessionCutStage | undefined;
	let frames: RouterFramesBuild | undefined;
	let presenceHandlers: RouterPresenceBuild | undefined;
	let vault: VaultStage | undefined;
	let devices: DeviceStage | undefined;
	let fields: ComputedFields | undefined;
	let automations: Automations | undefined;
	// skew:stored-thresholds: goes with the stored thresholds.
	let thresholdConversion: ThresholdConversion | undefined;
	const pendingKeys = new Set<string>();
	let workflows: WorkflowsStage | undefined;
	let reconcileStaleAgents = (): void => {};

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
	const requireDevices = (): DeviceStage => {
		if (!devices) throw new Error("the devices stage is not composed yet");
		return devices;
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
			// On every activation, an install's included.
			routines?.start();
			workflows?.start();
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
	const sessionEnd = createSessionEnd({
		sessionStore: sessions.sessionStore,
		forget: (team) => sessions.presence.forget(team),
		purges: sessions.purgeQueue,
		save: () => void sessions.saveSessionsChecked(),
		// Read after stages compose.
		before: (team, disposition) => {
			workflows?.forgetSession(team);
			const released = context.slice()?.boardClient.sessionEnded(team, disposition);
			if (released) fireAndForget(`board release for ${team}`, released);
		},
		ended: (team) => {
			const steps: Array<[string, () => unknown]> = [
				["awareness", () => awareness.awareness.dropFor(team)],
				["vault", () => vault?.sessionEnded(team)],
				["routines", () => routines.sessionEnded(team)],
				["cuts", () => sessionCut?.cuts.sessionEnded(team)],
				["assistant", () => assistant.sessionEnded(team)],
				// What names the session in the Gateway's own stores.
				["jobs", () => stores.jobs.forgetTeam(team)],
				["deliveries", () => stores.pendingDeliveries.failTeam(team)],
				// Claims leave on acknowledgment.
				[
					"inbox",
					() => {
						const domainId = context.domainId();
						if (!domainId) return;
						federation?.settleInbox(
							formatInboxAddress({
								kind: "session",
								domainId,
								gatewayId: bootstrap.localGatewayId,
								sessionId: team,
							}),
						);
					},
				],
			];
			// One step's throw skips no other.
			for (const [label, step] of steps) {
				try {
					step();
				} catch (error) {
					console.warn(
						`[session-end] ${team} ${label}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		},
	});
	const assistant = composeAssistant({
		dataDir: bootstrap.dataDir,
		repairs: stores.repairs,
		localGatewayId: bootstrap.localGatewayId,
		domainId: () => context.domainId(),
		ambient: bootstrap.ambient,
		sessions,
		saveSessions: () => sessions.saveSessionsChecked(),
		// Read late; composed below.
		vault: {
			serviceGrants: (serviceId) => vault?.serviceGrants(serviceId) ?? [],
			setServiceGrants: (serviceId, entryIds) => {
				if (!vault) throw new Error("the vault is not composed yet");
				vault.setServiceGrants(serviceId, entryIds);
			},
			readForService: async (serviceId, entryId) =>
				vault
					? vault.readForService(serviceId, entryId)
					: { kind: "unready", reason: "the vault is not composed yet" },
			usableHere: async (entryId) => (vault ? vault.usableHere(entryId) : false),
		},
		devices: {
			assistant: (op) => requireDevices().assistant(op),
			record: (id) => requireDevices().record(id),
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
		...(deps.assistantSources ? { sources: deps.assistantSources } : {}),
		clearSensorEvents: (members) => automations?.clear(members) ?? false,
	});
	const persistence = composePersistence({
		ambient: bootstrap.ambient,
		stores,
		sessions,
		context,
		sessionEnd,
		sessionReserved: (team) =>
			routines.reserves(team) || assistant.reserves(team) || (workflows?.reserves(team) ?? false),
		sweepDeliveries: () => websockets?.channelDeliveries.sweep(),
		namesBlob: (blobId) => assistant.namesBlob(blobId) || (routes?.current()?.namesBlob(blobId) ?? true),
		sweepWorkflows: () => workflows?.sweep(),
		onPersistTick: () => {
			reconcileStaleAgents();
			workflows?.engine.tick();
			devices?.flushReadings();
			fields?.inputsChanged(devices?.sensorInputKeys() ?? []);
			thresholdConversion?.run();
			automations?.tick();
			automations?.watchSensors();
			automations?.sweepFunctions();
			vault?.tick();
		},
	});
	const host = composeHost({
		sessions,
		wakeTimeoutMs: config.wakeTimeoutMs,
		ambient: bootstrap.ambient,
		deviceWatch: () => devices?.deviceWatch() ?? [],
	});
	sessions.purgeQueue.start({
		relay: host.relayToHost,
		hostLive: () => host.liveHostSocket() !== undefined,
		holds: (entry) =>
			purgeHolds(entry, {
				sessionStore: sessions.sessionStore,
				runSessions: () => {
					const held = new Set<string>();
					for (const run of workflows?.runner.running() ?? []) {
						for (const id of claudeThreadsOf(workflows?.runner.rows(run.runId) ?? []).keys()) held.add(id);
					}
					return held;
				},
			}),
		targetOf: (place) => {
			if (place.kind === "host") return { kind: "host", workdirHint: place.workdirHint };
			const hostProjectPath = sessions.offlineCatalog.get(place.project);
			return hostProjectPath ? { ...place, hostProjectPath } : undefined;
		},
	});
	const agents = composeAgents({ sessions, host, ambient: bootstrap.ambient });
	reconcileStaleAgents = agents.reconcileStaleAgents;
	workflows = composeWorkflows({
		dataDir: bootstrap.dataDir,
		ambient: bootstrap.ambient,
		onChanged: () => sessions.presence.markDirty(),
		buildDispatch: (runner) => {
			const dispatch = agents.createWorkflowDispatch(runner);
			return {
				port: dispatch.port,
				retireRun: dispatch.retireRun,
				expireClaudeThreads: dispatch.expireClaudeThreads,
				claudeTurnResult: dispatch.claudeTurnResult,
				inspectThread: dispatch.inspectThread,
				retagThread: dispatch.retagThread,
				watchThread: dispatch.watchThread,
			};
		},
	});
	const heldName = (team: string): boolean => sessions.sessionStore.paneOwner(team) === team;
	/** Names earlier forgets left in this Gateway's own stores. */
	const orphaned = () => {
		const domainId = context.domainId();
		const claimed = stores.inboxClaims.addresses().flatMap((address) => {
			const parsed = parseInboxAddress(address);
			// In-flight dispatches hold claims.
			const own =
				parsed?.kind === "session" &&
				parsed.domainId === domainId &&
				parsed.gatewayId === bootstrap.localGatewayId &&
				!federation?.inboxDispatching(address);
			return own ? [parsed.sessionId] : [];
		});
		const jobs = stores.jobs.listAll();
		const names = orphanedNames(
			claimed,
			jobs.flatMap((job) => [job.to, job.from]),
			heldName,
		);
		// Counted as `forgetTeam` drops them.
		const gone = new Set(names.teams);
		return { ...names, jobs: jobs.filter((job) => gone.has(job.to) || gone.has(job.from)).length };
	};
	const purgeSweep = createPurgeSweep({
		relay: host.relayToHost,
		places: () => {
			if (host.liveHostSocket() === undefined) return undefined;
			const up: AgentExecutionTarget[] = [{ kind: "host", workdirHint: "~" }];
			const stopped: string[] = [];
			const unreached = sessions.hostSpawnPoints.ids.filter((spawn) => spawn !== HOST_SPAWN);
			for (const container of sessions.hostSpawnPoints.containers ?? []) {
				const hostProjectPath = sessions.offlineCatalog.get(container.project);
				if (container.state !== "running") stopped.push(container.project);
				else if (hostProjectPath)
					up.push({ kind: "devcontainer", project: container.project, hostProjectPath });
				else stopped.push(`${container.project} (not in the daemon's catalog)`);
			}
			return { up, stopped, unreached };
		},
		sessions: () => sessions.sessionStore.list(),
		unreadIds: () => sessions.sessionStore.unreadThreadIds(),
		live: (record) =>
			!!resolveLiveIncarnation(sessions.registry, sessions.sessionStore, sessions.sessionStore.teamOf(record)),
		agents: (owner) => sessions.sessionStore.everyAgent(owner),
		runRunning: (runId) => workflows?.runner.get(runId)?.status === "running",
		endThreads: (owner, backend, agentIds, at) => agents.endThreads(owner, backend, agentIds, at),
		purges: sessions.purgeQueue,
		save: () => void sessions.saveSessionsChecked(),
		orphans: orphaned,
		dropOrphans: (found) => {
			const domainId = context.domainId();
			let claims = 0;
			for (const sessionId of found.claims) {
				const address = formatInboxAddress({
					kind: "session",
					domainId: domainId ?? "",
					gatewayId: bootstrap.localGatewayId,
					sessionId,
				});
				if (stores.inboxClaims.forget(address)) claims += 1;
			}
			let jobs = 0;
			for (const team of found.teams) jobs += stores.jobs.forgetTeam(team);
			return { claims, jobs };
		},
		now: bootstrap.ambient.now,
	});
	const expireThreads = () =>
		agents.expireThreads((runId) => workflows?.runner.get(runId)?.status === "running") +
		(workflows?.expireClaudeThreads() ?? 0);
	const threadAgeTimer = bootstrap.ambient.setInterval(() => {
		// Stopped runners report none running.
		if (isClosing()) return;
		try {
			expireThreads();
		} catch (error) {
			console.warn(`[agents] thread age pass failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			stores.inboxClaims.sweep(bootstrap.ambient.now() - INBOX_CLAIM_TTL_MS);
		} catch (error) {
			console.warn(`[inbox] claim sweep failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}, AGENT_AGE_PASS_MS);
	sessions.presence.setWorkflowRunningReader(
		(team) => workflows?.runner.running().some((run) => run.team === team) ?? false,
	);
	const awareness = composeAwareness({
		dataDir: bootstrap.dataDir,
		sessions,
		sessionEnd,
		host,
		stores,
		deliveries: requireDeliveries,
		relayLaunch: async (relay, notice) => (await routes?.current()?.pushLaunch(relay, notice)) ?? false,
		tellOwner: (team, outcome, identity) => routes?.current()?.tellOwnerLaunch(team, outcome, identity) ?? false,
		// Composed below; read at tick.
		tellRoutine: (run, outcome, team) => routines.launchSettled(run, outcome, team),
		wakeTimeoutMs: config.wakeTimeoutMs,
		agents,
		workflows,
		ambient: bootstrap.ambient,
		...(deps.workflowProgressIntervalMsForTests === undefined
			? {}
			: { workflowProgressIntervalMs: deps.workflowProgressIntervalMsForTests }),
	});

	federation = composeFederation({
		dataDir: bootstrap.dataDir,
		federationDir: bootstrap.federationDir,
		localGatewayId: bootstrap.localGatewayId,
		routerBootstrapUrl: () => armedRouterUrl ?? config.routerBootstrapUrl,
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
		ambient: bootstrap.ambient,
		identity: bootstrap.identity,
		contentKeyStore: bootstrap.contentKeyStore,
		resolveBoot: bootstrap.resolveBoot,
		context,
		exchange: deps.routerExchange ?? createRouterExchange(bootstrap.ambient),
		onInstalled: (routerUrl) => {
			armedRouterUrl = routerUrl;
		},
		isClosing,
	});

	websockets = composeWebSockets({
		hostWsToken: config.hostWsToken,
		ambient: bootstrap.ambient,
		stores,
		sessions,
		host,
		agents,
		workflows,
		federation,
		retireStaging: (blobIds) => routes?.current()?.retireStaging(blobIds),
		observer: {
			offered: (row) => assistant.offered(row),
			acknowledged: (row) => assistant.delivered(row),
		},
		ingestDeviceAdvert: (mac, advert, at) => {
			devices?.ingestGatewayAdvert(mac, advert, at);
		},
		onSessionConfirmed: awareness.workflowWatch.sessionConfirmed,
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
		workflows,
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
		repairs: stores.repairs,
		ambient: bootstrap.ambient,
		getRunbook: (runbookId) => runbooks.console.get(runbookId),
		knowsSpawn: (spawn) => {
			if (hostSpawnPoint(spawn)?.alwaysAvailable) return true;
			// Never announced is not a no.
			if (!sessions.hostSpawnPoints.known) return true;
			return sessions.hostSpawnPoints.ids.includes(spawn) || sessions.offlineCatalog.has(spawn);
		},
		assistantPlaced: () => assistant.placed(),
		sessionOwned: (team, routine) =>
			routineOwnsPane(sessions.sessionStore.paneHolder(team), routine) &&
			routineOwns(sessions.sessionStore.getByTeam(team), routine),
		paneHolder: (team) => sessions.sessionStore.paneHolder(team)?.team,
		setRoutineGrants: (routineId, entryIds) => vault?.setRoutineGrants(routineId, entryIds),
		resolveCaller: (req) => {
			const record = sessions.sessionAuthority.resolveConfirmedManagedSession(req);
			return record ? sessions.sessionStore.teamOf(record) : null;
		},
	});
	const baseline = composeBaseline({ context, stores, sessions, routines, workflows, assistant });
	const assistantRestart = createAssistantRestart({
		relayToHost: host.relayToHost,
		busy: () =>
			routines.openRuns(ASSISTANT_TEAM).length > 0 ||
			agents
				.agentRoster()
				.some(
					(agent) =>
						agent.ownerKey === ASSISTANT_TEAM && agent.turns.some((turn) => turn.state === "inProgress"),
				),
		ambient: bootstrap.ambient,
	});
	websockets.onRestartPending((team, pending) => assistantRestart.seen(team, pending));
	websockets.onBaselineDue((team) => {
		baseline
			.baselineFor(team)
			.then((held) => awareness.baselineObserve(team, held))
			.catch((error) => console.error(`[baseline] push after compaction failed for ${team}:`, error));
	});
	const policies = composePolicies({
		dataDir: bootstrap.dataDir,
		repairs: stores.repairs,
		onPolicyMoved: (policyId) => vault?.policyMoved(policyId),
		onPoliciesListed: (listed) => vault?.policiesListed(listed),
	});
	devices = composeDevices({
		dataDir: bootstrap.dataDir,
		ambient: bootstrap.ambient,
		relayToHost: host.relayToHost,
		temperatureUnit: assistant.temperatureUnit,
		...(deps.kasaTransport === undefined ? {} : { transport: deps.kasaTransport }),
		onChanged: () => {
			host.pushDeviceWatch();
			fields?.typesChanged();
		},
		onIngested: (keys) => {
			// One evaluation per frame.
			const fresh = pendingKeys.size === 0;
			for (const key of keys) pendingKeys.add(key);
			if (fresh && pendingKeys.size > 0) {
				queueMicrotask(() => {
					const batch = [...pendingKeys];
					pendingKeys.clear();
					fields?.inputsChanged(batch);
				});
			}
		},
	});
	// Lazy readers permit early composing.
	const liveConsole = composeLiveConsole({
		ambient: bootstrap.ambient,
		readers: {
			gateway: () => {
				const client = context.slice()?.routerClient;
				return {
					id: bootstrap.localGatewayId,
					version: packageJson.version,
					router: client
						? {
								connected: client.isConnected(),
								registered: client.isRegistered(),
								incarnation: client.incarnation(),
							}
						: null,
				};
			},
			devices: () => devices,
			fields: () => fields,
			automations: () => automations,
			assistant: () => assistant.console.state(),
			temperatureUnit: () => assistant.temperatureUnit(),
			bluetoothListen: (windowMs) => host.relayToHost({ kind: "bleListen", windowMs }),
		},
		callerOf: (req) => {
			const record = sessions.sessionAuthority.resolveConfirmedManagedSession(req);
			if (!record) return "unauthenticated";
			if (isAssistantRecord(record)) return "not_served";
			return isHostSpawn(record.spawn) ? "host" : "not_served";
		},
	});
	const automationStage = composeAutomations({
		dataDir: bootstrap.dataDir,
		repairs: stores.repairs,
		newIncarnation: () => bootstrap.ambient.newId(),
		now: () => bootstrap.ambient.now(),
		input: devices!.sensorInput,
		// Flush readings before events.
		beforeDrain: () => devices?.flushReadings(),
		automations: {
			isHome: () => assistant.placed(),
			onQueued: () => assistant.pokeSource(SENSORS_SOURCE_ID),
			eventIssue: assistant.eventIssue,
			eventWarning: assistant.eventWarning,
			eventFields: assistant.eventFields,
			eventChoices: assistant.eventChoices,
			entropy: (size) => bootstrap.ambient.randomBytes(size),
			eventSentence: assistant.eventSentence,
			reading: devices!.watchedReading,
			actions: automationActions({
				devices: () => devices,
				ifttt: assistant.iftttTrigger,
				vaultReady: () => vault?.canRead() ?? false,
			}),
			holes: () => liveConsole.holes,
			timers: bootstrap.ambient,
			sensorsHeard: () => devices?.sensorsHeard() ?? [],
			gatewayName: bootstrap.localGatewayId,
		},
		offers: () => devices?.automationOffers() ?? { numbers: [], switches: [] },
		previewEvent: assistant.previewEvent,
		scriptVocabulary: () => liveConsole.scriptVocabulary(),
	});
	fields = automationStage.fields;
	automations = automationStage.automations;
	assistant.registerSource(createOutboxSource(automations.outbox));
	assistant.bindAutomations(automations);
	thresholdConversion = openDurable(bootstrap.dataDir, "sensor-thresholds", (stored) =>
		openDurable(bootstrap.dataDir, "sensor-thresholds-converted", (mark) =>
			createThresholdConversion({
				stored,
				mark,
				fields: fields!,
				automations: automations!,
				record: (id) => devices?.record(id) ?? null,
				holds: (id) => devices?.holds(id) ?? true,
			}),
		),
	);
	// Before fields evaluate.
	thresholdConversion.run();
	fields.start();
	const sessionClosed = (team: string): void => {
		vault?.sessionEnded(team);
		routines.sessionEnded(team);
		assistant.sessionEnded(team);
		sessionCut?.cuts.sessionEnded(team);
	};
	sessionCut = composeSessionCut({
		ambient: bootstrap.ambient,
		sessions,
		host,
		routes: requireRoutes,
		launching: (team) => host.wakeService.isWakeInFlight(team) || awareness.launches.launching(team),
		closed: sessionClosed,
		resolveCaller: (req) => {
			const record = sessions.sessionAuthority.resolveConfirmedManagedSession(req);
			return record ? sessions.sessionStore.teamOf(record) : null;
		},
	});
	routerFrames = composeRouterFrames({
		localGatewayId: bootstrap.localGatewayId,
		wakeTimeoutMs: config.wakeTimeoutMs,
		ambient: bootstrap.ambient,
		context,
		stores,
		sessions,
		sessionEnd,
		host,
		routes: requireRoutes,
		vault,
		runbooks,
		routines,
		policies,
		automations: automationStage.console,
		cuts: sessionCut.cuts,
		sessionClosed,
		devices: requireDevices(),
		liveConsole,
		workspacePlane: websockets.workspacePlane,
		sessionControl: websockets.sessionControl,
		awareness,
		assistant,
		workflows,
	});

	if (bootstrap.gatewayBoot.kind === "arming") enrollment.resume();
	if (bootstrap.gatewayBoot.kind === "active") context.activate(bootstrap.gatewayBoot.boot);

	const listener = composeListener({
		dataDir: bootstrap.dataDir,
		localGatewayId: bootstrap.localGatewayId,
		hostWsToken: config.hostWsToken,
		ambient: bootstrap.ambient,
		isClosing,
		purgeSweep,
		context,
		stores,
		sessions,
		agents,
		enrollment,
		routines,
		sessionCut,
		routes,
		vault,
		baseline,
		assistant,
		liveConsole,
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
				await capture(() => sessions.purgeQueue.stop());
				// A run in flight ends on an open device road.
				await capture(() => automations?.stop());
				await capture(() => devices?.close());
				await capture(() => federation?.drainInboxPump());
				await capture(() => routines.stop());
				await capture(() => sessionCut?.cuts.stop());
				await capture(() => workflows?.stop());
				await capture(() => agents.stopRelays());
				await capture(() => assistant.stop());
				await capture(() => vault?.stop());
				await capture(() => stores.jobsDurable.saveChecked(stores.jobs.snapshot()));
				await capture(() => stores.sessionResumeDurable.saveChecked(sessions.sessionResumeSnapshot(true)));
				await capture(() => persistence.persistDelivery(true));
			} finally {
				await capture(() => bootstrap.ambient.clearInterval(sessions.tripwireTimer));
				await capture(() => bootstrap.ambient.clearInterval(persistence.persistTimer));
				await capture(() => bootstrap.ambient.clearInterval(threadAgeTimer));
				await capture(() => bootstrap.ambient.clearInterval(host.presenceWatchTimer));
				await capture(() => bootstrap.ambient.clearInterval(host.deviceWatchTimer));
				await capture(() => bootstrap.ambient.clearInterval(awareness.awarenessTimer));
				await capture(() => assistantRestart.stop());
				await capture(() => bootstrap.ambient.clearInterval(websockets.wsHandlers.heartbeatInterval));
				await capture(() => routes?.stop());
				// Waits on a session's plugin fail at once.
				await capture(() => websockets?.workspacePlane.stop());
				await capture(() => websockets?.sessionControl.stop());
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
		faults: composeFaults({ context, sessions, routines, workflows, persistence, expireThreads }),
	};
}
