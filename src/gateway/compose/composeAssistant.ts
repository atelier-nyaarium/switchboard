// The assistant's one session and its watchers, placed where the Router's home record names.

import { type Ambient, withinMs } from "../../shared/ambient.js";
import {
	ASSISTANT_RESERVE_KEY,
	ASSISTANT_SESSION_NAME,
	ASSISTANT_SPAWN,
	ASSISTANT_TEAM,
	isAssistantRecord,
} from "../../shared/assistant-session.js";
import { SEND_BOUND_MS } from "../../shared/console-protocol.js";
import { openDurable } from "../../shared/durable-store.js";
import { isSpawnWorkdirPath } from "../../shared/host-op.js";
import { createFifo } from "../../shared/keyed-fifo.js";
import type { PendingDelivery } from "../../shared/pending-delivery-store.js";
import type { AssistantWatcher, ConsoleAssistantStateResult } from "../../shared/schemasAssistant.js";
import { actionsOf, GITHUB_WATCHER_ID } from "../../shared/schemasAssistantActions.js";
import type { AssistantHomeRecord, AssistantHomeSealed } from "../../shared/schemasAssistantHome.js";
import { eventLines } from "../../shared/schemasAssistantInbox.js";
import {
	canonicalRule,
	decideEvent,
	fieldsOf,
	firstMatch,
	invalidRules,
	ruleMatches,
} from "../../shared/schemasAssistantRules.js";
import type { AssistantSendRequest } from "../../shared/schemasAssistantSend.js";
import type { SessionBaseline } from "../../shared/session-baseline.js";
import { ASSISTANT_COMMANDS } from "../../shared/session-commands.js";
import { type ActionRecord, createActionDispatch } from "../assistant/actionDispatch.js";
import { createAssistantRoutes, type Handler } from "../assistant/assistantRoutes.js";
import { createGithubClient, type GithubClientDeps, type TokenRead } from "../assistant/githubClient.js";
import { GithubDone } from "../assistant/githubDone.js";
import { createGithubWatcher } from "../assistant/githubWatcher.js";
import { createHomeFollow, type HomeFollowEffects } from "../assistant/homeFollow.js";
import { createHomeMarkStore } from "../assistant/homeMark.js";
import { createInboxListing } from "../assistant/inboxListing.js";
import { createRulesStore } from "../assistant/rulesStore.js";
import { createOriginMarker, createSafetyStore, createSendGuard } from "../assistant/sendGuard.js";
import { type AssistantWake, createSourceLanes, type SourceLanes } from "../assistant/sourceLane.js";
import { ASSISTANT_WAITS } from "../assistant/waits.js";
import type { ListPage, ListQuery, Watcher, WatcherEvent } from "../assistant/watcher.js";
import type { WatcherActions } from "../assistant/watcherAction.js";
import { createWatcherEnabledStore } from "../assistant/watcherEnabled.js";
import { createWatcherStateStore, FRESH_STATE, unexpectedNow } from "../assistant/watcherState.js";
import type { AssistantConsoleHandlers } from "../console/consoleTypes.js";
import { presentedByRequest } from "../sessionAuthority.js";
import type { VaultRelease } from "../vault/vaultUse.js";
import type { GatewayRoutes } from "./composeRoutes.js";
import type { SessionsStage } from "./composeSessions.js";

const NEEDS_SECRET = "needs a secret";
const NOT_HERE = "the assistant does not live on this Gateway";
/** Shutdown waits this long for an owner op already running. */
const STOP_WAIT_MS = 5_000;
/** Events a preview reads. */
const PREVIEW_EVENTS = 50;
const MOVING_HERE = "the assistant is still moving here; try again shortly";

/** Owner send; null when it landed. */
export type AssistantNudge = (nudge: { from: string; body: string; deliveryId: string }) => Promise<string | null>;

/** Names the catalogued command. */
const checkNudge = (label: string) =>
	`
The owner asked you to check ${label} now.
Call ${ASSISTANT_COMMANDS.inbox.tool} with scope "new" and handle what it lists by your rules.
Reply only if something needs the owner.
	`.trim();

/** What the assistant reaches in the vault, read late. */
export interface AssistantVault {
	watcherGrants: (watcherId: string) => string[];
	setWatcherGrants: (watcherId: string, entryIds: string[]) => void;
	readForWatcher: (watcherId: string, entryId: string) => Promise<VaultRelease>;
	/** Whether this Gateway may use the entry's value. */
	usableHere: (entryId: string) => Promise<boolean>;
}

/** The federation's half of following the home, bound on each activation. */
export interface AssistantHomePort {
	open: (
		record: AssistantHomeRecord,
	) => { kind: "ok"; sealed: AssistantHomeSealed } | { kind: "refused"; reason: string };
	report: HomeFollowEffects["report"];
	/** Ends the session's pane and record; throws when refused, as while it wakes. */
	endSession: () => Promise<void>;
}

export interface AssistantStageDeps {
	dataDir: string;
	localGatewayId: string;
	/** The active Domain, which scopes the home mark. */
	domainId: () => string | null;
	ambient: Pick<Ambient, "now" | "newId" | "randomBytes" | "setTimer" | "clearTimer">;
	sessions: Pick<SessionsStage, "sessionStore" | "presence" | "sessionAuthority" | "conversationRegistry">;
	/** A checked save of the session records, which hold where it lives; throws when it did not land. */
	saveSessions: () => void;
	vault: AssistantVault;
	/** Resolve after Domain activation. */
	routes: () => Pick<GatewayRoutes, "deliverToOwner" | "ownerSessionKey" | "bindTarget" | "sendFromAssistant">;
	/** Null unless fully staged. */
	blobSize: (blobId: string) => number | null;
	/** The newest delivery acceptance. */
	lastDeliverySeq: () => number;
	fetch: GithubClientDeps["fetch"];
	/** Replaces the built-in watchers. */
	watchers?: readonly Watcher[];
}

export interface AssistantStage {
	/** Whether that session is the assistant's, which no sweep takes. */
	reserves: (team: string) => boolean;
	/** Held here and not let go: what a check-in runs in. */
	placed: () => boolean;
	/** One Router record, pushed or read at registration; a null was never written. */
	follow: (record: AssistantHomeRecord | null, how: { registered: boolean }) => Promise<void>;
	bindHome: (port: AssistantHomePort) => void;
	/** The refusal reason, or null. */
	forgetRefusal: (team: string) => string | null;
	console: AssistantConsoleHandlers;
	/** Assistant-only loopback routes. */
	routes: Map<string, Handler>;
	/** Its watchers' lines after a compaction; undefined for any other session. */
	baselineFor: (team: string) => SessionBaseline["assistant"];
	/** The send path's event road, bound on each federation activation. */
	bindWake: (wake: AssistantWake) => void;
	/** Check now's road. */
	bindNudge: (nudge: AssistantNudge) => void;
	/** Arms the watchers, once federation is active. */
	start: () => void;
	/** Final, and before the shutdown flush, so it sees no poll halfway through its write. */
	stop: () => Promise<void>;
	/** Plugin-confirmed delivery. */
	delivered: (row: PendingDelivery) => void;
	/** Pre-delivery session offer. */
	offered: (row: PendingDelivery) => void;
	/** Reply pushed to team. */
	replyPushed: (team: string) => void;
	/** Held send blob reference. */
	namesBlob: (blobId: string) => boolean;
	sessionEnded: (team: string) => void;
}

/** The vault's answer, as a watcher reads it: a missing grant stops it, a transient wait backs off. */
function tokenOf(read: VaultRelease, entryId: string): TokenRead {
	if (read.kind === "released") return { kind: "token", value: read.value, key: entryId };
	if (read.kind === "unusable") return { kind: "stopped", reason: read.reason };
	return {
		kind: "backoff",
		reason: read.kind === "unready" ? `vault unavailable: ${read.reason}` : "vault key not here yet",
	};
}

export function composeAssistant(deps: AssistantStageDeps): AssistantStage {
	const { sessions, ambient } = deps;
	const held = () => {
		const record = sessions.sessionStore.getByTeam(ASSISTANT_TEAM);
		return isAssistantRecord(record) ? record : undefined;
	};
	const isAssistant = (team: string) => team === ASSISTANT_TEAM && held() !== undefined;
	const home = openDurable(deps.dataDir, "assistant-home", (store) => createHomeMarkStore(store, deps.domainId));
	/** Its routes answer only while the home lets its lanes run. */
	const acting = (record: Parameters<typeof isAssistantRecord>[0]) => isAssistantRecord(record) && home.allowsLanes();

	const tokenFor = (watcherId: string) => async (): Promise<TokenRead> => {
		const entryId = deps.vault.watcherGrants(watcherId)[0];
		if (entryId === undefined) return { kind: "stopped", reason: NEEDS_SECRET };
		return tokenOf(await deps.vault.readForWatcher(watcherId, entryId), entryId);
	};
	const github = createGithubClient({
		fetch: deps.fetch,
		token: tokenFor(GITHUB_WATCHER_ID),
		now: () => ambient.now(),
	});
	const watchers = deps.watchers ?? [createGithubWatcher(github)];
	const actions: WatcherActions = { github_done: new GithubDone(github) };

	const watcherState = openDurable(deps.dataDir, "assistant-watchers", (store) => createWatcherStateStore(store));
	const enabled = openDurable(deps.dataDir, "assistant-watcher-enabled", (store) => createWatcherEnabledStore(store));
	// Unknown watcher returns undefined.
	const specsOf = (watcherId: string) => watchers.find((candidate) => candidate.id === watcherId)?.fieldSpecs;
	const rules = openDurable(deps.dataDir, "assistant-rules", (store) => createRulesStore({ store, specsOf }));
	const render = (watcher: Watcher, event: WatcherEvent) => eventLines({ label: watcher.label, ...event }).join("\n");

	let lanes: SourceLanes | null = null;
	let wake: AssistantWake | null = null;
	let nudge: AssistantNudge | null = null;
	let active = false;
	let ownerOpsClosed = false;

	const startLanes = () => {
		if (!active || lanes || !held() || !home.allowsLanes()) return;
		lanes = createSourceLanes({
			ambient,
			state: watcherState,
			watchers,
			enabled: (watcherId) => enabled.enabled(watcherId),
			sort: (watcherId, event) => decideEvent(rules.get(watcherId), specsOf(watcherId) ?? [], event.fields),
			wake: () => wake,
			to: ASSISTANT_TEAM,
			render,
		});
		lanes.start();
	};
	const stopLanes = async () => {
		const stopping = lanes;
		lanes = null;
		await stopping?.stop();
	};
	/** One live page in the watcher's lane; the query is built there, so it reads the lane's mark. */
	const livePage = async <T>(
		watcherId: string,
		query: () => ListQuery,
		deadlineMs: number,
		settle: (page: ListPage) => T,
	): Promise<T> => {
		if (!lanes) throw new Error(NOT_HERE);
		const answer = await lanes.read(
			watcherId,
			deadlineMs,
			async (watcher, signal): Promise<ListPage> =>
				watcher.list ? await watcher.list(query(), signal) : { events: [], here: "" },
			settle,
		);
		if (answer.kind === "ran") return answer.value;
		throw new Error(
			answer.end === "stopping" ? "the assistant is stopping" : `${watcherId} did not answer in time`,
		);
	};
	const inbox = createInboxListing({
		watchers,
		enabled: (watcherId) => enabled.enabled(watcherId),
		state: watcherState,
		rulesFor: (watcherId) => rules.get(watcherId),
		ambient,
		livePage,
	});
	/** Owner record keyed by call id. */
	const postRecord = (callId: string, record: ActionRecord): boolean => {
		try {
			const routes = deps.routes();
			const sessionId = routes.ownerSessionKey(ASSISTANT_TEAM);
			if (!sessionId) return false;
			const entry = { kind: "assistant_record" as const, session_id: sessionId, ...record };
			return (
				routes.deliverToOwner({ entry, dedupeKey: `assistant-action:${callId}`, label: "assistant" }) === true
			);
		} catch (error) {
			console.warn(`[assistant] record not posted: ${(error as Error).message}`);
			return false;
		}
	};
	const dispatch = createActionDispatch({
		actions,
		ambient,
		write: (watcherId, deadlineMs, work) =>
			lanes ? lanes.write(watcherId, deadlineMs, work) : Promise.reject(new Error(NOT_HERE)),
		record: postRecord,
	});
	/** Serializes owner operations. */
	const ownerOps = createFifo();
	const serial = <T>(work: () => T | Promise<T>): Promise<T> =>
		ownerOps.run(() => {
			if (ownerOpsClosed) throw new Error("the Gateway is shutting down");
			return work();
		});
	/** A write that did not land answers as a refusal, never as the state it meant. */
	const grantsLanded = (watcherId: string, entryIds: readonly string[]) => {
		const held = deps.vault.watcherGrants(watcherId);
		return held.length === entryIds.length && entryIds.every((entryId) => held.includes(entryId));
	};

	const watcherOf = (watcher: Watcher): AssistantWatcher => {
		const state = watcherState.get(watcher.id);
		const specs = watcher.fieldSpecs;
		const held = rules.get(watcher.id);
		return {
			id: watcher.id,
			label: watcher.label,
			grants: deps.vault.watcherGrants(watcher.id),
			unread: state.unread,
			capped: state.capped,
			evicted: 0,
			...(state.lastSuccessAt !== undefined ? { lastSuccessAt: state.lastSuccessAt } : {}),
			...(state.nextPollAt !== undefined ? { nextPollAt: state.nextPollAt } : {}),
			...(state.backoff ? { backoff: state.backoff } : {}),
			...(state.stopped !== undefined ? { stopped: state.stopped } : {}),
			fields: fieldsOf(specs),
			fieldSpecs: [...specs],
			rules: held,
			invalid: invalidRules(held.rules, specs),
			unexpected: unexpectedNow(state, specs),
			...(watcher.secret === undefined ? {} : { secret: watcher.secret }),
			actions: actionsOf(watcher.id),
			enabled: enabled.enabled(watcher.id),
		};
	};
	const watcherNamed = (watcherId: string) => {
		const found = watchers.find((watcher) => watcher.id === watcherId);
		if (!found) throw new Error(`no watcher "${watcherId}"`);
		return found;
	};
	const safety = openDurable(deps.dataDir, "assistant-safety", (store) => createSafetyStore(store));
	// Preboot rows cannot establish owner activity.
	const marker = createOriginMarker(deps.lastDeliverySeq() + 1, () => ambient.now());
	/** Owner-thread send card. */
	const card = (actionType: "send-request" | "send-retract", payload: Record<string, unknown>) => {
		const routes = deps.routes();
		const sessionId = routes.ownerSessionKey(ASSISTANT_TEAM);
		if (!sessionId) return null;
		return {
			routes,
			entry: {
				kind: "plugin_action" as const,
				session_id: sessionId,
				pluginId: "assistant",
				actionType,
				payload,
			},
		};
	};
	const guard = openDurable(deps.dataDir, "assistant-open-sends", (ledger) =>
		createSendGuard({
			ambient,
			approveEverySend: () => safety.approveEverySend(),
			readsOwner: () => marker.readsOwner(),
			routes: () => deps.routes(),
			blobSize: deps.blobSize,
			ledger,
			// Answers are process-local.
			deliverCard: (request: AssistantSendRequest) => {
				try {
					const built = card("send-request", request);
					if (!built) return false;
					return built.routes.deliverToOwner({
						entry: built.entry,
						dedupeKey: `assistant-send:${request.requestId}`,
						label: "assistant",
						volatile: true,
					});
				} catch {
					return false;
				}
			},
			retractCard: (stub) => {
				try {
					const built = card("send-retract", { requestId: stub.requestId });
					if (!built) return false;
					const dedupeKey = `assistant-send-retract:${stub.requestId}`;
					return built.routes.deliverToOwner({ entry: built.entry, dedupeKey, label: "assistant" }) === true;
				} catch {
					return false;
				}
			},
		}),
	);

	const routes = createAssistantRoutes({
		caller: (req) => {
			const record = sessions.sessionAuthority.resolveConfirmedManagedSession(req);
			if (!record) return "unauthenticated";
			return acting(record) ? "assistant" : "not_assistant";
		},
		sender: (req, conversationId) => {
			const auth = sessions.sessionAuthority;
			if (!acting(auth.resolveConfirmedManagedSession(req) ?? undefined)) return null;
			// Replies require caller ownership.
			const holder = sessions.conversationRegistry.get(conversationId);
			if (!auth.satisfies(auth.toAnswerFor(holder), presentedByRequest(req))) return null;
			return { team: ASSISTANT_TEAM, conversationId };
		},
		list: (scope, page) => inbox.list(scope, page),
		dispatch,
		guard,
		writes: () => marker.writes(),
	});
	const state = (): ConsoleAssistantStateResult => {
		const record = held();
		return {
			workdir: record?.workdirPath ?? null,
			team: record ? ASSISTANT_TEAM : null,
			watchers: watchers.map(watcherOf),
			approveEverySend: safety.approveEverySend(),
			checkIns: true,
		};
	};

	/** Refused mid-apply. */
	const settled = <T>(work: () => T | Promise<T>): Promise<T> =>
		serial(() => {
			if (home.applying()) throw new Error(MOVING_HERE);
			return work();
		});
	let homePort: AssistantHomePort | null = null;

	/** With lanes stopped, the carried settings land; lanes start only once all of it is saved. */
	const apply = async (record: AssistantHomeRecord): Promise<string | null> => {
		await stopLanes();
		const opened = homePort?.open(record) ?? { kind: "refused" as const, reason: "federation is not active" };
		if (opened.kind === "refused") return opened.reason;
		const { workdirPath, carried } = opened.sealed;
		const refused = placeRefusal(workdirPath, sessions);
		if (refused) return refused;
		marker.ended();
		for (const watcher of watchers) deps.vault.setWatcherGrants(watcher.id, []);
		if (!watchers.every((watcher) => grantsLanded(watcher.id, [])))
			return "a grant left from an earlier placement could not be dropped";
		// First poll primes again.
		if (!watchers.every((watcher) => watcherState.put(watcher.id, FRESH_STATE)))
			return "a watcher's earlier state could not be reset";
		const undo = place(workdirPath, sessions);
		try {
			deps.saveSessions();
		} catch (error) {
			undo();
			throw error;
		}
		const byId = new Map((carried?.watchers ?? []).map((watcher) => [watcher.id, watcher]));
		const ids = watchers.map((watcher) => watcher.id);
		if (!rules.replaceAll(ids, (watcherId) => byId.get(watcherId)?.rules ?? null))
			return "the rules could not be saved";
		if (!safety.set(carried?.approveEverySend ?? true)) return "the Safety setting could not be saved";
		// Fresh is off; unflagged carried is on.
		const off = watchers.filter((watcher) => {
			const moved = byId.get(watcher.id);
			return moved === undefined || moved.enabled === false;
		});
		if (!enabled.replaceOff(off.map((watcher) => watcher.id))) return "the watchers' Enabled could not be saved";
		// Unusable grants drop.
		for (const watcher of watchers) {
			const grant = byId.get(watcher.id)?.grant;
			if (grant && (await deps.vault.usableHere(grant))) deps.vault.setWatcherGrants(watcher.id, [grant]);
		}
		return null;
	};

	/** Waiting sends end and lanes stop before anything awaits; the rest runs again until the forget lands. */
	const letGo = async (): Promise<boolean> => {
		guard.sessionEnded(ASSISTANT_TEAM);
		await stopLanes();
		if (held()) {
			try {
				await homePort?.endSession();
			} catch (error) {
				console.warn(`[assistant] let-go waits: ${(error as Error).message}`);
			}
			if (held()) return false;
		}
		marker.ended();
		for (const watcher of watchers) {
			if (deps.vault.watcherGrants(watcher.id).length > 0) deps.vault.setWatcherGrants(watcher.id, []);
		}
		if (!watchers.every((watcher) => grantsLanded(watcher.id, []))) return false;
		const ids = watchers.map((watcher) => watcher.id);
		const residue = ids.some((watcherId) => {
			const held = rules.get(watcherId);
			return held.rules.length > 0 || held.revision > 0;
		});
		if (residue && !rules.replaceAll(ids, () => null)) return false;
		if (!safety.approveEverySend() && !safety.set(true)) return false;
		if (ids.some((watcherId) => !enabled.enabled(watcherId)) && !enabled.replaceOff([])) return false;
		return true;
	};

	const homeFollow = createHomeFollow({
		mark: home,
		localGatewayId: deps.localGatewayId,
		serial,
		ambient,
		effects: {
			stopLanes,
			startLanes,
			apply,
			letGo,
			// Resent at the next registration.
			report: (mark) => homePort?.report(mark) ?? Promise.resolve("dropped" as const),
		},
	});

	return {
		reserves: isAssistant,
		placed: () => held() !== undefined && home.allowsLanes(),
		follow: homeFollow.follow,
		bindHome: (port) => {
			homePort = port;
		},
		forgetRefusal: (team) => (isAssistant(team) ? "the assistant's session ends only when its home changes" : null),
		routes,
		baselineFor: (team) => {
			if (!isAssistant(team)) return undefined;
			return {
				watchers: watchers
					.filter((watcher) => enabled.enabled(watcher.id))
					.map((watcher) => {
						const health = watcherState.get(watcher.id);
						return {
							label: watcher.label,
							unread: health.unread,
							capped: health.capped,
							checked: health.lastSuccessAt !== undefined,
							evicted: 0,
							...(health.stopped !== undefined ? { stopped: health.stopped } : {}),
							...(health.backoff ? { waiting: health.backoff.reason } : {}),
						};
					}),
			};
		},
		bindWake: (bound) => {
			wake = bound;
		},
		bindNudge: (bound) => {
			nudge = bound;
		},
		console: {
			state,
			/** Also the retry: the same set polls a stopped watcher again. */
			setWatcherGrants: (watcherId, entryIds) =>
				settled(() => {
					if (!watchers.some((watcher) => watcher.id === watcherId))
						throw new Error(`no watcher "${watcherId}"`);
					if (entryIds.length > 1) throw new Error("a watcher takes one secret");
					if (!held()) throw new Error(NOT_HERE);
					deps.vault.setWatcherGrants(watcherId, entryIds);
					if (!grantsLanded(watcherId, entryIds)) throw new Error("the grant could not be saved");
					if (lanes) lanes.poke(watcherId);
					else startLanes();
					return state();
				}),
			// Only owner ops reach these, so no event text can rewrite what sorts later events.
			putRule: (watcherId, rule) => settled(() => rules.putRule(watcherId, rule)),
			deleteRule: (watcherId, ruleId, base) => settled(() => rules.deleteRule(watcherId, ruleId, base)),
			moveRule: (watcherId, ruleId, beforeId, base) =>
				settled(() => rules.moveRule(watcherId, ruleId, beforeId, base)),
			putOtherwise: (watcherId, otherwise) => settled(() => rules.putOtherwise(watcherId, otherwise)),
			// A move carries it; a let-go resets it.
			setSafety: (approveEverySend) =>
				settled(() => {
					if (!safety.set(approveEverySend)) throw new Error("the setting could not be saved");
					return state();
				}),
			// No await: `switched` voids a poll in flight before it can commit.
			setWatcherEnabled: (watcherId, on) =>
				settled(() => {
					watcherNamed(watcherId);
					if (!held()) throw new Error(NOT_HERE);
					if (enabled.enabled(watcherId) === on) return state();
					// Backlog wakes nothing.
					const unprimed = { ...watcherState.get(watcherId), primed: false };
					if (on && !watcherState.put(watcherId, unprimed)) throw new Error("the watcher could not be reset");
					if (!enabled.set(watcherId, on)) throw new Error("the setting could not be saved");
					if (lanes) lanes.switched(watcherId);
					else startLanes();
					return state();
				}),
			checkWatcher: async (watcherId, from, opId) => {
				const watcher = await settled(() => {
					const found = watcherNamed(watcherId);
					if (!held() || !home.allowsLanes()) throw new Error(NOT_HERE);
					if (!enabled.enabled(watcherId)) throw new Error(`${found.label} is disabled`);
					return found;
				});
				if (!nudge) throw new Error("federation is not active");
				// Outside the queue; wakes are slow.
				const sent = nudge({
					from,
					body: checkNudge(watcher.label),
					deliveryId: `assistant-check:${opId}`,
				}).catch((error: Error) => error.message);
				const answered = await withinMs(
					ambient,
					sent.then((refused) => ({ refused })),
					SEND_BOUND_MS,
				);
				if (answered?.refused) throw new Error(answered.refused);
				if (!answered) {
					void sent.then((refused) => {
						if (refused) console.warn(`[assistant] check of ${watcherId} not delivered: ${refused}`);
					});
				}
				return state();
			},
			answerSend: (requestId, decision, note) => guard.answer(requestId, decision, note),
			/** Over the live first page, from the rule's place. */
			previewRule: async (watcherId, rule) => {
				const refusal = rules.refusalOf(watcherId, rule);
				if (refusal) throw new Error(refusal);
				// Read as a save would store it.
				const asStored = canonicalRule(rule);
				const held = rules.get(watcherId).rules;
				const placed = held.some((existing) => existing.id === asStored.id)
					? held.map((existing) => (existing.id === asStored.id ? asStored : existing))
					: [...held, asStored];
				const recent = (
					await livePage(
						watcherId,
						() => ({ scope: "all" }),
						ASSISTANT_WAITS.preview,
						(page) => page.events,
					)
				)
					.sort((a, b) => b.at - a.at)
					.slice(0, PREVIEW_EVENTS);
				const specs = specsOf(watcherId) ?? [];
				const matched = recent.filter((event) => ruleMatches(asStored, specs, event.fields));
				const decided = matched.filter((event) => firstMatch(placed, specs, event.fields)?.id === asStored.id);
				return {
					decided: decided.length,
					shadowed: matched.length - decided.length,
					of: recent.length,
					titles: decided.slice(0, 3).map((event) => event.title),
				};
			},
		},
		start: () => {
			active = true;
			startLanes();
			homeFollow.start();
			guard.retractStale();
		},
		stop: async () => {
			ownerOpsClosed = true;
			// Late applies start nothing.
			active = false;
			homeFollow.stop();
			// Drain before flush.
			await withinMs(ambient, Promise.all([ownerOps.drain(), stopLanes()]), STOP_WAIT_MS);
		},
		delivered: (row) => marker.delivered(row),
		offered: (row) => marker.offered(row),
		replyPushed: (team) => {
			if (team === ASSISTANT_TEAM) marker.replyPushed(deps.lastDeliverySeq());
		},
		namesBlob: (blobId) => guard.namesBlob(blobId),
		sessionEnded: (team) => {
			guard.sessionEnded(team);
			if (team === ASSISTANT_TEAM) marker.ended();
		},
	};
}

/** `place`'s refusal, checked first. */
function placeRefusal(workdir: string, sessions: AssistantStageDeps["sessions"]): string | null {
	if (!isSpawnWorkdirPath(ASSISTANT_SPAWN, workdir)) return "the folder must be an absolute or ~-rooted path";
	const held = sessions.sessionStore.getByTeam(ASSISTANT_TEAM);
	if (held && !isAssistantRecord(held)) return `${ASSISTANT_TEAM} is held by a session the assistant did not make`;
	return null;
}

/**
 * Mints the record, or moves a held one to this folder, and answers how to take that back. The first
 * wake launches it, and a moved session takes the folder at its next launch.
 */
function place(workdir: string, sessions: AssistantStageDeps["sessions"]): () => void {
	const refusal = placeRefusal(workdir, sessions);
	if (refusal) throw new Error(refusal);
	const held = sessions.sessionStore.getByTeam(ASSISTANT_TEAM);
	if (held) {
		const previous = held.workdirPath;
		held.workdirPath = workdir;
		return () => {
			held.workdirPath = previous;
		};
	}
	const minted = sessions.presence.adoptById(ASSISTANT_SESSION_NAME, {
		spawn: ASSISTANT_SPAWN,
		sessionLabel: "Assistant",
		workdirHint: "Assistant",
		workdirPath: workdir,
		mintedFrom: ASSISTANT_RESERVE_KEY,
	});
	if (!minted) throw new Error(`cannot claim ${ASSISTANT_TEAM}: the name is reserved or a project`);
	return () => void sessions.presence.forget(ASSISTANT_TEAM);
}
