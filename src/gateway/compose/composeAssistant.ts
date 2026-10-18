// The assistant's one session and its watchers' inbox. Where it lives is its reserved session
// record: placed by an owner op, kept from both sweeps, released only by an owner op.

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
import type { AssistantWatcher, ConsoleAssistantStateResult } from "../../shared/schemasAssistant.js";
import { canonicalRule, decideEvent, firstMatch, ruleMatches } from "../../shared/schemasAssistantRules.js";
import {
	createGithubWatcher,
	GITHUB_WATCHER_ID,
	type GithubWatcherDeps,
	type TokenRead,
} from "../assistant/githubWatcher.js";
import { createInboxStore, type InboxStore, type Sorter } from "../assistant/inboxStore.js";
import { createRulesStore } from "../assistant/rulesStore.js";
import type { Watcher } from "../assistant/watcher.js";
import { createWatcherRunner, type WatcherRunner } from "../assistant/watcherRunner.js";
import type { AssistantConsoleHandlers } from "../console/consoleTypes.js";
import type { VaultRelease } from "../vault/vaultUse.js";
import type { SessionsStage } from "./composeSessions.js";

const NEEDS_SECRET = "needs a secret";
/** Shutdown waits this long for an owner op already running. */
const STOP_WAIT_MS = 5_000;
/** Events a preview reads. */
const PREVIEW_EVENTS = 50;

const LABELS: Record<string, string> = { [GITHUB_WATCHER_ID]: "GitHub notifications" };

/** What the assistant reaches in the vault, read late. */
export interface AssistantVault {
	watcherGrants: (watcherId: string) => string[];
	setWatcherGrants: (watcherId: string, entryIds: string[]) => void;
	readForWatcher: (watcherId: string, entryId: string) => Promise<VaultRelease>;
}

export interface AssistantStageDeps {
	dataDir: string;
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	sessions: Pick<SessionsStage, "sessionStore" | "presence">;
	/** A checked save of the session records, which hold where it lives; throws when it did not land. */
	saveSessions: () => void;
	vault: AssistantVault;
	fetch: GithubWatcherDeps["fetch"];
	/** Replaces the built-in watchers. */
	watchers?: readonly Watcher[];
}

export interface AssistantStage {
	/** Whether that session is the assistant's, which no sweep takes. */
	reserves: (team: string) => boolean;
	/** The refusal reason, or null. */
	forgetRefusal: (team: string) => string | null;
	inbox: Pick<InboxStore, "stateOf" | "events" | "unread">;
	console: AssistantConsoleHandlers;
	/** Arms the watchers, once federation is active. */
	start: () => void;
	/** Final, and before the shutdown flush, so it sees no poll halfway through its write. */
	stop: () => Promise<void>;
}

/** The vault's answer, as a watcher reads it: a missing grant stops it, a transient wait backs off. */
function tokenOf(read: VaultRelease): TokenRead {
	if (read.kind === "released") return { kind: "token", value: read.value };
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
		return tokenOf(await deps.vault.readForWatcher(watcherId, entryId));
	};
	const watchers = deps.watchers ?? [
		createGithubWatcher({ fetch: deps.fetch, token: tokenFor(GITHUB_WATCHER_ID), now: () => ambient.now() }),
	];

	const inbox = openDurable(deps.dataDir, "assistant-inbox", (store) => createInboxStore(store));
	const watcherOfId = (watcherId: string) => watchers.find((watcher) => watcher.id === watcherId);
	const sorterFor = (watcherId: string): Sorter => {
		const current = rules.get(watcherId);
		const pingDefault = watcherOfId(watcherId)?.pingDefault ?? false;
		return { sort: (event) => decideEvent(current, event.fields, pingDefault), revision: current.revision };
	};
	/**
	 * An inbox sorted under any other revision sorts its kept drops again, so a crash between the two
	 * files catches up, and so does a rules file that started fresh.
	 */
	const catchUp = (watcherId: string) => {
		const sorter = sorterFor(watcherId);
		if ((inbox.stateOf(watcherId, ambient.now())?.rulesRevision ?? 0) === sorter.revision) return;
		if (!inbox.resort(watcherId, sorter, ambient.now())) {
			console.warn(`[assistant] ${watcherId} drops not sorted again; the next poll or start retries`);
		}
	};
	const rules = openDurable(deps.dataDir, "assistant-rules", (store) =>
		createRulesStore({ store, fieldsOf: (watcherId) => watcherOfId(watcherId)?.fields, onChanged: catchUp }),
	);
	for (const watcher of watchers) catchUp(watcher.id);

	let runner: WatcherRunner | null = null;
	let active = false;
	let closed = false;
	const startRunner = () => {
		if (!active || closed || runner || !held()) return;
		runner = createWatcherRunner({
			ambient,
			inbox,
			watchers,
			rules: sorterFor,
		});
		runner.start();
	};
	const stopRunner = async () => {
		const stopping = runner;
		runner = null;
		await stopping?.stop();
	};
	/** Owner ops one at a time, so a place never lands inside a release; none starts after shutdown. */
	let tail: Promise<unknown> = Promise.resolve();
	const serial = <T>(work: () => T | Promise<T>): Promise<T> => {
		const next = tail.then(() => {
			if (closed) throw new Error("the Gateway is shutting down");
			return work();
		});
		tail = next.catch(() => undefined);
		return next;
	};
	/** A write that did not land answers as a refusal, never as the state it meant. */
	const grantsLanded = (watcherId: string, entryIds: readonly string[]) => {
		const held = deps.vault.watcherGrants(watcherId);
		return held.length === entryIds.length && entryIds.every((entryId) => held.includes(entryId));
	};

	const watcherOf = (watcher: Watcher): AssistantWatcher => {
		const now = ambient.now();
		const state = inbox.stateOf(watcher.id, now);
		return {
			id: watcher.id,
			label: LABELS[watcher.id] ?? watcher.id,
			grants: deps.vault.watcherGrants(watcher.id),
			unread: inbox.unread(watcher.id, now),
			evicted: state?.evicted ?? 0,
			...(state?.lastSuccessAt !== undefined ? { lastSuccessAt: state.lastSuccessAt } : {}),
			...(state?.nextPollAt !== undefined ? { nextPollAt: state.nextPollAt } : {}),
			...(state?.backoff ? { backoff: state.backoff } : {}),
			...(state?.stopped !== undefined ? { stopped: state.stopped } : {}),
			fields: [...(watcher.fields ?? [])],
			pingDefault: watcher.pingDefault ?? false,
			rules: rules.get(watcher.id),
			dropped: inbox.events(watcher.id, now).filter((event) => event.disposition === "ruleDropped").length,
		};
	};
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
		inbox,
		console: {
			state,
			// The record is where it lives, so it is durable before the phone releases the old home.
			place: (workdir) =>
				serial(() => {
					// A new placement is granted afresh, whatever an interrupted release left.
					if (!held()) {
						for (const watcher of watchers) deps.vault.setWatcherGrants(watcher.id, []);
						if (!watchers.every((watcher) => grantsLanded(watcher.id, []))) {
							throw new Error("a grant left from an earlier placement could not be dropped");
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
					startRunner();
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
					await stopRunner();
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
					if (!held()) throw new Error("the assistant does not live on this Gateway");
					deps.vault.setWatcherGrants(watcherId, entryIds);
					if (!grantsLanded(watcherId, entryIds)) throw new Error("the grant could not be saved");
					if (runner) runner.poke(watcherId);
					else startRunner();
					return state();
				}),
			// Only owner ops reach these, so no event text can rewrite what sorts later events.
			putRule: (watcherId, rule) => serial(() => rules.putRule(watcherId, rule)),
			deleteRule: (watcherId, ruleId, base) => serial(() => rules.deleteRule(watcherId, ruleId, base)),
			moveRule: (watcherId, ruleId, beforeId, base) =>
				serial(() => rules.moveRule(watcherId, ruleId, beforeId, base)),
			putOtherwise: (watcherId, otherwise) => serial(() => rules.putOtherwise(watcherId, otherwise)),
			/** Refuses what a put refuses; counts what the rule decides from its place by id, else last. */
			previewRule: (watcherId, rule) => {
				const refusal = rules.refusalOf(watcherId, rule);
				if (refusal) throw new Error(refusal);
				// Read as a save would store it.
				const asStored = canonicalRule(rule);
				const held = rules.get(watcherId).rules;
				const placed = held.some((existing) => existing.id === asStored.id)
					? held.map((existing) => (existing.id === asStored.id ? asStored : existing))
					: [...held, asStored];
				const recent = inbox
					.events(watcherId, ambient.now())
					.sort((a, b) => b.receivedAt - a.receivedAt || b.seq - a.seq)
					.slice(0, PREVIEW_EVENTS);
				const matched = recent.filter((event) => ruleMatches(asStored, event.fields));
				const decided = matched.filter((event) => firstMatch(placed, event.fields)?.id === asStored.id);
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
			startRunner();
		},
		stop: async () => {
			closed = true;
			await stopRunner();
			// An op already running finishes before the flush, bounded as a poll's stop is.
			await withinMs(ambient, tail, STOP_WAIT_MS);
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
