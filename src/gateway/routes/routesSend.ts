import type { Ambient } from "../../shared/ambient.js";
import { ASSISTANT_TEAM, isAssistantRecord } from "../../shared/assistant-session.js";
import type { FederatedOp } from "../../shared/federation-protocol.js";
import { HOST_SPAWN } from "../../shared/host-spawn.js";
import type { DeliveryOrigin, EventMember } from "../../shared/pending-delivery-store.js";
import type { JobContract, LocalReply, PendingJobStore, Reservation } from "../../shared/pending-job-store.js";
import { BLOB_HOLD_MAX_MS } from "../../shared/router-protocol.js";
import type { AssistantSendIntent, SendGuard } from "../../shared/schemasAssistantSend.js";
import {
	Address,
	composeSessionName,
	parseSessionName,
	parseTarget,
	SpawnPoint,
	storeKey,
} from "../../shared/session-id.js";
import type { ChannelFile, GatewayConfig, ResponsePayload } from "../../shared/types.js";
import type { AwarenessBank, AwarenessLease } from "../awarenessBank.js";
import type { ChannelDeliveryCoordinator } from "../channelDelivery.js";
import { fireAndForget } from "../fireAndForget.js";
import { holdIdFor } from "../router/blobUploader.js";
import { fileBytes, getTeamMode, jsonResponse, MAX_RESPONSE_FILE_BYTES, SendRequestSchema } from "../routeSchemas.js";
import { presentedByRequest, type SessionAuthority } from "../sessionAuthority.js";
import { POST_WAKE_SETTLE_MS, type WakeCreate, type WakeResult } from "../wake.js";
import { type ConversationRegistry, resolveLiveIncarnation, type TeamRegistry } from "../wsTypes.js";
import type { CallerScope } from "./callerGuards.js";

type ConsolePushOps = ReturnType<typeof import("../consolePushOps.js").createConsolePushOps>;

/** Send clearance record. */
export interface SendRecord {
	key: string;
	guard: SendGuard;
}

/** Guard-only assistant ingress. */
type Ingress =
	| { kind: "owner"; ownerId: string; scheduled?: true }
	| { kind: "session"; req: Request }
	| { kind: "gateway" }
	| { kind: "assistant"; conversationId: string; record: SendRecord };

export type BoundTarget =
	| { ok: true; target: string; friendDomain?: string; exists: boolean | null }
	| { ok: false; error: string; status: number };

export interface SendRoutesDeps {
	config: GatewayConfig;
	localDomain: string;
	ambient: Pick<Ambient, "now" | "newId" | "setTimer">;
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	store: Pick<PendingJobStore<ResponsePayload>, "reserve" | "commit" | "abort">;
	tryWakeTeam: (team: string, createOpts?: WakeCreate) => Promise<WakeResult>;
	sessionStore?: import("../../shared/session-store.js").SessionStore;
	routerClient?: Pick<import("../router/routerClient.js").RouterClient, "isConnected"> | null;
	auth?: SessionAuthority;
	awareness?: Pick<AwarenessBank, "prepareFor">;
	deliveries: ChannelDeliveryCoordinator;
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

	type LocalTarget = { name: string; address: Address };
	type Reached =
		| {
				ok: true;
				localName: string;
				target: LocalTarget;
				qualifiedTo: string;
				targetWs: ReturnType<typeof resolveLiveIncarnation>;
		  }
		| { ok: false; error: string };

	async function reach(resolved: LocalTarget, createOpts?: WakeCreate): Promise<Reached> {
		let target = resolved;
		let localName = target.name;
		let qualifiedTo = target.address.canonical;
		let targetWs = resolveLiveIncarnation(registry, sessionStore, localName);
		if (targetWs) return { ok: true, localName, target, qualifiedTo, targetWs };
		const woken = await tryWakeTeam(localName, createOpts);
		if (!woken.ok) {
			if (woken.error) return { ok: false, error: woken.error };
			if (woken.errorKind === "disconnected") {
				return {
					ok: false,
					error: `machine "${target.address.gateway}" is not reachable, so "${qualifiedTo}" was never woken`,
				};
			}
			// Timeout is ambiguous because launch may still succeed.
			if (woken.errorKind === "timeout")
				return { ok: false, error: `"${qualifiedTo}" is still starting; try again shortly` };
			return { ok: true, localName, target, qualifiedTo, targetWs };
		}
		if (woken.resolvedTeam && woken.resolvedTeam !== localName) {
			localName = woken.resolvedTeam;
			const address = tryLocalAddress(localName);
			if (address) {
				target = { name: localName, address };
				qualifiedTo = address.canonical;
			}
		}
		await new Promise((r) => ambient.setTimer(() => r(undefined), POST_WAKE_SETTLE_MS));
		targetWs = resolveLiveIncarnation(registry, sessionStore, localName);
		return { ok: true, localName, target, qualifiedTo, targetWs };
	}

	/**
	 * A senderless event: no `from`, conversation or return route, so no reply is owed. `compose` runs
	 * once the session is reached; null there sends nothing. Null when it is delivered, durably queued
	 * or empty; otherwise why not.
	 */
	async function deliverEvent(event: {
		to: string;
		compose: () => readonly EventMember[] | null;
	}): Promise<string | null> {
		const target = resolveLocalTarget(event.to);
		if (!target) return `"${event.to}" is not a session on this Gateway`;
		const arrived = await reach(target);
		if (!arrived.ok) return arrived.error;
		const members = event.compose();
		if (!members || members.length === 0) return null;
		const outcome = deliveries.acceptEvent({
			team: arrived.targetWs?.data.teamName ?? arrived.localName,
			members,
			enqueuedAt: ambient.now(),
		});
		if (outcome === "refused") return `"${arrived.qualifiedTo}" has too many messages waiting`;
		if (outcome === "migrating") return "this Gateway is migrating";
		console.log(`[send] event ${outcome} for ${arrived.qualifiedTo} (${members.length})`);
		return null;
	}

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
		record?: SendRecord;
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
			record,
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
			// The relay strips blob ids for a cross-Domain target.
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
			const guarded = record ? { guard: record.guard } : {};
			mirrorPeer(senderAddr, senderCanonical, targetAddr.canonical, { body, files, ...guarded }, record?.key);
		}
		return jsonResponse({
			session_id: srcSession,
			status: "running",
			target: qualifiedTo,
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
		const fromConversationId =
			ingress.kind === "owner"
				? ingress.ownerId
				: ingress.kind === "assistant"
					? ingress.conversationId
					: parsed.data.fromConversationId;
		if (ingress.kind === "session") {
			// Its token, whatever `from` says.
			if (auth?.presentsOwnLaunchToken(ASSISTANT_TEAM, presentedByRequest(ingress.req))) {
				return jsonResponse({ error: "the assistant sends through its own road" }, 403);
			}
			// Session callers prove identity.
			const refused = refuseImpersonation(ingress.req, from, "session");
			if (refused) return refused;
			// Check includes unconfirmed sessions.
			if (isAssistantRecord(sessionStore?.getByTeam(from))) {
				return jsonResponse({ error: "the assistant sends through its own road" }, 403);
			}
			const holder = fromConversationId ? conversationRegistry.get(fromConversationId) : undefined;
			if (auth && !auth.satisfies(auth.toAnswerFor(holder), presentedByRequest(ingress.req))) {
				console.warn(`[auth] refused a send claiming another session's conversation`);
				return jsonResponse({ error: "conversation is not this caller's" }, 403);
			}
		}
		const record = ingress.kind === "assistant" ? ingress.record : undefined;
		const origin: DeliveryOrigin =
			ingress.kind === "assistant"
				? "session"
				: ingress.kind === "owner" && ingress.scheduled
					? "routine"
					: ingress.kind;
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
				record,
			});
		}

		const resolved = resolveLocalTarget(to);
		if (!resolved) {
			return jsonResponse({ error: `Gateway for "${to}" is not reachable from this Gateway` }, 404);
		}

		const requested = resolved.name;
		if (requested === "host") {
			return jsonResponse(
				{
					error: `"${requested}" is a reserved name; crosstalk_send targets container teams only.`,
				},
				400,
			);
		}
		// Only the owner opens a conversation with the assistant, and it reads as absent.
		if (ingress.kind !== "owner" && isAssistantRecord(sessionStore?.getByTeam(requested))) {
			return jsonResponse({ error: `no session named "${to}"` }, 404);
		}

		// Wake or create the target before delivery.
		const mintedFrom =
			inboundSessionId ?? (fromConversationId ? `${fromConversationId}:${resolved.name}` : undefined);
		// The guard cleared it, by card or by the owner's setting.
		const cleared = record ? { cleared: true as const } : {};
		const arrived = await reach(resolved, { displayLabel, mintedFrom, ...cleared });
		if (!arrived.ok) return jsonResponse({ error: arrived.error }, 404);
		const { localName, target, qualifiedTo, targetWs } = arrived;

		const subs = targetWs ? registry.get(targetWs.data.teamName ?? localName) : undefined;

		const targetMode = subs ? getTeamMode(subs) : "channel";

		if (channelOnly && targetMode !== "channel") {
			return jsonResponse(
				{ error: `"${localName}" is a CLI-mode agent; console chat supports channel-mode (Claude) teams only` },
				409,
			);
		}

		if (targetMode === "channel") {
			let anchor: Reservation | null = null;
			let lease: AwarenessLease | null = null;
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
				// Captured once so retries preserve the same row data, and settled by whether the message lands.
				lease = awareness?.prepareFor(localName) ?? null;
				const riding = lease?.awareness;

				// Owners name delivery rows.
				const deliveryId = (ingress.kind === "owner" ? parsed.data.deliveryId : undefined) ?? ambient.newId();
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
					origin,
				});
				if (outcome === "refused") {
					store.abort(anchor);
					lease?.release();
					return jsonResponse(
						{ error: `"${qualifiedTo}" has too many messages waiting; nothing was accepted` },
						503,
					);
				}
				// Migration is a refusal.
				if (outcome === "migrating") {
					store.abort(anchor);
					lease?.release();
					return jsonResponse({ error: `this Gateway is migrating; nothing was accepted` }, 503);
				}
				lease?.commit();
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

				if (record) {
					// Per-clearance record.
					const fromAddr = localAddress(ASSISTANT_TEAM);
					const sent = { body: msgBody, files, guard: record.guard };
					mirrorPeer(fromAddr, fromAddr.canonical, target.address.canonical, sent, record.key);
					mirrorPeer(target.address, fromAddr.canonical, target.address.canonical, sent, `${record.key}:to`);
				} else if (targetWs && !targetWs.data.virtual) {
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
					target: qualifiedTo,
					message: `Message pushed to ${localName} via channel. Responses will be pushed back automatically.`,
				});
			} catch (err) {
				if (anchor) store.abort(anchor);
				lease?.release();
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

	async function sendFromOwner(body: Record<string, unknown>, options: { scheduled?: true } = {}): Promise<Response> {
		const owner = ownerId?.();
		if (!owner) return jsonResponse({ error: "this Gateway has no owner to send as" }, 409);
		return send({ kind: "owner", ownerId: owner, ...options }, body);
	}

	async function sendFromSession(req: Request, body: Record<string, unknown>): Promise<Response> {
		return send({ kind: "session", req }, body);
	}

	async function acceptGatewaySend(body: Record<string, unknown>): Promise<Response> {
		return send({ kind: "gateway" }, body);
	}

	/** Resolve target before delivery. */
	function bindTarget(to: string): BoundTarget {
		let parsed: Address | SpawnPoint;
		try {
			parsed = parseTarget(to, localDomain, localGatewayId);
		} catch {
			return { ok: false, error: `"${to}" is not an address`, status: 400 };
		}
		if (parsed instanceof SpawnPoint) {
			return {
				ok: false,
				error: `"${to}" is a spawn-point, not a session; address a session as spawn.session`,
				status: 400,
			};
		}
		if (parsed.domain !== localDomain || parsed.gateway !== localGatewayId) {
			const named = parsed.domain !== localDomain ? parsed.domain : undefined;
			const friend = targetDomainId(parsed.gateway, named);
			if (named && friend !== named) {
				return { ok: false, error: `Gateway "${parsed.gateway}" is not linked from this Domain`, status: 404 };
			}
			const domain = friend ?? localDomain;
			const address = Address.of(domain, parsed.gateway, parsed.spawn, parsed.session);
			return { ok: true, target: address.canonical, ...(friend ? { friendDomain: friend } : {}), exists: null };
		}
		const local = resolveLocalTarget(to);
		if (!local) return { ok: false, error: `Gateway for "${to}" is not reachable from this Gateway`, status: 404 };
		const held = sessionStore?.getByTeam(local.name);
		if (local.name === HOST_SPAWN || isAssistantRecord(held)) {
			return { ok: false, error: `no session named "${to}"`, status: 404 };
		}
		return { ok: true, target: local.address.canonical, exists: held !== undefined };
	}

	/** Deliver approved binding unchanged. */
	async function sendFromAssistant(args: {
		intent: AssistantSendIntent;
		files: ChannelFile[];
		conversationId: string;
		record: SendRecord;
	}): Promise<Response> {
		const { intent } = args;
		return send(
			{ kind: "assistant", conversationId: args.conversationId, record: args.record },
			{
				opId: args.record.key,
				from: ASSISTANT_TEAM,
				to: intent.target,
				body: intent.body,
				// Creation flag gates session creation.
				...(intent.displayLabel && intent.createsSession ? { displayLabel: intent.displayLabel } : {}),
				...(intent.disposition ? { disposition: intent.disposition } : {}),
				...(args.files.length > 0 ? { files: args.files } : {}),
			},
		);
	}

	return {
		sendFromOwner,
		sendFromSession,
		acceptGatewaySend,
		ownerSessionKey,
		deliverEvent,
		bindTarget,
		sendFromAssistant,
	};
}
