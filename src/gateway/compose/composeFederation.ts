// Everything the FederationActive phase owns, built from one bootstrap.

import { DomainSnapshotSchema } from "../../shared/admission.js";
import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { DurableStore, restoreDurable } from "../../shared/durable-store.js";
import { stableHash } from "../../shared/plane-registry.js";
import { ShareMirrorDeltaSchema, ShareMirrorSnapshotSchema } from "../../shared/schemasShare.js";
import { WIRE_NONCE_BYTES } from "../../shared/wire-vocabulary.js";
import type { FederationSlice, GatewayBootstrap } from "../boot.js";
import type { ChannelDeliveryCoordinator } from "../channelDelivery.js";
import {
	CrossDomainHandshakeCoordinator,
	parseCommitReply,
	parseRevealReply,
} from "../federation/crossDomainHandshake.js";
import { CrossDomainPeers } from "../federation/crossDomainPeers.js";
import { CrossDomainShareState } from "../federation/crossDomainShareState.js";
import { logAdmitGatewayQr } from "../federation/enrollQr.js";
import type { createGatewayRelayHandler } from "../federation/gatewayRelay.js";
import { ReplayGuard } from "../federation/replayGuard.js";
import { createSealer } from "../federation/sealer.js";
import { fireAndForget } from "../fireAndForget.js";
import { createBlobUploader } from "../router/blobUploader.js";
import { createBoardClient } from "../router/boardClient.js";
import { createInboxDeliveryPump } from "../router/inboxDeliveryPump.js";
import { createKeyRequester } from "../router/keyRequester.js";
import { createPresenceReporter } from "../router/presenceReporter.js";
import { buildRegisterAuth } from "../router/registerAuth.js";
import { startRouterClient } from "../router/routerClient.js";
import { createShareAttestor } from "../router/shareAttestor.js";
import { routerWsConnection, saveRouterReach } from "../router/transport.js";
import { createVaultClient } from "../router/vaultClient.js";
import { resolveLiveIncarnation } from "../wsTypes.js";
import type { AwarenessStage } from "./composeAwareness.js";
import type { HostStage } from "./composeHost.js";
import type { GatewayRoutes } from "./composeRoutes.js";
import type { SessionsStage } from "./composeSessions.js";
import type { StoresStage } from "./composeStores.js";
import type { FederationContext } from "./federationContext.js";

const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SHARE_MIRROR_RETRY_MS = 10_000;

type ConsoleDeliveryHandler = (
	op: import("../../shared/console-protocol.js").ConsoleOp,
	device: string,
	conversationId: string,
	opId: string,
	ownerSignPub: string,
) => Promise<unknown>;

type PeerHandleOp = ReturnType<typeof createGatewayRelayHandler>["handleOp"];

export interface FederationStageDeps {
	dataDir: string;
	federationDir: string;
	localGatewayId: string;
	/** Null dials the transport's Router. */
	routerBootstrapUrl: string | null;
	ambient: Ambient;
	context: FederationContext;
	stores: Pick<StoresStage, "restored" | "blobStore" | "jobs" | "inboxClaims">;
	sessions: Pick<
		SessionsStage,
		"planeRegistry" | "presence" | "sessionReporter" | "hostSpawnPoints" | "registry" | "sessionStore"
	>;
	host: Pick<HostStage, "wakeService">;
	awareness: Pick<AwarenessStage, "boardObserve">;
	/** Later stages, read on demand. */
	routes: () => GatewayRoutes;
	channelDeliveries: () => ChannelDeliveryCoordinator;
	consoleDispatch: () => ConsoleDeliveryHandler | null;
	peerHandleOp: () => PeerHandleOp | null;
	unlinkDomain: () => ((domainId: string) => unknown) | null;
	/** A vault entry that is no longer live, so every grant over it goes. */
	entryGone: (entryId: string) => void;
	/** Every live vault entry, from a full read. */
	entriesListed: (entryIds: string[]) => void;
}

export interface FederationStage {
	buildSlice: (boot: GatewayBootstrap) => FederationSlice;
	/** Re-attests the live cross-Domain job set. */
	attest: () => void;
	markPresenceDirty: () => void;
	channelDeliveryAck: (team: string, deliveryId: string) => void;
	stop: () => void;
}

export function composeFederation(deps: FederationStageDeps): FederationStage {
	const { context, stores, sessions, localGatewayId, federationDir, dataDir, ambient } = deps;
	const now = () => ambient.now();
	let presenceReporter: ReturnType<typeof createPresenceReporter> | null = null;
	let shareAttestor: ReturnType<typeof createShareAttestor> | null = null;
	let keyRequester: ReturnType<typeof createKeyRequester> | null = null;
	let inboxPump: ReturnType<typeof createInboxDeliveryPump> | null = null;

	function buildSlice(gatewayBootstrap: GatewayBootstrap): FederationSlice {
		let slice: FederationSlice;
		const { domainId } = gatewayBootstrap;
		const allowlist = gatewayBootstrap.allowlist;
		const crossDomainPeers = new CrossDomainPeers(federationDir, () => {
			sessions.planeRegistry.markDirty("linked-peers");
		});
		sessions.planeRegistry.registerPlane(
			{
				name: "linked-peers",
				snapshot: () =>
					crossDomainPeers
						.all()
						.map((p) => ({
							domainId: p.friendDomainId,
							gatewayId: p.friendGatewayId,
							ownerSignPub: p.friendOwnerSignPub,
						}))
						.sort((a, b) => `${a.domainId}.${a.gatewayId}`.localeCompare(`${b.domainId}.${b.gatewayId}`)),
				identityOf: (snapshot) => stableHash(snapshot),
			},
			stores.restored.planes?.["linked-peers"],
		);
		const isLinked = (friend: string) => context.isLinkedDomain(friend);
		const shareState = new CrossDomainShareState(federationDir, ({ removed }) => {
			// Expire unreachable destination jobs.
			for (const record of removed) {
				const domains = record.target.kind === "domain" ? [record.target.domainId] : context.linkedDomainIds();
				for (const friend of domains)
					if (!shareState.isSharedTo(record.sessionTarget, friend, isLinked))
						stores.jobs.expireBySession(record.sessionTarget, friend);
			}
			shareAttestor?.attest();
		});
		let shareMirrorRetry: TimerHandle | null = null;
		let shareMirrorRead: Promise<void> | null = null;
		/** The Router's whole answer replaces the copy. */
		function readShareMirror(): Promise<void> {
			if (shareMirrorRead) return shareMirrorRead;
			if (shareMirrorRetry) ambient.clearTimer(shareMirrorRetry);
			shareMirrorRetry = null;
			shareMirrorRead = (async () => {
				const asked = routerClient.incarnation();
				const answer = await routerClient.callInboxTool("share_mirror_read", {});
				// Ignore stale registration answers.
				if (routerClient.incarnation() !== asked) return;
				const parsed = answer.error ? null : ShareMirrorSnapshotSchema.safeParse(answer.result);
				let failure = answer.error ?? (parsed?.success ? null : "answered off its schema");
				if (parsed?.success) {
					try {
						shareState.replace(parsed.data);
					} catch (error) {
						failure = `could not be written: ${(error as Error).message}`;
					}
				}
				if (failure === null) return;
				// Retry while registered.
				console.warn(`[federation] share mirror read failed: ${failure}`);
				if (routerClient.isRegistered())
					shareMirrorRetry = ambient.setTimer(
						() => fireAndForget("share mirror read", readShareMirror()),
						SHARE_MIRROR_RETRY_MS,
					);
			})().finally(() => {
				shareMirrorRead = null;
			});
			return shareMirrorRead;
		}
		const federationIdentity = gatewayBootstrap.identity;
		const replayDurable = new DurableStore(dataDir, "replay-guard");
		const replayGuard = new ReplayGuard(ambient);
		restoreDurable("replay-guard", () => {
			const persisted = replayDurable.load();
			if (Array.isArray(persisted)) replayGuard.restore(persisted as Array<[string, number]>);
		});
		const sealer = createSealer(
			federationIdentity,
			allowlist,
			localGatewayId,
			crossDomainPeers,
			domainId,
			replayGuard,
			ambient,
		);
		const routeHandshake = async (
			action: string,
			receiverGatewayId: string,
			payload: unknown,
		): Promise<unknown> => {
			const res = await slice.routerClient.callTool(action, {
				handshakeId: ambient.randomBytes(WIRE_NONCE_BYTES).toString("base64url"),
				srcDomain: domainId,
				srcGateway: localGatewayId,
				dstGateway: receiverGatewayId,
				payload,
			});
			if (res.error) throw new Error(res.error);
			const r = res.result as { ok?: boolean; error?: string; result?: unknown } | undefined;
			if (!r?.ok) throw new Error(r?.error ?? "the friend's Gateway did not complete the handshake");
			return r.result;
		};
		const coordinator = new CrossDomainHandshakeCoordinator({
			self: {
				ownerSignPub: () => allowlist.ownerSignPub,
				gatewaySignPub: federationIdentity.sign.pub,
				gatewayBoxPub: federationIdentity.box.pub,
				domainId,
				gatewayId: localGatewayId,
			},
			peers: crossDomainPeers,
			ambient,
			route: {
				sendCommit: async (receiverGatewayId, req) => {
					const r = await routeHandshake("cross_domain_handshake", receiverGatewayId, req);
					return parseCommitReply(r);
				},
				sendReveal: async (receiverGatewayId, req) => {
					const r = await routeHandshake("cross_domain_handshake_reveal", receiverGatewayId, req);
					return parseRevealReply(r);
				},
			},
		});
		console.log(`[federation] ${allowlist.ownerSignPub ? "enrolled" : "not yet enrolled (no Domain owner)"}`);
		if (!allowlist.selfAdmission(federationIdentity.sign.pub))
			logAdmitGatewayQr(federationIdentity, localGatewayId);

		const connection = routerWsConnection(gatewayBootstrap.transport);
		const bootstrap = deps.routerBootstrapUrl ?? connection.url;
		console.log(`[router] direct transport -> ${bootstrap}`);

		const routerClient = startRouterClient({
			ambient,
			url: bootstrap,
			headers: connection.headers,
			tls: connection.tls,
			gatewayId: localGatewayId,
			domainId,
			reach: gatewayBootstrap.reach,
			onReach: (learned) => saveRouterReach(federationDir, learned),
			onGatewayRelay: (frame) => {
				slice.handlers?.frames.gatewayRelay(frame);
			},
			onValueOp: (frame) => {
				slice.handlers?.frames.valueOp(frame);
			},
			onCrossDomainHandshake: (frame) => {
				slice.handlers?.frames.crossDomainHandshake(frame);
			},
			onDomainSync: (domain) => {
				const parsed = DomainSnapshotSchema.safeParse(domain);
				if (!parsed.success) {
					console.warn(`[federation] dropped malformed domain sync: ${parsed.error.issues[0]?.message}`);
					return;
				}
				if (allowlist.applySnapshot(parsed.data)) {
					console.log(`[federation] domain sync applied (${parsed.data.admissions.length} admissions)`);
				}
			},
			buildRegisterAuth: () =>
				buildRegisterAuth({
					gatewayId: localGatewayId,
					identity: federationIdentity,
					selfAdmission: () => allowlist.selfAdmission(federationIdentity.sign.pub),
					ambient,
				}),
			onDisconnect: () => {
				console.error(`[router] disconnected from the Router`);
				shareState.unready();
			},
			onRegistered: () => {
				sessions.sessionReporter.reconcile();
				presenceReporter?.baseline();
				// The snapshot's landing attests; the copy answers nothing until then.
				fireAndForget("share mirror read", readShareMirror());
				const resent = inboxPump?.resendReceipts();
				if (resent) fireAndForget("inbox receipt resend", resent);
				// Older rows are sealed under the epochs below the oldest held one.
				const oldestHeld = Math.min(...context.contentKeys().epochs());
				const wanted = Number.isFinite(oldestHeld) ? oldestHeld - 1 : 1;
				for (let epoch = 1; epoch <= wanted; epoch += 1) {
					if (context.contentKeys().keyFor(epoch) === null) keyRequester?.request(epoch);
				}
			},
			onPresenceResync: () => presenceReporter?.resync(),
			onUnlink: (frame) => {
				const unlinked = (frame as { domainId?: unknown }).domainId;
				if (typeof unlinked === "string") deps.unlinkDomain()?.(unlinked);
			},
			onShareDelta: (frame) => {
				const parsed = ShareMirrorDeltaSchema.safeParse(frame);
				if (parsed.success && shareState.apply(parsed.data) === "applied") return;
				// Gaps require a snapshot.
				shareState.unready();
				fireAndForget("share mirror read", readShareMirror());
			},
			onInboxDeliver: (frame) => {
				const pumped = inboxPump?.onFrame(
					frame as { address: string; rows: unknown; incarnation?: number; deliveryEpoch: number },
				);
				if (pumped) fireAndForget("inbox deliver", pumped);
			},
		});
		presenceReporter = createPresenceReporter({
			rows: () => sessions.presence.snapshot(),
			spawnPoints: () => ({
				gatewayId: localGatewayId,
				domainId,
				hostSpawns: sessions.hostSpawnPoints.known ? sessions.hostSpawnPoints.ids : [],
			}),
			send: (action, params) => routerClient.callInboxTool(action, params),
			incarnation: () => routerClient.incarnation(),
			ambient,
		});
		shareAttestor = createShareAttestor({
			ambient,
			shares: () => [...new Set(shareState.all().map((share) => share.sessionTarget))],
			liveJobIds: (sessionTarget) =>
				stores.jobs.liveCrossDomainJobIds(
					sessionTarget,
					(gatewayId) => crossDomainPeers.all().some((peer) => peer.friendGatewayId === gatewayId),
					SHARE_TTL_MS,
					now(),
				),
			send: (action, params) => routerClient.callInboxTool(action, params),
			incarnation: () => routerClient.incarnation(),
		});
		shareAttestor.start();
		const blobUploader = createBlobUploader({
			call: (action, params) => routerClient.callInboxTool(action, params),
			blobs: stores.blobStore,
			incarnation: () => routerClient.incarnation(),
			domainId,
			ownerSignPub: () => allowlist.ownerSignPub,
			keys: gatewayBootstrap.contentKeys,
		});
		const boardClient = createBoardClient({
			call: (action, params) => routerClient.callInboxTool(action, params),
			domainId,
			gatewayId: localGatewayId,
			ownerSignPub: () => allowlist.ownerSignPub,
			keys: gatewayBootstrap.contentKeys,
		});
		const vaultClient = createVaultClient({
			call: (action, params) => routerClient.callInboxTool(action, params),
			domainId,
			gatewayId: localGatewayId,
			ownerSignPub: () => allowlist.ownerSignPub,
			keys: gatewayBootstrap.contentKeys,
			onEntryGone: (entryId) => deps.entryGone(entryId),
			onEntriesListed: (entryIds) => deps.entriesListed(entryIds),
		});
		keyRequester = createKeyRequester({
			domainId,
			gatewayId: localGatewayId,
			gatewaySignPub: federationIdentity.sign.pub,
			gatewaySignPriv: federationIdentity.sign.priv,
			ambient,
			send: (action, params) => routerClient.callInboxTool(action, params),
			onError: (message) => {
				deps.routes().deliverToOwner({
					entry: {
						kind: "notice",
						session_id: `gateway.${localGatewayId}.key-request`,
						title: "Content key unavailable",
						summary: message,
						body: message,
					},
					dedupeKey: `key-request:${domainId}:${localGatewayId}`,
					label: "key-request",
				});
			},
		});
		inboxPump = createInboxDeliveryPump({
			claims: stores.inboxClaims,
			routerClient,
			boardObservation: (sessionKey, row) =>
				deps.awareness.boardObserve([
					{
						sessionKey,
						identity: row.identity,
						pre: row.pre ? boardClient.openEntry(row.pre) : undefined,
						post: row.post ? boardClient.openEntry(row.post) : undefined,
					},
				]),
			incarnation: () => routerClient.incarnation(),
			domainId,
			gatewayId: localGatewayId,
			gatewaySignPub: federationIdentity.sign.pub,
			ownerSignPub: () => allowlist.ownerSignPub,
			contentKeyStore: gatewayBootstrap.contentKeys,
			consoleDispatch: (op, device, conversationId, opId, ownerSignPub) => {
				const handler = deps.consoleDispatch();
				return handler
					? handler(op, device, conversationId, opId, ownerSignPub)
					: Promise.reject(new Error("console handler unavailable"));
			},
			producerSignPriv: federationIdentity.sign.priv,
			allowlistSnapshot: () => allowlist.getSnapshot(),
			keyRequester,
			sealer,
			coordinator: deps.channelDeliveries(),
			tryWakeTeam: (team) => deps.host.wakeService.tryWakeTeam(team),
			isSessionLive: (sessionId) => !!resolveLiveIncarnation(sessions.registry, sessions.sessionStore, sessionId),
			peerHandler: (op, srcGateway, srcDomainId) => {
				const handler = deps.peerHandleOp();
				if (!handler) throw new Error("peer handler not ready");
				return handler(op, srcGateway, srcDomainId);
			},
		});

		slice = {
			allowlist,
			crossDomainPeers,
			shareState,
			coordinator,
			sealer,
			routerClient,
			contentKeyStore: gatewayBootstrap.contentKeys,
			boardClient,
			vaultClient,
			blobUploader,
			replayPersist: () => replayDurable.save(replayGuard.snapshot()),
			handlers: null,
		};
		return slice;
	}

	return {
		buildSlice,
		attest: () => shareAttestor?.attest(),
		markPresenceDirty: () => presenceReporter?.markDirty(),
		channelDeliveryAck: (team, deliveryId) => void inboxPump?.onChannelDeliveryAck(team, deliveryId),
		stop: () => {
			shareAttestor?.stop();
			presenceReporter?.stop();
			keyRequester?.stop();
		},
	};
}
