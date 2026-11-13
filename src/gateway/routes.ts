import type { Ambient } from "../shared/ambient.js";
import type { BoardReply } from "../shared/board-structure.js";
import type { HostOp, HostOpResult } from "../shared/host-op.js";
import type { HostSpawnState } from "../shared/host-spawn.js";
import type { LaunchNotice } from "../shared/launch-notice.js";
import type { PendingJobStore } from "../shared/pending-job-store.js";
import type { GatewayConfig, ResponsePayload, TeamInfo } from "../shared/types.js";
import type { AwarenessBank } from "./awarenessBank.js";
import type { ChannelDeliveryCoordinator } from "./channelDelivery.js";
import type { DurableOpStore } from "./console/durableOpStore.js";
import type { LaunchRecords } from "./launchRecords.js";
import { createAddressing } from "./routes/addressing.js";
import { createCallerGuards } from "./routes/callerGuards.js";
import { createRelay } from "./routes/relay.js";
import { createBlobRoutes } from "./routes/routesBlob.js";
import { createBoardRoutes } from "./routes/routesBoard.js";
import { createCapabilityRoutes } from "./routes/routesCapabilities.js";
import { createHumanNotifyRoutes } from "./routes/routesHumanNotify.js";
import { createPresenceRoutes } from "./routes/routesPresence.js";
import { createRespondRoutes } from "./routes/routesRespond.js";
import { createSendRoutes } from "./routes/routesSend.js";
import { createSessionRoutes } from "./routes/routesSession.js";
import { createStatusRoutes } from "./routes/routesStatus.js";
import type { Presented, SessionAuthority } from "./sessionAuthority.js";
import type { WakeCreate, WakeResult } from "./wake.js";
import type { WakeFlight } from "./wakeService.js";
import type { WorkflowEngine } from "./workflows/engine.js";
import { createWorkflowRoutes } from "./workflows/routes.js";
import type { WorkflowRunner } from "./workflows/runner.js";
import type { ConversationRegistry, HandshakeRepushOutcome, TeamRegistry } from "./wsTypes.js";

export interface RoutesDeps {
	dataDir: string;
	ambient: Ambient;
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	store: PendingJobStore<ResponsePayload>;
	tryWakeTeam: (team: string, createOpts?: WakeCreate) => Promise<WakeResult>;
	beginWake?: (team: string, createOpts?: WakeCreate) => WakeFlight;
	launches?: Pick<LaunchRecords, "join">;
	sessionStore?: import("../shared/session-store.js").SessionStore;
	relayToHost?: (op: HostOp) => Promise<HostOpResult>;
	capabilityStore?: Pick<import("./console/capabilityStore.js").CapabilityStore, "snapshot">;
	daemonCapabilityStore?: Pick<import("./daemonCapabilities.js").DaemonCapabilityStore, "snapshot">;
	presence?: { snapshot(): TeamInfo[] };
	backstop?: () => import("./purgeQueue.js").BackstopTally;
	// `known` separates no reply from an empty catalog.
	hostSpawnPoints?: HostSpawnState;
	config: GatewayConfig;
	producerSignPriv?: string;
	routerClient?: import("./router/routerClient.js").RouterClient | null;
	/** Pinned leaf fingerprint, reported by health. */
	routerCertFp?: string;
	sealer?: import("./federation/sealer.js").Sealer | null;
	blobStore?: import("../shared/blob-store.js").BlobStore;
	blobUploader?: ReturnType<typeof import("./router/blobUploader.js").createBlobUploader>;
	contentKeyStore?: Pick<import("./federation/contentKeyStore.js").ContentKeyStore, "keyFor" | "seal">;
	ownerSignPub?: (() => string | null) | null;
	crossDomainPeers?: import("./federation/crossDomainPeers.js").CrossDomainPeers | null;
	resolvesLocalGateway?: ((gatewayId: string) => boolean) | null;
	isSharedToForReply?: ((sessionTarget: string, domainId: string) => boolean) | null;
	onReplyPushed: (team: string) => void;
	bankLaunch?: (sessionKey: string, notice: LaunchNotice) => void;
	resolveHandshake?: (
		sessionId: string,
		replyAsJson?: Record<string, unknown>,
		responderToken?: Presented,
	) => boolean;
	findPendingHandshake?: (team: string, subId: string) => string | undefined;
	repushHandshake?: (team: string, subId: string) => HandshakeRepushOutcome;
	ownerId?: (() => string | null) | null;
	auth?: SessionAuthority;
	/** Unavailable before enrollment. */
	boardClient?: ReturnType<typeof import("./router/boardClient.js").createBoardClient>;
	/** Restart-proof replay of absolute writes. */
	boardReplays?: DurableOpStore<BoardReply>;
	carryOver?: RoutesCarryOver;
	awareness?: Pick<AwarenessBank, "prepareFor" | "withdraw">;
	workflows?: { engine: WorkflowEngine; runner: WorkflowRunner };
	deliveries: ChannelDeliveryCoordinator;
}

/** State a rebuild must not lose. */
export interface RoutesCarryOver {
	/** Loss repeats a retried write. */
	boardOperationReplies: Map<string, Record<string, unknown>>;
}

export function createRoutesCarryOver(): RoutesCarryOver {
	return { boardOperationReplies: new Map() };
}

export function createRoutes(deps: RoutesDeps) {
	const { config, store, auth, carryOver = createRoutesCarryOver(), ambient } = deps;

	const { localDomain, localAddress, consoleSelfAddress, tryLocalAddress, resolveLocalTarget } = createAddressing({
		config,
	});
	const { provedLocalSession, actsForBoundSession, refuseImpersonation, refuseForeignReply, refuseForeignPoll } =
		createCallerGuards({
			auth,
			store,
		});
	const { targetDomainId, relayToGateway, relayWithRetry } = createRelay({
		config,
		localDomain,
		producerSignPriv: deps.producerSignPriv,
		routerClient: deps.routerClient,
		sealer: deps.sealer,
		blobUploader: deps.blobUploader,
		crossDomainPeers: deps.crossDomainPeers,
		resolvesLocalGateway: deps.resolvesLocalGateway,
		ambient,
	});

	// Before send and respond: both push through its mirrorPeer and deliverToOwner.
	const consolePush = createHumanNotifyRoutes({
		dataDir: deps.dataDir,
		config,
		ambient,
		ownerId: deps.ownerId,
		ownerSignPub: deps.ownerSignPub,
		producerSignPriv: deps.producerSignPriv,
		routerClient: deps.routerClient,
		contentKeyStore: deps.contentKeyStore,
		blobUploader: deps.blobUploader,
		blobStore: deps.blobStore,
		deliveries: deps.deliveries,
		localAddress,
		refuseImpersonation,
	});
	const { mirrorPeer, humanNotify, pluginAction, deliverToOwner } = consolePush;

	const { readBlob } = createBlobRoutes({
		config,
		contentKeyStore: deps.contentKeyStore,
		ownerSignPub: deps.ownerSignPub,
		routerClient: deps.routerClient,
	});
	const { pending, teams, health } = createStatusRoutes({
		config,
		registry: deps.registry,
		store,
		routerClient: deps.routerClient,
		routerCertFp: deps.routerCertFp,
		presence: deps.presence,
		backstop: deps.backstop,
		sessionStore: deps.sessionStore,
		tryLocalAddress,
		provedLocalSession,
		actsForBoundSession,
	});
	const { capabilities } = createCapabilityRoutes({
		capabilityStore: deps.capabilityStore,
		daemonCapabilityStore: deps.daemonCapabilityStore,
		routerClient: deps.routerClient,
		ambient,
	});
	const { discoverFull, discover } = createPresenceRoutes({
		config,
		localDomain,
		hostSpawnPoints: deps.hostSpawnPoints,
		routerClient: deps.routerClient,
		teams,
	});
	const {
		sendFromOwner,
		sendFromSession,
		acceptGatewaySend,
		ownerSessionKey,
		deliverEvent,
		bindTarget,
		sendFromAssistant,
	} = createSendRoutes({
		ownerId: deps.ownerId,
		config,
		localDomain,
		ambient,
		registry: deps.registry,
		conversationRegistry: deps.conversationRegistry,
		store,
		tryWakeTeam: deps.tryWakeTeam,
		beginWake: deps.beginWake,
		launches: deps.launches,
		sessionStore: deps.sessionStore,
		routerClient: deps.routerClient,
		auth,
		awareness: deps.awareness,
		deliveries: deps.deliveries,
		blobUploader: deps.blobUploader,
		localAddress,
		consoleSelfAddress,
		tryLocalAddress,
		resolveLocalTarget,
		targetDomainId,
		relayToGateway,
		mirrorPeer,
		refuseImpersonation,
		provedLocalSession,
	});
	const { respond, poll, pushLaunch, acceptLaunchNotice } = createRespondRoutes({
		config,
		ambient,
		localDomain,
		conversationRegistry: deps.conversationRegistry,
		store,
		resolveHandshake: deps.resolveHandshake,
		findPendingHandshake: deps.findPendingHandshake,
		repushHandshake: deps.repushHandshake,
		isSharedToForReply: deps.isSharedToForReply,
		ownerId: deps.ownerId,
		tryLocalAddress,
		relayWithRetry,
		mirrorPeer,
		deliverToOwner,
		refuseForeignReply,
		refuseForeignPoll,
		provedLocalSession,
		onReplyPushed: deps.onReplyPushed,
		bankLaunch: deps.bankLaunch,
	});
	const { taskBoard } = createBoardRoutes({
		auth,
		boardClient: deps.boardClient,
		boardReplays: deps.boardReplays,
		boardOperationReplies: carryOver.boardOperationReplies,
		refuseImpersonation,
	});
	const { typeSession } = createSessionRoutes({ auth, relayToHost: deps.relayToHost });
	const workflowRoutes = deps.workflows
		? createWorkflowRoutes({
				auth,
				runner: deps.workflows.runner,
				engine: deps.workflows.engine,
				sessionStore: deps.sessionStore ?? { teamOf: () => "" },
				withdraw: (team, runId) => deps.awareness?.withdraw(team, "workflow", runId),
			})
		: {
				workflowStart: () =>
					new Response(JSON.stringify({ error: "workflow engine unavailable" }), { status: 503 }),
				workflowCollect: () =>
					new Response(JSON.stringify({ error: "workflow engine unavailable" }), { status: 503 }),
				workflowList: () =>
					new Response(JSON.stringify({ error: "workflow engine unavailable" }), { status: 503 }),
				workflowStop: () =>
					new Response(JSON.stringify({ error: "workflow engine unavailable" }), { status: 503 }),
				workflowDelete: () =>
					new Response(JSON.stringify({ error: "workflow engine unavailable" }), { status: 503 }),
			};

	return {
		pending,
		capabilities,
		teams,
		discover,
		discoverFull,
		sendFromOwner,
		sendFromSession,
		acceptGatewaySend,
		ownerSessionKey,
		deliverEvent,
		bindTarget,
		sendFromAssistant,
		respond,
		poll,
		pushLaunch,
		acceptLaunchNotice,
		typeSession,
		...workflowRoutes,
		readBlob,
		health,
		humanNotify,
		deliverToOwner,
		tellOwnerLaunch: consolePush.tellOwnerLaunch,
		tellOwnerOf: consolePush.tellOwnerOf,
		pluginAction,
		taskBoard,
		namesBlob: consolePush.namesBlob,
		retireStaging: consolePush.retireStaging,
		stop: consolePush.stop,
	};
}
