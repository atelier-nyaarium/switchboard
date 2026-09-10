import { withinMs } from "../../shared/ambient.js";
import type { ConsoleOp, ConsoleOpResult } from "../../shared/console-protocol.js";
import { fenced, MIGRATING } from "../../shared/migration-fence.js";
import { ownerKeyId } from "../../shared/owner-id.js";
import { DELIVERY_OP_KINDS, TOLERATED_DELIVERY_OP_KINDS, VALUE_OP_KINDS } from "../../shared/schemasConsoleOp.js";
import { type Routine, routineSessionName } from "../../shared/schemasRoutine.js";
import { answerBlobOp } from "../blobOps.js";
import {
	RESERVE_OP,
	type ReserveResult,
	reserveConversation,
	routineOwns,
	routineTeam,
} from "../routines/reservation.js";
import { createCrossDomainHandlers } from "./consoleCrossDomain.js";
import { createRunbookFireHandler } from "./consoleRunbookFire.js";
import { createSessionLifecycleHandlers } from "./consoleSessionLifecycle.js";
import { createConsoleTargets } from "./consoleTargets.js";
import { createTerminalHandlers } from "./consoleTerminal.js";
import {
	type ConsoleHandlerDeps,
	CREATE_SESSION_BOUND_MS,
	FAKE_REQ,
	SEND_BOUND_MS,
	type SendRouteJson,
} from "./consoleTypes.js";

export type { ConsoleHandlerDeps, ConsoleRoutes } from "./consoleTypes.js";
export { CREATE_SESSION_BOUND_MS } from "./consoleTypes.js";

export function createConsoleDispatcher({
	routes,
	localGatewayId,
	localDomainId,
	ambient,
	sendBoundMs = SEND_BOUND_MS,
	createSessionBoundMs = CREATE_SESSION_BOUND_MS,
	isTrustedCatalogProject,
	dropSessionResume,
	sessionStore,
	domain,
	blobStore,
	fetchBlobFromGateway,
	relayToHost,
	tryWakeTeam,
	isWakeInFlight,
	joinCreate,
	awaitRegister,
	crossDomain,
	crossDomainShare,
	unlinkDomain,
	untrustOwner,
	durableOpStore,
	vault,
	runbooks,
	routines,
	policies,
	onSessionEnded,
}: ConsoleHandlerDeps) {
	const targets = createConsoleTargets({ localDomainId, localGatewayId, isTrustedCatalogProject });
	const terminalOps = createTerminalHandlers({ targets, relayToHost, sessionStore });
	const sessionLifecycle = createSessionLifecycleHandlers({
		targets,
		createSessionBoundMs,
		ambient,
		relayToHost,
		tryWakeTeam,
		isWakeInFlight,
		joinCreate,
		awaitRegister,
		dropSessionResume,
		onSessionEnded,
		sessionStore,
	});
	const crossDomainOps = createCrossDomainHandlers({
		routes,
		targets,
		domain,
		crossDomain,
		crossDomainShare,
		unlinkDomain,
		untrustOwner,
	});
	const runbookFire = createRunbookFireHandler({
		targets,
		getRunbook: (runbookId) => runbooks?.get(runbookId) ?? null,
		createSession: (op, conv, opId) => sessionLifecycle.createSession(op, conv, opId),
		awaitRegister,
		deliver: async (to, body, ctx) => {
			const res = await routes.sendFromOwner({ from: ctx.device, to, body, channelOnly: true });
			const json = (await res.json().catch(() => ({}))) as SendRouteJson;
			if (!res.ok) return { ok: false, error: json.error };
			appendIfLive(
				ctx.conversationId,
				// Use route-minted key.
				{ kind: "sent", session_id: json.session_id ?? "", opId: ctx.opId, body },
				`sent:${ctx.conversationId}:${ctx.opId}`,
			);
			return { ok: true };
		},
	});
	const ownerByConversation = new Map<string, string>();
	const firingNow = new Set<string>();
	const appendIfLive = (
		conversationId: string,
		entry: import("../../shared/console-protocol.js").MailboxInput,
		dedupeKey?: string,
	): undefined | typeof MIGRATING => {
		if (fenced()) return MIGRATING;
		const ownerId = ownerByConversation.get(conversationId);
		if (!ownerId) return;
		const delivered = routes.deliverToOwner({
			entry: entry as import("../../shared/federation-protocol.js").ConsolePushEntry,
			dedupeKey: dedupeKey ?? ambient.newId(),
			label: "console-device",
		});
		return delivered ? undefined : fenced() ? MIGRATING : undefined;
	};

	async function dispatch(
		op: ConsoleOp,
		device: string,
		conversationId: string,
		ownerId: string,
		opId: string,
		ownerSignPub: string,
		generation = 0,
	): Promise<ConsoleOpResult> {
		switch (op.kind) {
			case "send": {
				const expectedSession = routes.ownerSessionKey(op.to, op.domainId);
				const sendPromise = routes.sendFromOwner({
					from: device,
					to: op.to,
					targetDomainId: op.domainId,
					body: op.body,
					files: op.files,
					channelOnly: true,
				});

				const winner = await withinMs(ambient, sendPromise, sendBoundMs);

				if (winner === null) {
					void sendPromise
						.then(async (res) => {
							if (res.ok) {
								const appended = appendIfLive(
									conversationId,
									{
										kind: "sent",
										session_id: expectedSession,
										opId,
										body: op.body,
										files: op.files,
									},
									`sent:${conversationId}:${opId}`,
								);
								if (appended === MIGRATING) {
									evictOpCacheIfStillOwned(conversationId, opId, op.kind, generation);
									return;
								}
								durableOpStore?.markComplete(conversationId, durableOpKey(op.kind, opId), {
									session_id: expectedSession,
									status: "sent",
								});
								return;
							}
							const json = (await res.json().catch(() => ({}))) as SendRouteJson;
							appendIfLive(conversationId, {
								kind: "reply",
								session_id: expectedSession,
								status: "error",
								body: json.error ?? `send to "${op.to}" failed`,
							});
							evictOpCacheIfStillOwned(conversationId, opId, op.kind, generation);
						})
						.catch(() => {
							evictOpCacheIfStillOwned(conversationId, opId, op.kind, generation);
						});
					return { session_id: expectedSession, status: "running" };
				}

				const json = (await winner.json()) as SendRouteJson;
				if (!winner.ok) throw new Error(json.error ?? "send failed");
				const sendResult = { session_id: json.session_id ?? "", status: json.status ?? "running" };
				const appended = appendIfLive(
					conversationId,
					{ kind: "sent", session_id: expectedSession, opId, body: op.body, files: op.files },
					`sent:${conversationId}:${opId}`,
				);
				if (appended === MIGRATING) throw new Error(MIGRATING);
				durableOpStore?.markComplete(conversationId, durableOpKey(op.kind, opId), sendResult);
				return sendResult;
			}

			case "respond": {
				const res = routes.respond(
					FAKE_REQ,
					{
						session_id: op.session_id,
						status: op.status,
						response: op.response,
						replyAsJson: op.replyAsJson,
						files: op.files,
					},
					{
						consoleSender: true,
						onFederatedSettled: durableOpStore
							? (ok) => {
									if (ok) {
										durableOpStore.markComplete(conversationId, durableOpKey(op.kind, opId), {
											delivered: true,
										});
									} else {
										evictOpCacheIfStillOwned(conversationId, opId, op.kind, generation);
									}
								}
							: undefined,
					},
				);
				const json = (await res.json()) as { error?: string; federated?: boolean; delivered?: boolean };
				if (!res.ok) throw new Error(json.error ?? "respond failed");
				if (!json.federated) {
					if (json.delivered === false) {
						evictOpCacheIfStillOwned(conversationId, opId, op.kind, generation);
					} else {
						durableOpStore?.markComplete(conversationId, durableOpKey(op.kind, opId), { delivered: true });
					}
				}
				return { delivered: true };
			}

			case "peek":
				return terminalOps.peek(op);

			case "tmux_send":
				return terminalOps.tmuxSend(op, conversationId, opId);

			case "list_dirs":
				return terminalOps.listDirs(op);

			case "blob_stat":
			case "blob_put":
			case "blob_get":
				// Fetch Router cache before the source machine.
				return answerBlobOp(blobStore, op, fetchBlobFromGateway);

			case "create_session":
				return sessionLifecycle.createSession(op, conversationId, opId);

			case "reload_plugins":
				return terminalOps.reloadPlugins(op, conversationId, opId);

			case "forget":
				return sessionLifecycle.forget(op, conversationId, opId);

			case "close_session":
				return sessionLifecycle.closeSession(op, conversationId, opId);

			case "rename_session":
				return sessionLifecycle.renameSession(op);

			case "wake":
				return sessionLifecycle.wake(op);

			case "cross_domain_listen":
				return crossDomainOps.listen(op);

			case "cross_domain_request":
				return crossDomainOps.request(op);

			case "cross_domain_confirm":
				return crossDomainOps.confirm(op);

			case "cross_domain_listen_state":
				return crossDomainOps.listenState(op);

			case "cross_domain_cancel":
				return crossDomainOps.cancel(op);

			case "cross_domain_share":
				return crossDomainOps.share(op);

			case "cross_domain_unshare":
				return crossDomainOps.unshare(op);

			case "cross_domain_list_shares":
				return crossDomainOps.listShares(op);

			case "cross_domain_list_peers":
				return crossDomainOps.listPeers(op);

			case "cross_domain_unlink":
				return crossDomainOps.unlink(op);

			case "cross_domain_untrust":
				return crossDomainOps.untrust(op);

			case "vault_answer":
				return requireVault().answer(op.requestId, op.decision, op.value, op.note);

			case "vault_grants":
				return requireVault().grants();

			case "vault_revoke":
				return requireVault().revoke(op.grantId);

			case "runbook_list":
				return requireRunbooks().list();

			case "runbook_put":
				return requireRunbooks().put(op.runbook, { base: op.baseRevision, overwrite: op.overwrite });

			case "runbook_delete":
				return requireRunbooks().remove(op.runbookId);

			case "runbook_preview":
				return runbookFire.preview(op);

			case "runbook_fire": {
				if (!durableOpStore) throw new Error("firing a runbook needs the idempotency store");
				const key = durableOpKey(op.kind, opId);
				const held = durableOpStore.get(conversationId, key);
				if (held?.state === "complete") return held.result;
				if (firingNow.has(key)) return { fired: false, reason: "this runbook is already firing" };
				const generation = durableOpStore.markInFlight(conversationId, key);
				firingNow.add(key);
				const release = () => {
					firingNow.delete(key);
					if (generation !== null) durableOpStore.clear(conversationId, key, generation);
				};
				try {
					const result = await runbookFire.fire(op, { conversationId, opId, device, ownerId });
					if (!result.fired) {
						release();
						return result;
					}
					durableOpStore.markComplete(conversationId, key, result);
					if (durableOpStore.get(conversationId, key)?.state === "complete") firingNow.delete(key);
					return result;
				} catch (error) {
					release();
					throw error;
				}
			}

			case "routine_list":
				return requireRoutines().list();

			case "routine_put":
				return requireRoutines().put(op.routine, op.baseRevision);

			case "routine_next":
				return requireRoutines().nextAt(op.routine);

			case "routine_delete":
				return requireRoutines().remove(op.routineId);

			case "routine_enable":
				return requireRoutines().enable(op.routineId, op.enabled, op.baseRevision);

			case "routine_run_now":
				return requireRoutines().runNow(op.routineId, op.occurrenceId);

			case "routine_run":
				return requireRoutines().run(op.routineId);

			case "routine_dismiss":
				return requireRoutines().dismiss(op.routineId, op.occurrenceId);

			case "policy_list":
				return requirePolicies().list();

			case "policy_put":
				return requirePolicies().put(op.policy, op.baseRevision);

			case "policy_delete":
				return requirePolicies().remove(op.policyId, op.baseRevision);

			case "policy_enable":
				return requirePolicies().enable(op.policyId, op.enabled, op.baseRevision);

			default: {
				// Exhaustive by type.
				const unhandled: never = op;
				throw new Error(`unhandled console op ${(unhandled as ConsoleOp).kind}`);
			}
		}
	}

	function requireRoutines() {
		if (!routines) throw new Error("routines are not available on this Gateway");
		return routines;
	}

	function requirePolicies() {
		if (!policies) throw new Error("policies are not available on this Gateway");
		return policies;
	}

	function requireVault() {
		if (!vault) throw new Error("vault is not available on this Gateway");
		return vault;
	}

	function requireRunbooks() {
		if (!runbooks) throw new Error("runbooks are not available on this Gateway");
		return runbooks;
	}

	function durableOpKey(kind: string, opId: string): string {
		return `${kind}:${opId}`;
	}

	function evictOpCacheIfStillOwned(conv: string, opId: string, kind: string, generation: number): void {
		durableOpStore?.clear(conv, durableOpKey(kind, opId), generation);
	}

	async function handleValue(
		op: ConsoleOp,
		device: string,
		conversationId: string,
		opId: string,
		ownerSignPub: string,
	): Promise<ConsoleOpResult> {
		if (!VALUE_OP_KINDS.has(op.kind)) throw new Error("value op kind is not allowed");
		ownerByConversation.set(conversationId, ownerKeyId(ownerSignPub));
		return dispatch(op, device, conversationId, ownerKeyId(ownerSignPub), opId, ownerSignPub);
	}

	async function handleDelivery(
		op: ConsoleOp,
		device: string,
		conversationId: string,
		opId: string,
		ownerSignPub: string,
	): Promise<ConsoleOpResult> {
		if (!DELIVERY_OP_KINDS.has(op.kind) && !TOLERATED_DELIVERY_OP_KINDS.has(op.kind))
			throw new Error("delivery op kind is not allowed");
		ownerByConversation.set(conversationId, ownerKeyId(ownerSignPub));
		return dispatch(op, device, conversationId, ownerKeyId(ownerSignPub), opId, ownerSignPub);
	}

	/**
	 * A routine's own session, named from the routine so no stale id is stored. The host reattaches a
	 * live session and launches a gone one, so this recreates it too.
	 */
	async function reserveRoutineSession(routine: Routine): Promise<ReserveResult> {
		const team = routineTeam(routine);
		// Adopting a session somebody else made would run the routine, and later its grant, inside
		// one the owner opened for something else.
		if (!routineOwns(sessionStore?.getByTeam(team), routine)) return { kind: "taken" };
		const made = await sessionLifecycle.createSession(
			{
				kind: "create_session",
				target: routine.target.spawn,
				sessionName: routineSessionName(routine.id),
				...(routine.target.workdir ? { workdir: routine.target.workdir } : {}),
			},
			reserveConversation(routine),
			RESERVE_OP,
		);
		// Still launching is not yet reachable.
		return made.status === "pending" ? { kind: "pending" } : { kind: "ok", team };
	}

	return { handleValue, handleDelivery, reserveRoutineSession };
}
