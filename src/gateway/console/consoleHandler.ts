import { withinMs } from "../../shared/ambient.js";
import { ASSISTANT_TEAM } from "../../shared/assistant-session.js";
import { type CliRefusal, pickAt } from "../../shared/cli-resolve.js";
import {
	type ConsoleOp,
	type ConsoleOpResult,
	CREATE_SESSION_BOUND_MS,
	SEND_BOUND_MS,
} from "../../shared/console-protocol.js";
import { launchPlaceOf } from "../../shared/host-spawn.js";
import { fenced, MIGRATING } from "../../shared/migration-fence.js";
import { ownerKeyId } from "../../shared/owner-id.js";
import { DELIVERY_OP_KINDS, TOLERATED_DELIVERY_OP_KINDS, VALUE_OP_KINDS } from "../../shared/schemasConsoleOp.js";
import { isDeviceConsoleOp } from "../../shared/schemasDevices.js";
import { type HolderKey, HolderKeySchema } from "../../shared/schemasPhoneHold.js";
import { type Routine, routineSessionName } from "../../shared/schemasRoutine.js";
import type { CutPick } from "../../shared/schemasSessionCut.js";
import { type CliPick, type SessionHarness, UNPICKED_WORD } from "../../shared/session-harness.js";
import { SpawnPoint } from "../../shared/session-id.js";
import type { WorkspaceOp } from "../../shared/workspace-op.js";
import type { RoutineRun } from "../launchRecords.js";
import {
	RESERVE_OP,
	type ReserveResult,
	reserveConversation,
	routineOwns,
	routineOwnsPane,
	routineTeam,
} from "../routines/reservation.js";
import { workspaceAnswerNoting } from "../workspaceAwareness.js";
import { createContainerHandlers } from "./consoleContainers.js";
import { createCrossDomainHandlers } from "./consoleCrossDomain.js";
import { createRunbookFireHandler } from "./consoleRunbookFire.js";
import { createSessionLifecycleHandlers } from "./consoleSessionLifecycle.js";
import { createConsoleTargets } from "./consoleTargets.js";
import { createTerminalHandlers } from "./consoleTerminal.js";
import { type ConsoleHandlerDeps, CreateSessionFailedError, FAKE_REQ, type SendRouteJson } from "./consoleTypes.js";

export type { ConsoleHandlerDeps, ConsoleRoutes } from "./consoleTypes.js";

/** Host kill dedupe key. */
const ASSISTANT_HOME_CONVERSATION = "assistant-home";

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
	promptOf,
	domain,
	relayToHost,
	tryWakeTeam,
	beginLaunch,
	watchOwnerLaunch,
	watchRoutineLaunch,
	awaitsLaunch,
	isLive,
	launching,
	isWakeInFlight,
	crossDomain,
	unlinkDomain,
	untrustOwner,
	durableOpStore,
	vault,
	runbooks,
	routines,
	policies,
	cuts,
	devices,
	workspaceAsk,
	sessionControlAsk,
	workspaceChanged,
	onSessionEnded,
	forgetRefusal,
	assistant,
	installedAt,
}: ConsoleHandlerDeps) {
	const targets = createConsoleTargets({ localDomainId, localGatewayId, isTrustedCatalogProject });

	/** Named CLI, else the only one. */
	function definitePick(
		spawn: string,
		pick: CliPick | undefined,
	): { harness?: SessionHarness } | { refusal: CliRefusal } {
		const named = pick && pick !== UNPICKED_WORD ? pick : undefined;
		const chosen = pickAt({ place: launchPlaceOf(spawn), assistant: false }, named, installedAt?.(spawn));
		if ("refused" in chosen) return { refusal: chosen.refused };
		return chosen.harness ? { harness: chosen.harness } : {};
	}

	/** A session, never a spawn point: the plane serves the workspace a plugin itself holds. */
	async function workspaceOf(target: string, op: WorkspaceOp, verb = "read the workspace of") {
		const bound = targets.requireLocalComposite(target, verb);
		if (!workspaceAsk) throw new Error("this Gateway serves no workspace");
		return workspaceAnswerNoting(op, await workspaceAsk(bound.name, op), (change) =>
			workspaceChanged?.(bound.name, change),
		);
	}

	const terminalOps = createTerminalHandlers({
		targets,
		relayToHost,
		sessionStore,
		promptOf,
		sessionControlAsk,
	});
	const containers = createContainerHandlers({ targets, relayToHost });
	const sessionLifecycle = createSessionLifecycleHandlers({
		targets,
		createSessionBoundMs,
		ambient,
		relayToHost,
		tryWakeTeam,
		beginLaunch,
		watchOwnerLaunch,
		isWakeInFlight,
		...(cuts ? { cutRunning: (team: string) => cuts.running(team) } : {}),
		dropSessionResume,
		onSessionEnded,
		forgetRefusal,
		sessionStore,
	});
	const crossDomainOps = createCrossDomainHandlers({
		domain,
		crossDomain,
		unlinkDomain,
		untrustOwner,
	});
	const runbookFire = createRunbookFireHandler({
		targets,
		getRunbook: (runbookId) => runbooks?.get(runbookId) ?? null,
		createSession: (op, conv, opId, internal) => sessionLifecycle.createSession(op, conv, opId, internal),
		pick: definitePick,
		deliver: async (to, body, ctx) => {
			const res = await routes.sendFromOwner(
				{ from: ctx.device, to, body, channelOnly: true },
				{ launching: true },
			);
			const json = (await res.json().catch(() => ({}))) as SendRouteJson;
			if (!res.ok) return { ok: false, error: json.error };
			appendIfLive(
				ctx.conversationId,
				// Use route-minted key.
				{ kind: "sent", session_id: json.session_id ?? "", opId: ctx.opId, body },
				`sent:${ctx.conversationId}:${ctx.opId}`,
			);
			return { ok: true, starting: json.status === "starting" };
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
		signer: HolderKey | null,
		generation = 0,
	): Promise<ConsoleOpResult> {
		if (isDeviceConsoleOp(op)) return requireDevices()(op);
		switch (op.kind) {
			case "send": {
				const expectedSession = routes.ownerSessionKey(op.to, op.domainId);
				// Waits on a launch, so a failure reads on the message.
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

			case "workspace_tree":
				return workspaceOf(op.target, { kind: "tree", path: op.path });

			case "workspace_file":
				return workspaceOf(op.target, { kind: "read", path: op.path });

			case "workspace_outline":
				return workspaceOf(op.target, { kind: "outline", path: op.path });

			case "workspace_symbol_source":
				return workspaceOf(op.target, { kind: "symbolSource", symbolId: op.symbolId });

			case "workspace_symbol_knowledge":
				return workspaceOf(op.target, { kind: "symbolKnowledge", symbolId: op.symbolId });

			case "workspace_save_span":
				return workspaceOf(
					op.target,
					{ kind: "saveSpan", symbolId: op.symbolId, expectedSpanHash: op.expectedSpanHash, text: op.text },
					"save into the workspace of",
				);

			case "workspace_file_state":
				return workspaceOf(op.target, { kind: "fileState", path: op.path });

			case "workspace_mutate_file":
				return workspaceOf(
					op.target,
					{ kind: "mutateFile", mutation: op.mutation },
					"change a file in the workspace of",
				);

			case "workspace_symbol_facet":
				return workspaceOf(op.target, { kind: "symbolFacet", symbolId: op.symbolId, facet: op.facet });

			case "workspace_file_history":
				return workspaceOf(op.target, { kind: "fileHistory", path: op.path });

			case "workspace_paint_text":
				return workspaceOf(op.target, { kind: "paintText", path: op.path, text: op.text });

			case "create_session":
				return sessionLifecycle.createSession(op, conversationId, opId);

			case "session_cut_plan":
				return requireCuts().plan(targets.requireLocalComposite(op.target, "cut").name, op.mode, cutPickOf(op));

			case "session_cut_start":
				return requireCuts().start(
					targets.requireLocalComposite(op.target, "cut").name,
					op.mode,
					cutPickOf(op),
					device,
				);

			case "reload_plugins":
				return terminalOps.reloadPlugins(op, conversationId, opId);

			case "session_prompt":
				return terminalOps.sessionPrompt(op);

			case "session_prompt_answer":
				return terminalOps.answerPrompt(op, conversationId, opId);

			case "forget":
				return sessionLifecycle.forget(op, conversationId, opId);

			case "close_session":
				return sessionLifecycle.closeSession(op, conversationId, opId);

			case "rename_session":
				return sessionLifecycle.renameSession(op);

			case "wake":
				return sessionLifecycle.wake(op);

			case "container_start":
			case "container_stop":
				return containers.relay(op, conversationId, opId);

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
					if (durableOpStore.markComplete(conversationId, key, result)) firingNow.delete(key);
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

			case "assistant_state":
				return requireAssistant().state();

			case "assistant_watcher_grants":
				return requireAssistant().setWatcherGrants(op.watcherId, op.entryIds);

			case "assistant_rule_put":
				return requireAssistant().putRule(op.watcherId, op.rule);

			case "assistant_rule_delete":
				return requireAssistant().deleteRule(op.watcherId, op.ruleId, op.baseRevision);

			case "assistant_rule_move":
				return requireAssistant().moveRule(op.watcherId, op.ruleId, op.beforeId, op.baseRevision);

			case "assistant_otherwise_put":
				return requireAssistant().putOtherwise(op.watcherId, op.otherwise);

			case "assistant_rules_preview":
				return requireAssistant().previewRule(op.watcherId, op.rule);

			case "assistant_safety":
				return requireAssistant().setSafety(op.approveEverySend);

			case "assistant_watcher_enabled":
				return requireAssistant().setWatcherEnabled(op.watcherId, op.enabled);

			case "assistant_watcher_check":
				return requireAssistant().checkWatcher(op.watcherId, device, opId);

			case "assistant_send_answer":
				return requireAssistant().answerSend(op.requestId, op.decision, op.note);

			case "phone_capability_answer":
				if (signer === null) throw new Error("phone signer is missing");
				return requireAssistant().answerPhone(op.requestId, op.answer, signer);

			case "assistant_act_answer":
				return requireAssistant().answerAct(op.requestId, op.decision, op.note);

			default: {
				const unhandled: never = op;
				throw new Error(`unhandled console op ${String(unhandled)}`);
			}
		}
	}

	function requireCuts() {
		if (!cuts) throw new Error("session cuts are not available on this Gateway");
		return cuts;
	}

	/** The pressed row, as the daemon finds a turn by it. */
	function cutPickOf(op: { rowAt?: number; rowText?: string }): CutPick | undefined {
		if (op.rowAt === undefined) return undefined;
		return { at: op.rowAt, ...(op.rowText === undefined ? {} : { text: op.rowText }) };
	}

	function requireRoutines() {
		if (!routines) throw new Error("routines are not available on this Gateway");
		return routines;
	}

	function requirePolicies() {
		if (!policies) throw new Error("policies are not available on this Gateway");
		return policies;
	}

	function requireDevices() {
		if (!devices) throw new Error("devices are not available on this Gateway");
		return devices;
	}

	function requireAssistant() {
		if (!assistant) throw new Error("the assistant is not available on this Gateway");
		return assistant;
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

	/** Router-verified phone key. */
	async function handleValue(
		op: ConsoleOp,
		device: string,
		conversationId: string,
		opId: string,
		ownerSignPub: string,
		signer: string,
	): Promise<ConsoleOpResult> {
		if (!VALUE_OP_KINDS.has(op.kind)) throw new Error("value op kind is not allowed");
		ownerByConversation.set(conversationId, ownerKeyId(ownerSignPub));
		return dispatch(
			op,
			device,
			conversationId,
			ownerKeyId(ownerSignPub),
			opId,
			ownerSignPub,
			HolderKeySchema.parse(signer),
		);
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
		return dispatch(op, device, conversationId, ownerKeyId(ownerSignPub), opId, ownerSignPub, null);
	}

	/** A routine's session, named from the routine; recreated if gone. */
	async function reserveRoutineSession(routine: Routine, run: RoutineRun): Promise<ReserveResult> {
		const team = routineTeam(routine);
		const held = sessionStore?.getByTeam(team);
		// Never adopt another's session or pane.
		const holder = sessionStore?.paneHolder(team);
		if (!routineOwns(held, routine) || !routineOwnsPane(holder, routine)) return { kind: "taken" };
		// Own session left on another spawn point.
		if (holder) {
			const target = `${localDomainId}.${localGatewayId}.${holder.team}`;
			await sessionLifecycle.forget({ kind: "forget", target }, reserveConversation(routine), RESERVE_OP, {
				released: true,
			});
		}
		if (isLive?.(team)) return { kind: "ok", team };
		// Told on the next tick; never relaunched meanwhile.
		if (awaitsLaunch?.(run)) return { kind: "launching" };
		let watched = false;
		const watch = (launchId?: string): void => {
			watched = watchRoutineLaunch?.(team, run, launchId) ?? false;
		};
		if (launching?.(team)) {
			watch();
			return watched ? { kind: "launching" } : { kind: "pending" };
		}
		// A held session keeps its CLI.
		const pick = held ? { harness: held.harness } : definitePick(routine.target.spawn, routine.target.cli);
		if ("refusal" in pick) return { kind: "launch_failed", failure: { kind: "cli", refusal: pick.refusal } };
		const made = await sessionLifecycle
			.createSession(
				{
					kind: "create_session",
					target: SpawnPoint.of(localDomainId, localGatewayId, routine.target.spawn).canonical,
					sessionName: routineSessionName(routine.id),
					...(pick.harness ? { harness: pick.harness } : {}),
					...(routine.target.workdir ? { workdir: routine.target.workdir } : {}),
				},
				reserveConversation(routine),
				RESERVE_OP,
				pick.harness ? { watch } : { unpicked: true, watch },
			)
			.catch((error: unknown) => {
				if (error instanceof CreateSessionFailedError) return error.failure;
				throw error;
			});
		if ("kind" in made) return { kind: "launch_failed", failure: made };
		if (!("status" in made)) return { kind: "ok", team };
		return watched ? { kind: "launching" } : { kind: "pending" };
	}

	/** Ends the pane and record; refused while it wakes. */
	async function forgetAssistant(): Promise<void> {
		const target = `${localDomainId}.${localGatewayId}.${ASSISTANT_TEAM}`;
		await sessionLifecycle.forget({ kind: "forget", target }, ASSISTANT_HOME_CONVERSATION, ambient.newId(), {
			released: true,
		});
	}

	return { handleValue, handleDelivery, reserveRoutineSession, forgetAssistant };
}
