// The Router frames this Gateway answers, and the console dispatcher behind the value op.

import type { Ambient } from "../../shared/ambient.js";
import { opPayloadAadKind } from "../../shared/content-envelope.js";
import { ValueOpFrameSchema } from "../../shared/router-protocol.js";
import { ConsoleOpSchema } from "../../shared/schemasConsoleOp.js";
import { ContentEnvelopeSchema } from "../../shared/schemasContentKey.js";
import { readBlobRange } from "../blobOps.js";
import type { FederationSlice, RouterFrameHandlers } from "../boot.js";
import { createConsoleDispatcher } from "../console/consoleHandler.js";
import { createCrossDomainHandshakePump } from "../federation/crossDomainHandshake.js";
import { createGatewayRelayHandler, createGatewayRelayPump } from "../federation/gatewayRelay.js";
import { fireAndForget } from "../fireAndForget.js";
import { composeValueResult } from "../router/valueResult.js";
import { createRoutineExecution } from "../routines/execution.js";
import type { HostStage } from "./composeHost.js";
import type { RouterPresenceBuild } from "./composeRouterPresence.js";
import type { GatewayRoutes } from "./composeRoutes.js";
import type { RoutineStage } from "./composeRoutines.js";
import type { RunbookStage } from "./composeRunbooks.js";
import type { SessionsStage } from "./composeSessions.js";
import type { StoresStage } from "./composeStores.js";
import type { VaultStage } from "./composeVault.js";
import type { FederationContext } from "./federationContext.js";

export interface RouterFramesStageDeps {
	localGatewayId: string;
	wakeTimeoutMs: number;
	ambient: Ambient;
	context: FederationContext;
	stores: Pick<StoresStage, "blobStore" | "jobs" | "durableOpStore">;
	sessions: Pick<SessionsStage, "registry" | "conversationRegistry" | "isTrustedCatalogProject" | "presence">;
	host: Pick<HostStage, "relayToHost" | "wakeService" | "wakeCoordinator">;
	routes: () => GatewayRoutes;
	vault: Pick<VaultStage, "console" | "sessionEnded">;
	runbooks: Pick<RunbookStage, "console">;
	routines: Pick<RoutineStage, "console" | "bindExecution" | "sessionEnded">;
	policies: Pick<import("./composePolicies.js").PolicyStage, "console">;
}

export interface RouterFramesBuild extends RouterFrameHandlers {
	consoleDelivery: ReturnType<typeof createConsoleDispatcher>["handleDelivery"];
	peerHandleOp: ReturnType<typeof createGatewayRelayHandler>["handleOp"];
}

export interface RouterFramesStage {
	build: (slice: FederationSlice, presence: RouterPresenceBuild) => RouterFramesBuild;
}

export function composeRouterFrames(deps: RouterFramesStageDeps): RouterFramesStage {
	const { context, stores, sessions, host, localGatewayId, ambient } = deps;

	function build(slice: FederationSlice, presence: RouterPresenceBuild): RouterFramesBuild {
		const routes = deps.routes();
		const localDomainId = context.activeDomainId();
		const isLinkedDomain = (domainId: string) => context.isLinkedDomain(domainId);

		const consoleHandler = createConsoleDispatcher({
			blobStore: stores.blobStore,
			fetchBlobFromGateway: routes.fetchBlobFromGateway,
			registry: sessions.registry,
			conversationRegistry: sessions.conversationRegistry,
			routes,
			localGatewayId,
			localDomainId,
			ambient,
			isTrustedCatalogProject: sessions.isTrustedCatalogProject,
			dropSessionResume: (team, disposition) => {
				const released = context.slice()?.boardClient.sessionEnded(team, disposition);
				if (released) fireAndForget(`board release for ${team}`, released);
				sessions.presence.forget(team);
			},
			sessionStore: sessions.presence,
			domain: () => {
				const snapshot = slice.allowlist.getSnapshot() ?? null;
				return snapshot ? { version: slice.allowlist.version() ?? "", snapshot } : null;
			},
			relayToHost: host.relayToHost,
			tryWakeTeam: (team) => host.wakeService.tryWakeTeam(team),
			isWakeInFlight: (team) => host.wakeService.isWakeInFlight(team),
			joinCreate: (team, start) => host.wakeService.joinCreate(team, start),
			awaitRegister: (team) => host.wakeCoordinator.waitFor(team, deps.wakeTimeoutMs),
			crossDomain: {
				listen: () => slice.coordinator.listen(),
				request: (args) => slice.coordinator.request(args),
				confirm: (args) => slice.coordinator.confirm(args),
				cancel: (args) => slice.coordinator.cancel(args),
				listenState: (listeningToken) => slice.coordinator.listenState(listeningToken),
				listPeers: () => ({
					peers: slice.crossDomainPeers.all().map((p) => ({
						domainId: p.friendDomainId,
						gatewayId: p.friendGatewayId,
						ownerSignPub: p.friendOwnerSignPub,
					})),
				}),
			},
			crossDomainShare: {
				postRecord: (action, sessionTarget, target) => context.postShareRecord(action, sessionTarget, target),
				share: (sessionTarget, target) => slice.shareState.share(sessionTarget, target),
				unshare: (sessionTarget, target) => slice.shareState.unshare(sessionTarget, target),
				expireSessionJobsForTarget: (sessionTarget, target) => {
					const domains = target.kind === "domain" ? [target.domainId] : context.linkedDomainIds();
					for (const d of domains) stores.jobs.expireBySession(sessionTarget, d);
				},
				listShares: () =>
					slice.shareState.all().map((s) => ({ sessionTarget: s.sessionTarget, target: s.target })),
				isLinkedDomain,
			},
			unlinkDomain: presence.unlinkDomain,
			untrustOwner: presence.untrustOwner,
			durableOpStore: stores.durableOpStore,
			vault: deps.vault.console,
			runbooks: deps.runbooks.console,
			routines: deps.routines.console,
			policies: deps.policies.console,
			onSessionEnded: (team) => {
				deps.vault.sessionEnded(team);
				deps.routines.sessionEnded(team);
			},
		});

		deps.routines.bindExecution(
			createRoutineExecution({
				getRunbook: (runbookId) => deps.runbooks.console.get(runbookId),
				workingOf: (team) => sessions.presence.workingOf(team),
				reserveSession: (routine) => consoleHandler.reserveRoutineSession(routine),
				deliver: async ({ from, to, body, deliveryId }) => {
					const res = await deps.routes().sendFromOwner({ from, to, body, deliveryId, channelOnly: true });
					if (res.ok) return null;
					const json = (await res.json().catch(() => ({}))) as { error?: string };
					return json.error ?? `send to "${to}" failed`;
				},
			}),
		);

		const valueOp = (raw: unknown): void => {
			void (async () => {
				const frame = ValueOpFrameSchema.safeParse(raw);
				if (!frame.success) return;
				const ownerSignPub = slice.allowlist.ownerSignPub;
				const domainId = context.domainId();
				const incarnation = slice.routerClient.incarnation();
				if (!ownerSignPub || !domainId || incarnation === null) {
					// No identity, no answer.
					console.warn(`[value-op] ${frame.data.opId} dropped: no active federation identity`);
					return;
				}
				const value = ContentEnvelopeSchema.safeParse(frame.data.value);
				let result: unknown;
				if (!value.success) result = { kind: "refusal", reason: "the value envelope did not parse" };
				else {
					const opened = slice.contentKeyStore.open(value.data, {
						domainId,
						ownerSignPub,
						epoch: value.data.epoch,
						kind: opPayloadAadKind(),
					});
					if (opened.kind !== "ok") result = { kind: "refusal", reason: "content key unavailable" };
					else {
						try {
							const op = ConsoleOpSchema.parse(JSON.parse(opened.plaintext.toString("utf8")));
							result = {
								kind: "ok",
								// Replies use owner key.
								result: await consoleHandler.handleValue(
									op,
									frame.data.device,
									frame.data.conversationId,
									frame.data.opId,
									ownerSignPub,
								),
							};
						} catch (error) {
							result = { kind: "refusal", reason: (error as Error).message };
						}
					}
				}
				const valueResult = composeValueResult({
					opId: frame.data.opId,
					conversationId: frame.data.conversationId,
					incarnation,
					outcome: result as { kind: "ok"; result: unknown } | { kind: "refusal"; reason: string },
					seal: (plaintext, aad) => {
						const sealed = slice.contentKeyStore.seal(plaintext, {
							domainId,
							ownerSignPub,
							kind: aad.kind,
						});
						return sealed.kind === "ok" ? sealed : null;
					},
				});
				const settled = await slice.routerClient.callTool("value_result", valueResult);
				// An unsettled answer is a Router that will time the console out; say so.
				if ((settled as { result?: { settled?: boolean } })?.result?.settled === false)
					console.warn(`[value-op] Router did not settle value_result for ${frame.data.opId}`);
			})().catch((error) => {
				// Name dropped operations.
				console.warn(`[value-op] dropped: ${(error as Error).message}`);
			});
		};

		const gatewayRelayHandler = createGatewayRelayHandler({
			routes,
			tryWakeTeam: (team) => host.wakeService.tryWakeTeam(team),
			localGatewayId,
			localDomainId,
			shareState: {
				isSharedTo: (sessionTarget, domainId) =>
					slice.shareState.isSharedTo(sessionTarget, domainId, isLinkedDomain),
				sharesFor: (domainId) => slice.shareState.sharesFor(domainId, isLinkedDomain),
				touch: (sessionTarget) => slice.shareState.touch(sessionTarget),
			},
			crossDomainBinding: (sessionId) => stores.jobs.crossDomainBinding(sessionId),
			serveBlobRange: (blobId, offset, length) => {
				const r = readBlobRange(stores.blobStore, blobId, offset, length);
				return { ...(r.bytes.length > 0 ? { chunk: r.bytes.toString("base64") } : {}), eof: r.eof };
			},
		});
		const gatewayRelay = createGatewayRelayPump({
			sealer: slice.sealer,
			handleOp: gatewayRelayHandler.handleOp,
			sendReply: (reply) =>
				slice.routerClient.callTool("gateway_relay_reply", reply as unknown as Record<string, unknown>),
		});

		const crossDomainHandshake = createCrossDomainHandshakePump({
			handleIncomingCommit: (req) => slice.coordinator.handleIncomingCommit(req),
			handleIncomingReveal: (req) => slice.coordinator.handleIncomingReveal(req),
			sendCommitReply: (reply) =>
				slice.routerClient.callTool(
					"cross_domain_handshake_reply",
					reply as unknown as Record<string, unknown>,
				),
			sendRevealReply: (reply) =>
				slice.routerClient.callTool(
					"cross_domain_handshake_reveal_reply",
					reply as unknown as Record<string, unknown>,
				),
		});

		return {
			gatewayRelay,
			valueOp,
			crossDomainHandshake,
			consoleDelivery: consoleHandler.handleDelivery,
			peerHandleOp: gatewayRelayHandler.handleOp,
		};
	}

	return { build };
}
