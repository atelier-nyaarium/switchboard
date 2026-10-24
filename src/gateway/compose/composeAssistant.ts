// The assistant's one session and its watchers. Where it lives is its reserved session record:
// placed by an owner op, kept from both sweeps, released only by an owner op.

import { type Ambient, withinMs } from "../../shared/ambient.js";
import {
	ASSISTANT_RESERVE_KEY,
	ASSISTANT_SESSION_NAME,
	ASSISTANT_SPAWN,
	ASSISTANT_TEAM,
	isAssistantRecord,
} from "../../shared/assistant-session.js";
import { openDurable } from "../../shared/durable-store.js";
import { isSpawnWorkdirPath } from "../../shared/host-op.js";
import { createFifo } from "../../shared/keyed-fifo.js";
import type { AssistantWatcher, ConsoleAssistantStateResult } from "../../shared/schemasAssistant.js";
import { actionsOf, GITHUB_WATCHER_ID } from "../../shared/schemasAssistantActions.js";
import { eventLines } from "../../shared/schemasAssistantInbox.js";
import {
	canonicalRule,
	decideEvent,
	fieldsOf,
	firstMatch,
	invalidRules,
	ruleMatches,
} from "../../shared/schemasAssistantRules.js";
import type { SessionBaseline } from "../../shared/session-baseline.js";
import { type ActionRecord, createActionDispatch } from "../assistant/actionDispatch.js";
import { createAssistantRoutes, type Handler } from "../assistant/assistantRoutes.js";
import { createGithubClient, type GithubClientDeps, type TokenRead } from "../assistant/githubClient.js";
import { GithubDone } from "../assistant/githubDone.js";
import { createGithubWatcher } from "../assistant/githubWatcher.js";
import { createInboxListing } from "../assistant/inboxListing.js";
import { createRulesStore } from "../assistant/rulesStore.js";
import { type AssistantWake, createSourceLanes, type SourceLanes } from "../assistant/sourceLane.js";
import { ASSISTANT_WAITS } from "../assistant/waits.js";
import type { ListPage, ListQuery, Watcher, WatcherEvent } from "../assistant/watcher.js";
import type { WatcherActions } from "../assistant/watcherAction.js";
import { createWatcherStateStore, FRESH_STATE, unexpectedNow } from "../assistant/watcherState.js";
import type { AssistantConsoleHandlers } from "../console/consoleTypes.js";
import type { VaultRelease } from "../vault/vaultUse.js";
import type { GatewayRoutes } from "./composeRoutes.js";
import type { SessionsStage } from "./composeSessions.js";

const NEEDS_SECRET = "needs a secret";
const NOT_HERE = "the assistant does not live on this Gateway";
/** Shutdown waits this long for an owner op already running. */
const STOP_WAIT_MS = 5_000;
/** Events a preview reads. */
const PREVIEW_EVENTS = 50;

/** What the assistant reaches in the vault, read late. */
export interface AssistantVault {
	watcherGrants: (watcherId: string) => string[];
	setWatcherGrants: (watcherId: string, entryIds: string[]) => void;
	readForWatcher: (watcherId: string, entryId: string) => Promise<VaultRelease>;
}

export interface AssistantStageDeps {
	dataDir: string;
	ambient: Pick<Ambient, "now" | "randomBytes" | "setTimer" | "clearTimer">;
	sessions: Pick<SessionsStage, "sessionStore" | "presence" | "sessionAuthority">;
	/** A checked save of the session records, which hold where it lives; throws when it did not land. */
	saveSessions: () => void;
	vault: AssistantVault;
	/** Resolve after Domain activation. */
	routes: () => Pick<GatewayRoutes, "deliverToOwner" | "ownerSessionKey">;
	fetch: GithubClientDeps["fetch"];
	/** Replaces the built-in watchers. */
	watchers?: readonly Watcher[];
}

export interface AssistantStage {
	/** Whether that session is the assistant's, which no sweep takes. */
	reserves: (team: string) => boolean;
	/** The refusal reason, or null. */
	forgetRefusal: (team: string) => string | null;
	console: AssistantConsoleHandlers;
	/** Assistant-only loopback routes. */
	routes: Map<string, Handler>;
	/** Its watchers' lines after a compaction; undefined for any other session. */
	baselineFor: (team: string) => SessionBaseline["assistant"];
	/** The send path's event road, bound on each federation activation. */
	bindWake: (wake: AssistantWake) => void;
	/** Arms the watchers, once federation is active. */
	start: () => void;
	/** Final, and before the shutdown flush, so it sees no poll halfway through its write. */
	stop: () => Promise<void>;
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
	// Unknown watcher returns undefined.
	const specsOf = (watcherId: string) => {
		const watcher = watchers.find((candidate) => candidate.id === watcherId);
		return watcher ? (watcher.fieldSpecs ?? []) : undefined;
	};
	const rules = openDurable(deps.dataDir, "assistant-rules", (store) => createRulesStore({ store, specsOf }));
	const render = (watcher: Watcher, event: WatcherEvent) => eventLines({ label: watcher.label, ...event }).join("\n");

	let lanes: SourceLanes | null = null;
	let wake: AssistantWake | null = null;
	let active = false;
	let ownerOpsClosed = false;

	const startLanes = () => {
		if (!active || lanes || !held()) return;
		lanes = createSourceLanes({
			ambient,
			state: watcherState,
			watchers,
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
		const specs = watcher.fieldSpecs ?? [];
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
		};
	};

	const routes = createAssistantRoutes({
		caller: (req) => {
			const record = sessions.sessionAuthority.resolveConfirmedManagedSession(req);
			if (!record) return "unauthenticated";
			return isAssistantRecord(record) ? "assistant" : "not_assistant";
		},
		list: (scope, page) => inbox.list(scope, page),
		dispatch,
	});
	const state = (): ConsoleAssistantStateResult => {
		const record = held();
		return {
			workdir: record?.workdirPath ?? null,
			team: record ? ASSISTANT_TEAM : null,
			watchers: watchers.map(watcherOf),
		};
	};

	return {
		reserves: isAssistant,
		forgetRefusal: (team) => (isAssistant(team) ? "the assistant's session leaves only by a release" : null),
		routes,
		baselineFor: (team) => {
			if (!isAssistant(team)) return undefined;
			return {
				watchers: watchers.map((watcher) => {
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
		console: {
			state,
			// The record is where it lives, so it is durable before the phone releases the old home.
			place: (workdir) =>
				serial(() => {
					// A new placement starts afresh, whatever an interrupted release left.
					if (!held()) {
						for (const watcher of watchers) deps.vault.setWatcherGrants(watcher.id, []);
						if (!watchers.every((watcher) => grantsLanded(watcher.id, []))) {
							throw new Error("a grant left from an earlier placement could not be dropped");
						}
						// First poll primes again.
						if (!watchers.every((watcher) => watcherState.put(watcher.id, FRESH_STATE))) {
							throw new Error("a watcher's earlier state could not be reset");
						}
					}
					const undo = place(workdir, sessions);
					try {
						deps.saveSessions();
					} catch (error) {
						// Refused, so the next persist tick must not save it either.
						undo();
						throw error;
					}
					startLanes();
					return state();
				}),
			// The record is the commit: a refused forget changes nothing. Past it the pane is gone, so
			// the rest runs whatever the save says, and a retry saves again.
			release: (forget) =>
				serial(async () => {
					if (held()) await forget(ASSISTANT_TEAM);
					let unsaved: Error | null = null;
					try {
						deps.saveSessions();
					} catch (error) {
						unsaved = error as Error;
					}
					await stopLanes();
					// Grants are this Gateway's; a leftover is inert unplaced, and a new placement drops it.
					for (const watcher of watchers) deps.vault.setWatcherGrants(watcher.id, []);
					const kept = watchers.filter((watcher) => !grantsLanded(watcher.id, []));
					if (unsaved) throw new Error(`released, but not yet saved; release again: ${unsaved.message}`);
					if (kept.length > 0) {
						const ids = kept.map((watcher) => watcher.id).join(", ");
						throw new Error(`released, but ${ids} kept a grant; release again to drop it`);
					}
					return state();
				}),
			/** Also the retry: the same set polls a stopped watcher again. */
			setWatcherGrants: (watcherId, entryIds) =>
				serial(() => {
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
			putRule: (watcherId, rule) => serial(() => rules.putRule(watcherId, rule)),
			deleteRule: (watcherId, ruleId, base) => serial(() => rules.deleteRule(watcherId, ruleId, base)),
			moveRule: (watcherId, ruleId, beforeId, base) =>
				serial(() => rules.moveRule(watcherId, ruleId, beforeId, base)),
			putOtherwise: (watcherId, otherwise) => serial(() => rules.putOtherwise(watcherId, otherwise)),
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
		},
		stop: async () => {
			ownerOpsClosed = true;
			// Drain before flush.
			await withinMs(ambient, Promise.all([ownerOps.drain(), stopLanes()]), STOP_WAIT_MS);
		},
	};
}

/**
 * Mints the record, or moves a held one to this folder, and answers how to take that back. The first
 * wake launches it, and a moved session takes the folder at its next launch.
 */
function place(workdir: string, sessions: AssistantStageDeps["sessions"]): () => void {
	if (!isSpawnWorkdirPath(ASSISTANT_SPAWN, workdir))
		throw new Error("the folder must be an absolute or ~-rooted path");
	const held = sessions.sessionStore.getByTeam(ASSISTANT_TEAM);
	if (held && !isAssistantRecord(held))
		throw new Error(`${ASSISTANT_TEAM} is held by a session the assistant did not make`);
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
