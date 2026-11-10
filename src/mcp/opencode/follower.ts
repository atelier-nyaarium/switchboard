// Follows one OpenCode session's state.

import {
	applyOpencodeEvent,
	compactionsOf,
	derivedFromView,
	EMPTY_VIEW,
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
/** Compactions already given their baseline edge. */
const ACCOUNTED_MAX = 32;

////////////////////////////////
//  Functions & Helpers

export function createOpencodeFollower(deps: FollowerDeps): OpencodeFollower {
	let view: OpencodeView = EMPTY_VIEW;
	let reported: DerivedPresence | undefined;
	let connection: AbortController | undefined;
	let stopped = true;
	// Every compaction's edge is owed once, whichever road saw it end.
	const accounted: string[] = [];
	let primed = false;
	/** One ended live under an unknown id: the next read accounts its newest. */
	let unnamedEnd = false;

	const account = (id: string | undefined): void => {
		if (id === undefined || accounted.includes(id)) return;
		accounted.push(id);
		if (accounted.length > ACCOUNTED_MAX) accounted.shift();
	};

	const publish = (): void => {
		const derived = derivedFromView(view);
		if (reported && sameDerived(reported, derived)) return;
		reported = derived;
		deps.report(derived);
	};

	/** Owes a compaction's edge whose start was never reported. */
	const pulseCompaction = (): void => {
		const settled = derivedFromView({ ...view, compacting: false });
		deps.report({ ...settled, compacting: true });
		deps.report(settled);
		reported = settled;
	};

	/** `replay` is an event buffered during a read, which the read may already hold. */
	function apply(event: OpencodeEvent, replay: boolean): void {
		const own = event.data.sessionID === deps.client.sessionId;
		const started = own && event.type === "session.compaction.started" ? event.data.inputID : undefined;
		if (replay && typeof started === "string" && accounted.includes(started)) return;
		const ended = own && event.type === "session.compaction.ended";
		const was = view;
		view = applyOpencodeEvent(view, event, deps.client.sessionId);
		if (was.compacting && !view.compacting) {
			if (was.compactionId) account(was.compactionId);
			else unnamedEnd = true;
		}
		if (ended && !was.compacting) {
			// The read already counted it.
			if (replay) return;
			unnamedEnd = true;
			// Its start fell in a gap, so no edge was reported.
			pulseCompaction();
		}
		if (view !== was || ended) publish();
	}

	async function resync(buffered: OpencodeEvent[], live: { on: boolean }, signal: AbortSignal): Promise<void> {
		const snapshot = await deps.client.snapshot(signal);
		// A newer connection owns the view.
		if (signal.aborted) return;
		const { newestDone } = compactionsOf(snapshot);
		const missed = primed && !unnamedEnd && newestDone !== undefined && !accounted.includes(newestDone);
		account(newestDone);
		primed = true;
		unnamedEnd = false;
		view = viewFromSnapshot(snapshot);
		if (missed) pulseCompaction();
		publish();
		live.on = true;
		for (const event of buffered.splice(0)) apply(event, true);
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
			apply(event, false);
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
