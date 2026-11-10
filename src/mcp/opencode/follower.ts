// Follows one OpenCode session's state.

import {
	applyOpencodeEvent,
	compactionsOf,
	derivedFromView,
	EMPTY_VIEW,
	newestCompactionRow,
	type OpencodeEvent,
	type OpencodePermission,
	type OpencodeView,
	viewFromSnapshot,
} from "../../shared/opencode.js";
import { type DerivedPresence, sameDerived } from "../../shared/schemasPresence.js";
import type { OpencodeClient } from "./client.js";

////////////////////////////////
//  Interfaces & Types

export interface FollowerDeps {
	client: Pick<OpencodeClient, "sessionId" | "snapshot" | "events">;
	/** Undefined clears what was reported. */
	report(derived: DerivedPresence | undefined): void;
	/** A finished compaction's message id; told more than once. */
	compacted(id: string): void;
	sleep(ms: number): Promise<void>;
	log(line: string): void;
}

export interface OpencodeFollower {
	start(): void;
	stop(): void;
	/** What was last reported, for a reconnected socket. */
	current(): DerivedPresence | undefined;
	/** A pending permission by its prompt id. */
	permission(promptId: string): OpencodePermission | undefined;
}

////////////////////////////////
//  Constants

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15_000;

////////////////////////////////
//  Functions & Helpers

export function createOpencodeFollower(deps: FollowerDeps): OpencodeFollower {
	let view: OpencodeView = EMPTY_VIEW;
	let reported: DerivedPresence | undefined;
	let connection: AbortController | undefined;
	let stopped = true;

	const publish = (): void => {
		const derived = derivedFromView(view);
		if (reported && sameDerived(reported, derived)) return;
		reported = derived;
		deps.report(derived);
	};

	/** Names a finished compaction from a fresh read: the one given, if it did not fail, or the newest. */
	async function confirmFinished(id: string | undefined, signal: AbortSignal): Promise<void> {
		try {
			const { rows } = await deps.client.snapshot(signal);
			if (signal.aborted) return;
			const found = id
				? rows.find((row) => row.id === id && row.type === "compaction" && !row.error)?.id
				: newestCompactionRow(rows);
			if (found) deps.compacted(found);
		} catch {
			// The next read names it.
		}
	}

	function apply(event: OpencodeEvent, signal: AbortSignal): void {
		const own = event.data.sessionID === deps.client.sessionId;
		const was = view;
		view = applyOpencodeEvent(view, event, deps.client.sessionId);
		if (view !== was) publish();
		if (own && event.type === "session.compaction.ended") {
			if (was.compactionId) deps.compacted(was.compactionId);
			else void confirmFinished(undefined, signal);
			return;
		}
		// An execution ended one whose own end fell in a gap; the read tells a failed one apart.
		if (was.compacting && !view.compacting && event.type !== "session.compaction.failed") {
			void confirmFinished(was.compactionId, signal);
		}
	}

	async function resync(buffered: OpencodeEvent[], live: { on: boolean }, signal: AbortSignal): Promise<void> {
		const snapshot = await deps.client.snapshot(signal);
		// A newer connection owns the view.
		if (signal.aborted) return;
		view = viewFromSnapshot(snapshot);
		publish();
		const { newestDone } = compactionsOf(snapshot);
		if (newestDone) deps.compacted(newestDone);
		live.on = true;
		for (const event of buffered.splice(0)) apply(event, signal);
	}

	async function followOnce(controller: AbortController): Promise<void> {
		const buffered: OpencodeEvent[] = [];
		const live = { on: false };
		let syncing: Promise<void> | undefined;
		await deps.client.events((event) => {
			// Subscribed before the read, so nothing between is lost.
			if (event.type === "server.connected") {
				live.on = false;
				syncing = resync(buffered, live, controller.signal).catch((error) => {
					if (controller.signal.aborted) return;
					deps.log(`state read failed: ${error instanceof Error ? error.message : String(error)}`);
					controller.abort();
				});
				return;
			}
			if (!live.on) {
				buffered.push(event);
				return;
			}
			apply(event, controller.signal);
		}, controller.signal);
		await syncing;
	}

	async function run(): Promise<void> {
		let wait = RETRY_MIN_MS;
		while (!stopped) {
			const controller = new AbortController();
			connection = controller;
			try {
				await followOnce(controller);
				wait = RETRY_MIN_MS;
			} catch (error) {
				if (stopped) return;
				deps.log(`event stream dropped: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				// Fences its read.
				controller.abort();
			}
			if (stopped) return;
			await deps.sleep(wait);
			wait = Math.min(wait * 2, RETRY_MAX_MS);
		}
	}

	return {
		start: () => {
			if (!stopped) return;
			stopped = false;
			void run();
		},
		stop: () => {
			stopped = true;
			connection?.abort();
			if (reported) deps.report(undefined);
			reported = undefined;
		},
		current: () => reported,
		permission: (promptId) => view.permissions.find((held) => held.id.slice(0, 64) === promptId),
	};
}
