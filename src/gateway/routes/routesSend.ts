import type { Ambient } from "../../shared/ambient.js";
import type { FederatedOp } from "../../shared/federation-protocol.js";
import type { JobContract, LocalReply, PendingJobStore, Reservation } from "../../shared/pending-job-store.js";
import { BLOB_HOLD_MAX_MS } from "../../shared/router-protocol.js";
import {
	Address,
	composeSessionName,
	parseSessionName,
	parseTarget,
	SpawnPoint,
	storeKey,
} from "../../shared/session-id.js";
import type { ChannelFile, GatewayConfig, ResponsePayload, RidingAwareness } from "../../shared/types.js";
import type { ChannelDeliveryCoordinator } from "../channelDelivery.js";
import { fireAndForget } from "../fireAndForget.js";
import { holdIdFor } from "../router/blobUploader.js";
import {
	fileBytes,
	getTeamMode,
	jsonResponse,
	MAX_RESPONSE_FILE_BYTES,
	POST_WAKE_SETTLE_MS,
	SendRequestSchema,
} from "../routeSchemas.js";
import { presentedByRequest, type SessionAuthority } from "../sessionAuthority.js";
import type { WakeResult } from "../wake.js";
import { reached, sendOn } from "../wsSend.js";
import {
	type ConversationRegistry,
	getAllActiveWs,
	type HandshakeRepushOutcome,
	resolveLiveIncarnation,
	type TeamRegistry,
} from "../wsTypes.js";
import type { CallerScope } from "./callerGuards.js";

type ConsolePushOps = ReturnType<typeof import("../consolePushOps.js").createConsolePushOps>;

type Ingress = { kind: "owner"; ownerId: string } | { kind: "session"; req: Request } | { kind: "gateway" };

export interface SendRoutesDeps {
	config: GatewayConfig;
	localDomain: string;
	ambient: Pick<Ambient, "now" | "newId" | "setTimer">;
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	store: Pick<PendingJobStore<ResponsePayload>, "reserve" | "commit" | "abort">;
	tryWakeTeam: (team: string, createOpts?: { displayLabel?: string; mintedFrom?: string }) => Promise<WakeResult>;
	sessionStore?: import("../../shared/session-store.js").SessionStore;
	routerClient?: Pick<import("../router/routerClient.js").RouterClient, "isConnected"> | null;
	repushHandshake?: (team: string, subId: string) => HandshakeRepushOutcome;
	auth?: SessionAuthority;
	awareness?: { takeFor(sessionKey: string): RidingAwareness | null };
	deliveries?: ChannelDeliveryCoordinator;
	/** Renews relay blob hold. */
	blobUploader?: Pick<ReturnType<typeof import("../router/blobUploader.js").createBlobUploader>, "hold"> | null;
	localAddress: (name: string) => Address;
	consoleSelfAddress: (ownerId: string) => Address;
	tryLocalAddress: (name: string) => Address | null;
	resolveLocalTarget: (to: string) => { name: string; address: Address } | null;
	targetDomainId: (targetGateway: string, targetDomain?: string) => string | null;
	relayToGateway: (
		dstGateway: string,
		op: FederatedOp,
		dstDomain?: string,
		producerOpId?: string,
	) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
	mirrorPeer: ConsolePushOps["mirrorPeer"];
	refuseImpersonation: (req: Request, claimed: string, scope: CallerScope) => Response | null;
	provedLocalSession: (req: Request) => boolean;
	ownerId?: (() => string | null) | null;
}

export function createSendRoutes({
	config,
	localDomain,
	ambient,
	registry,
	conversationRegistry,
	store,
	tryWakeTeam,
	sessionStore,
	routerClient,
	repushHandshake,
	auth,
	awareness,
	deliveries,
	blobUploader,
	localAddress,
	consoleSelfAddress,
	tryLocalAddress,
	resolveLocalTarget,
	targetDomainId,
	relayToGateway,
	mirrorPeer,
	refuseImpersonation,
	provedLocalSession,
	ownerId,
}: SendRoutesDeps) {
	const { localGatewayId } = config;

	async function sendCrossGateway(args: {
		targetGateway: string;
		targetName: string;
		targetDomain?: string;
		from: string;
		fromAddress?: string;
		fromConversationId: string | undefined;
		reply: (conversationId: string) => LocalReply;
		body?: string;
		files?: ChannelFile[];
		displayLabel?: string;
		disposition?: "asking" | "informing" | "closing";
		opId?: string;
	}): Promise<Response> {
		const {
			targetGateway,
			targetName,
			targetDomain,
			from,
			fromAddress,
			fromConversationId,
			reply,
			body,
			files,
			displayLabel,
			disposition,
			opId,
		} = args;
		if (!routerClient?.isConnected()) {
			return jsonResponse({ error: `Router unavailable; cannot reach Gateway "${targetGateway}"` }, 503);
		}
		if (!fromConversationId) {
			return jsonResponse({ error: `fromConversationId is required for a cross-Gateway send` }, 400);
		}
		const resolvedDomain = targetDomainId(targetGateway, targetDomain);
		const { project: tSpawn, session: tSession } = parseSessionName(targetName);
		const targetAddr = Address.of(resolvedDomain ?? localDomain, targetGateway, tSpawn, tSession);
		const qualifiedTo = targetAddr.canonical;
		const srcSession = storeKey({ kind: "conv", conversationId: fromConversationId, address: targetAddr });
		const senderAddr = fromAddress ? null : localAddress(from);
		const senderCanonical = fromAddress ?? senderAddr!.canonical;
		const op: FederatedOp = {
			kind: "send",
			from: senderCanonical,
			to: targetName,
			body: body ?? "",
			...(files && files.length > 0 ? { files } : {}),
			...(displayLabel ? { displayLabel } : {}),
			...(disposition ? { disposition } : {}),
			returnRoute: { srcGateway: localGatewayId, srcConversationId: fromConversationId, srcSession },
		};
		// Anchor first, or a fast reply outruns it.
		const reserved = store.reserve(
			srcSession,
			from,
			qualifiedTo,
			{ kind: "outbound", reply: reply(fromConversationId), dstDomainId: resolvedDomain ?? null },
			{ persistent: true },
		);
		if (reserved.kind === "conflict") return jsonResponse({ error: reserved.reason }, 409);
		let relay: { ok: boolean; error?: string };
		try {
			relay = await relayToGateway(targetGateway, op, targetDomain, opId);
		} catch (err) {
			store.abort(reserved.reservation);
			return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 502);
		}
		if (!relay.ok) {
			store.abort(reserved.reservation);
			return jsonResponse({ error: relay.error ?? `cross-Gateway send to "${qualifiedTo}" failed` }, 502);
		}
		store.commit(reserved.reservation);
		if (senderAddr) {
			mirrorPeer(senderAddr, senderCanonical, targetAddr.canonical, { body, files });
		}
		return jsonResponse({
			session_id: srcSession,
			status: "running",
			message: `Message routed to ${qualifiedTo} via the Router. Responses will be pushed back automatically.`,
		});
	}

	async function send(ingress: Ingress, body: Record<string, unknown>): Promise<Response> {
		const parsed = SendRequestSchema.safeParse(body);
		if (!parsed.success) {
			return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
		}
		const {
			from,
			to,
			targetDomainId: targetDomain,
			body: msgBody,
			files,
			channelOnly,
			displayLabel,
			disposition,
			opId: producerOpId,
		} = parsed.data;
		const fromConversationId = ingress.kind === "owner" ? ingress.ownerId : parsed.data.fromConversationId;
		if (ingress.kind === "session") {
			// Session callers prove identity.
			const refused = refuseImpersonation(ingress.req, from, "session");
			if (refused) return refused;
			const holder = fromConversationId ? conversationRegistry.get(fromConversationId) : undefined;
			if (auth && !auth.satisfies(auth.toAnswerFor(holder), presentedByRequest(ingress.req))) {
				console.warn(`[auth] refused a send claiming another session's conversation`);
				return jsonResponse({ error: "conversation is not this caller's" }, 403);
			}
		}
		const trustedInbound = ingress.kind === "gateway";
		// Federated fields are accepted only from the trusted relay.
		const inboundSessionId = trustedInbound ? parsed.data.sessionId : undefined;
		const returnRoute = trustedInbound ? parsed.data.returnRoute : undefined;
		const dstDomainId = trustedInbound ? parsed.data.dstDomainId : undefined;
		const localReply = (conversationId: string): LocalReply =>
			ingress.kind === "owner"
				? { kind: "owner", ownerId: ingress.ownerId }
				: { kind: "conversation", conversationId };

		if (files && files.length > 0) {
			// Enforce the file-size limit again at the trust boundary.
			const total = fileBytes(files);
			if (total > MAX_RESPONSE_FILE_BYTES) {
				return jsonResponse(
					{ error: `Attachments total ${total} bytes, over the ${MAX_RESPONSE_FILE_BYTES}-byte limit` },
					413,
				);
			}
		}

		const parsedTarget = inboundSessionId ? null : parseTarget(to, localDomain, localGatewayId);
		if (parsedTarget instanceof SpawnPoint) {
			return jsonResponse(
				{ error: `"${to}" is a spawn-point, not a session; address a session as spawn.session` },
				400,
			);
		}
		if (parsedTarget && (parsedTarget.domain !== localDomain || parsedTarget.gateway !== localGatewayId)) {
			// Foreign targets route through the federation Router.
			const realDomain = parsedTarget.domain !== localDomain ? parsedTarget.domain : targetDomain;
			return await sendCrossGateway({
				targetGateway: parsedTarget.gateway,
				targetName: composeSessionName(parsedTarget.spawn, parsedTarget.session),
				targetDomain: realDomain,
				from,
				fromAddress: ingress.kind === "owner" ? consoleSelfAddress(ingress.ownerId).canonical : undefined,
				fromConversationId,
				reply: localReply,
				body: msgBody,
				files,
				displayLabel,
				disposition,
				opId: producerOpId,
			});
		}

		let target = resolveLocalTarget(to);
		if (!target) {
			return jsonResponse({ error: `Gateway for "${to}" is not reachable from this Gateway` }, 404);
		}
		let localName = target.name;
		let qualifiedTo = target.address.canonical;

		if (localName === "host") {
			return jsonResponse(
				{
					error: `"${localName}" is a reserved name; crosstalk_send targets container teams only.`,
				},
				400,
			);
		}

		let targetWs = resolveLiveIncarnation(registry, sessionStore, localName);

		if (!targetWs) {
			// Wake or create the target before delivery.
			const mintedFrom =
				inboundSessionId ?? (fromConversationId ? `${fromConversationId}:${localName}` : undefined);
			const woken = await tryWakeTeam(localName, { displayLabel, mintedFrom });
			if (!woken.ok) {
				if (woken.error) return jsonResponse({ error: woken.error }, 404);
				if (woken.errorKind === "disconnected") {
					return jsonResponse(
						{
							error: `machine "${target.address.gateway}" is not reachable, so "${qualifiedTo}" was never woken`,
						},
						404,
					);
				}
				if (woken.errorKind === "timeout") {
					// Timeout is ambiguous because launch may still succeed.
					return jsonResponse({ error: `"${qualifiedTo}" is still starting; try again shortly` }, 404);
				}
			}
			if (woken.ok) {
				if (woken.resolvedTeam && woken.resolvedTeam !== localName) {
					localName = woken.resolvedTeam;
					const resolved = tryLocalAddress(localName);
					if (resolved) {
						target = { name: localName, address: resolved };
						qualifiedTo = resolved.canonical;
					}
				}
				await new Promise((r) => ambient.setTimer(() => r(undefined), POST_WAKE_SETTLE_MS));
				targetWs = resolveLiveIncarnation(registry, sessionStore, localName);
			}
		}

		const subs = targetWs ? registry.get(targetWs.data.teamName ?? localName) : undefined;
		if ((!targetWs || !subs) && !deliveries) {
			return jsonResponse(
				{
					error: `Team "${qualifiedTo}" is not connected`,
					available: [...registry.keys()]
						.filter((k) => k !== "host")
						.map((k) => tryLocalAddress(k)?.canonical)
						.filter((c): c is string => c != null),
				},
				404,
			);
		}

		const targetMode = subs ? getTeamMode(subs) : "channel";

		if (channelOnly && targetMode !== "channel") {
			return jsonResponse(
				{ error: `"${localName}" is a CLI-mode agent; console chat supports channel-mode (Claude) teams only` },
				409,
			);
		}

		if (targetMode === "channel") {
			let anchor: Reservation | null = null;
			try {
				let channelJobId: string;
				let contract: JobContract;
				if (inboundSessionId) {
					// Federated replies need routes.
					if (!returnRoute) {
						return jsonResponse({ error: `a federated send must carry a return route` }, 400);
					}
					channelJobId = inboundSessionId;
					contract = { kind: "inbound", route: returnRoute, dstDomainId: dstDomainId ?? null };
				} else if (fromConversationId) {
					channelJobId = storeKey({
						kind: "conv",
						conversationId: fromConversationId,
						address: target.address,
					});
					contract = { kind: "local", reply: localReply(fromConversationId) };
				} else {
					return jsonResponse({ error: `fromConversationId is required for channel-mode targets` }, 400);
				}
				const reserved = store.reserve(channelJobId, from, localName, contract, { persistent: true });
				if (reserved.kind === "conflict") return jsonResponse({ error: reserved.reason }, 409);
				anchor = reserved.reservation;

				const hasFiles = files !== undefined && files.length > 0;
				const messageId = hasFiles ? ambient.newId() : undefined;
				// Capture awareness once so retries preserve the same row data.
				const riding = awareness?.takeFor(localName) ?? undefined;

				if (deliveries) {
					// Owners name delivery rows.
					const deliveryId =
						(ingress.kind === "owner" ? parsed.data.deliveryId : undefined) ?? ambient.newId();
					const outcome = deliveries.accept({
						deliveryId,
						team: targetWs?.data.teamName ?? localName,
						channelJobId,
						from,
						body: msgBody || "",
						...(hasFiles ? { files, messageId } : {}),
						...(riding ? { awareness: riding } : {}),
						...(disposition ? { disposition } : {}),
						enqueuedAt: ambient.now(),
					});
					if (outcome === "refused") {
						store.abort(anchor);
						return jsonResponse(
							{ error: `"${qualifiedTo}" has too many messages waiting; nothing was accepted` },
							503,
						);
					}
					// Migration is a refusal.
					if (outcome === "migrating") {
						store.abort(anchor);
						return jsonResponse({ error: `this Gateway is migrating; nothing was accepted` }, 503);
					}
					console.log(`[send] channel_push ${outcome} for ${qualifiedTo} [${channelJobId}] from ${from}`);
					// Renews the delivery hold.
					if (ingress.kind === "gateway" && hasFiles && blobUploader) {
						for (const blobId of new Set(files.flatMap((file) => (file.blobId ? [file.blobId] : [])))) {
							fireAndForget(
								"relay hold",
								blobUploader.hold(blobId, holdIdFor(deliveryId, blobId), BLOB_HOLD_MAX_MS),
							);
						}
					}
				} else {
					const channelPayload: Record<string, unknown> = {
						type: "channel_push",
						from,
						body: msgBody || "",
						session_id: channelJobId,
					};
					if (hasFiles) {
						channelPayload.message_id = messageId;
						channelPayload.files = files;
					}
					const activeWs = subs ? getAllActiveWs(subs) : [];
					if (activeWs.length === 0) {
						throw new Error(`Team "${qualifiedTo}" has no active connections`);
					}
					if (riding) channelPayload.awareness = riding;
					if (disposition) channelPayload.disposition = disposition;
					const payload = JSON.stringify(channelPayload);

					let took = false;
					for (const ws of activeWs) {
						if (!ws.data.handshakeConfirmed && ws.data.teamName) {
							repushHandshake?.(ws.data.teamName, ws.data.subId);
						}
						if (reached(sendOn(ws, payload, `channel_push to ${qualifiedTo}`))) took = true;
					}
					// Without the durable queue behind it, a message nobody took is simply lost.
					if (!took) throw new Error(`Team "${qualifiedTo}" took none of the message`);

					console.log(
						`[send] channel_push to ${qualifiedTo} [${channelJobId}]${messageId ? ` msg=${messageId.slice(0, 8)}` : ""} from ${from} (${activeWs.length} sub-session${activeWs.length > 1 ? "s" : ""})`,
					);
				}

				if (targetWs && !targetWs.data.virtual) {
					const toAddr = target.address;
					if (inboundSessionId) {
						mirrorPeer(toAddr, from, toAddr.canonical, { body: msgBody, files });
					} else if (ingress.kind === "session") {
						const fromAddr = tryLocalAddress(from);
						if (fromAddr && provedLocalSession(ingress.req)) {
							mirrorPeer(fromAddr, fromAddr.canonical, toAddr.canonical, { body: msgBody, files });
							mirrorPeer(toAddr, fromAddr.canonical, toAddr.canonical, { body: msgBody, files });
						}
					}
				}

				store.commit(anchor);
				return jsonResponse({
					session_id: channelJobId,
					status: "running",
					message: `Message pushed to ${localName} via channel. Responses will be pushed back automatically.`,
				});
			} catch (err) {
				if (anchor) store.abort(anchor);
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[send] channel error:`, message);
				return jsonResponse({ error: message }, 500);
			}
		}

		return jsonResponse({ error: "unsupported connection mode" }, 400);
	}

	/**
	 * The key an owner send will anchor on, for a caller that must answer before the send resolves.
	 * Reads the same owner and the same address rules the send does. A wake that resolves a
	 * different team can still move it, so the send's own answer wins where both exist.
	 */
	function ownerSessionKey(to: string, targetDomain?: string): string {
		const owner = ownerId?.();
		if (!owner) return "";
		const parsed = parseTarget(to, localDomain, localGatewayId);
		if (!parsed || parsed instanceof SpawnPoint) return "";
		if (parsed.domain !== localDomain || parsed.gateway !== localGatewayId) {
			const realDomain = parsed.domain !== localDomain ? parsed.domain : targetDomain;
			const address = Address.of(
				targetDomainId(parsed.gateway, realDomain) ?? localDomain,
				parsed.gateway,
				parsed.spawn,
				parsed.session,
			);
			return storeKey({ kind: "conv", conversationId: owner, address });
		}
		const local = resolveLocalTarget(to);
		return local ? storeKey({ kind: "conv", conversationId: owner, address: local.address }) : "";
	}

	async function sendFromOwner(body: Record<string, unknown>): Promise<Response> {
		const owner = ownerId?.();
		if (!owner) return jsonResponse({ error: "this Gateway has no owner to send as" }, 409);
		return send({ kind: "owner", ownerId: owner }, body);
	}

	async function sendFromSession(req: Request, body: Record<string, unknown>): Promise<Response> {
		return send({ kind: "session", req }, body);
	}

	async function acceptGatewaySend(body: Record<string, unknown>): Promise<Response> {
		return send({ kind: "gateway" }, body);
	}

	return { sendFromOwner, sendFromSession, acceptGatewaySend, ownerSessionKey };
}
