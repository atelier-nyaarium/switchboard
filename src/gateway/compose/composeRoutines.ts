import type { Ambient } from "../../shared/ambient.js";
import { openDurable } from "../../shared/durable-store.js";
import { ownerLaunchPhrase } from "../../shared/launch-notice.js";
import {
	occurrenceIdOf,
	ROUTINE_REPORT_GRACE_MS,
	type Routine,
	type RoutineAttention,
	type RoutineMiss,
	type RoutineState,
	routineRefusal,
} from "../../shared/schemasRoutine.js";
import type { Runbook } from "../../shared/schemasRunbook.js";
import type { SessionBaseline } from "../../shared/session-baseline.js";
import type { RoutineConsoleHandlers } from "../console/consoleTypes.js";
import { fireAndForget } from "../fireAndForget.js";
import type { LaunchOutcome, RoutineRun } from "../launchRecords.js";
import { type Attention, createAttentionStore } from "../routines/attention.js";
import { createRoutineMemoryStore } from "../routines/memory.js";
import { createOccurrenceStore, type Occurrence, pastLife } from "../routines/occurrences.js";
import { renderRoutine } from "../routines/render.js";
import { routineTeam, takenReason, targetRules, UNPLACED_REASON } from "../routines/reservation.js";
import { createRoutineRoutes, type Handler as RoutineRouteHandler } from "../routines/routineRoutes.js";
import { createRoutineRunner, type RoutineAttempt } from "../routines/runner.js";
import type { FileOutcome } from "../routines/sessionRoutine.js";
import { createRoutineStore } from "../routines/store.js";

// FIXME 2026-11-23: remove. Older apps convert into it.
const LEGACY_LIST_ZONE = "America/Los_Angeles";

export interface RoutineStageDeps {
	dataDir: string;
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer" | "newId">;
	/** Read late; composed after this stage. */
	attempt?: () => RoutineAttempt | null;
	getRunbook?: (runbookId: string) => Runbook | null;
	knowsSpawn?: (spawn: string) => boolean;
	assistantPlaced?: () => boolean;
	/** Ownership by provenance, never by name. */
	sessionOwned?: (team: string, routine: Routine) => boolean;
	/** Session holding the pane elsewhere. */
	paneHolder?: (team: string) => string | undefined;
	/** The only road to a routine's grants. */
	setRoutineGrants?: (routineId: string, entryIds: string[]) => void;
	/** Required: omitted, the door answers unauthenticated. */
	resolveCaller: (req: Request) => string | null;
}

export interface RoutineStage {
	console: RoutineConsoleHandlers;
	routes: Map<string, RoutineRouteHandler>;
	/** Armed after routes exist. */
	start: () => void;
	stop: () => Promise<void>;
	reconcile: () => Promise<void>;
	bindExecution: (attempt: RoutineAttempt) => void;
	/** What a standing grant reads. */
	workingRoutine: (sessionTarget: string) => string | null;
	openRuns: (sessionTarget: string) => SessionBaseline["routines"];
	/** Keeps the session from the idle sweep. */
	reserves: (sessionTarget: string) => boolean;
	/** May unblock a stopped routine. */
	runbookMoved: (runbookId: string) => void;
	/** True once the run took it. */
	launchSettled: (run: RoutineRun, outcome: LaunchOutcome, team: string) => boolean;
	secretUnanswered: (sessionTarget: string, entryId: string) => void;
	/** Ends any work open in it. */
	sessionEnded: (sessionTarget: string) => void;
}

/** Occurrences wait, never missed. */
const IDLE_ATTEMPT: RoutineAttempt = {
	sessionIdle: () => false,
	hasSession: () => false,
	forgetSession: () => {},
	prepare: async () => ({ ok: false, reason: "unreachable" }),
	deliver: async () => undefined,
};

/** Newest wanting occurrence, folded. */
function attentionFor(rows: Attention[]): RoutineAttention | undefined {
	const newest = rows.reduce((held, row) => Math.max(held, row.scheduledAt), -1);
	if (newest < 0) return undefined;
	const wanted = rows.filter((row) => row.scheduledAt === newest);
	return {
		// Run now and Dismiss read it as a number.
		occurrenceId: String(newest),
		scheduledAt: newest,
		entryIds: [...new Set(wanted.map((row) => row.entryId))].sort(),
	};
}

function panelFor(rows: Occurrence[], now: number): RoutineMiss | undefined {
	const missed = rows.filter((row) => row.state === "missed").sort((a, b) => b.scheduledAt - a.scheduledAt);
	const newest = missed[0];
	if (!newest) return undefined;
	return {
		occurrenceId: String(newest.scheduledAt),
		scheduledAt: newest.scheduledAt,
		reason: newest.reason ?? "gateway_down",
		runnable: now <= newest.deadlineAt,
	};
}

export function composeRoutines(deps: RoutineStageDeps): RoutineStage {
	let bound: RoutineAttempt | null = null;
	/** No asker means owned. */
	const ownsIts = (team: string, routine: Routine): boolean => deps.sessionOwned?.(team, routine) ?? true;
	const store = openDurable(deps.dataDir, "routines", (durable) =>
		createRoutineStore({
			store: durable,
			getRunbook: deps.getRunbook,
			knowsSpawn: deps.knowsSpawn,
			assistantPlaced: deps.assistantPlaced,
			sessionTaken: (routine) => ownsIts(routineTeam(routine), routine) === false,
			paneHolder: (routine) => deps.paneHolder?.(routineTeam(routine)),
			now: () => deps.ambient.now(),
			newIncarnation: () => deps.ambient.newId(),
			onChanged: () => storeMoved(),
		}),
	);
	const occurrences = openDurable(deps.dataDir, "routine-occurrences", (durable) =>
		createOccurrenceStore({ store: durable }),
	);
	const attention = openDurable(deps.dataDir, "routine-attention", (durable) =>
		createAttentionStore({ store: durable }),
	);
	// Own file: poisoned memory spares routines.
	const memory = openDurable(deps.dataDir, "routine-memory", (durable) =>
		createRoutineMemoryStore({ store: durable }),
	);
	const runner = createRoutineRunner({
		routines: store,
		occurrences,
		ambient: deps.ambient,
		attempt: () => bound ?? deps.attempt?.() ?? IDLE_ATTEMPT,
		// Before the sweep deletes proposals.
		recoverProposals: () => recoverProposals(),
		sweepMemory: (live) => memory.sweepOrphans(live),
	});

	const state = (): RoutineState[] => {
		const now = deps.ambient.now();
		return store.list().map((routine) => {
			const rows = occurrences.forRoutine(routine.id);
			const newestOf = (state: Occurrence["state"]) =>
				rows.filter((row) => row.state === state).sort((a, b) => b.scheduledAt - a.scheduledAt)[0];
			const ran = newestOf("dispatched");
			const review = newestOf("needs_review");
			const reviewReason = review ? reviewText(routine, review) : null;
			const waiting = newestOf("waiting_idle")?.reason;
			const nextAt = runner.nextAt(routine, now);
			const missed = panelFor(rows, now);
			const wanted = attentionFor(attention.forRoutine(routine.id));
			return {
				routine,
				...(nextAt === null ? {} : { nextAt }),
				...(ran ? { lastRanAt: ran.scheduledAt } : {}),
				// Liveness alone cannot say it was read.
				...(ran?.readAt === undefined ? {} : { lastReadAt: ran.readAt }),
				...(missed ? { missed } : {}),
				...(review ? { reviewAt: review.scheduledAt } : {}),
				...(reviewReason ? { reviewReason } : {}),
				...(waiting ? { waiting } : {}),
				...(wanted ? { attention: wanted } : {}),
			};
		});
	};

	/** Render refusal, or null. */
	const blockedBy = (routine: Routine): string | null => {
		if (!deps.getRunbook) return null;
		const rendered = renderRoutine(deps.getRunbook(routine.runbookId), routine);
		return rendered.ok ? null : rendered.reason;
	};

	/** Render stops read the runbook now. */
	const reviewText = (routine: Routine, row: Occurrence): string | null => {
		if (row.reviewCause === "session_taken") return takenReason(routine, deps.paneHolder?.(routineTeam(routine)));
		if (row.reviewCause === "assistant_unplaced") return UNPLACED_REASON;
		if (row.reviewCause === "launch_failed") return row.launchFailure ? ownerLaunchPhrase(row.launchFailure) : null;
		return blockedBy(routine);
	};

	/** Authority is rewritten from the stored record. */
	const settleGrants = (routineId: string): void => {
		const held = store.get(routineId);
		deps.setRoutineGrants?.(routineId, held?.enabled ? held.linkedEntries : []);
	};

	/** Rearms the runner; else a fresh save waits out the tick. */
	function storeMoved(): void {
		fireAndForget("routine rearm", runner.reconcile());
	}

	/** Clears render stops that now render. */
	const settleRenderReviews = (routines: readonly Routine[]): void => {
		for (const routine of routines) {
			if (blockedBy(routine) === null) occurrences.clearReview(routine.id, "unrenderable");
		}
	};

	/** A runbook edit can unblock a routine. */
	const runbookMoved = (runbookId: string): void => {
		const using = store.list().filter((routine) => routine.runbookId === runbookId);
		if (using.length === 0) return;
		settleRenderReviews(using);
		// A stopped slot still in its window runs now.
		storeMoved();
	};

	const pastLifeOf = (row: Occurrence): boolean => pastLife(row, store.get(row.routineId)?.incarnation);

	/** Keyed by the preparing incarnation, never a later one. */
	const memoryKey = (row: Occurrence): string | null => (pastLifeOf(row) ? null : (row.incarnation ?? null));

	const remembered = (row: Occurrence): { text: string; version: number } => {
		const incarnation = memoryKey(row);
		return incarnation ? memory.read(incarnation) : { text: "", version: 0 };
	};

	/** Idempotent; memory past the base is a later run's, never overwritten. */
	const recoverProposals = (): void => {
		for (const row of occurrences.all()) {
			if (row.memoryProposed === undefined || row.memoryApplied === true) continue;
			const incarnation = memoryKey(row);
			if (!incarnation) continue;
			const base = row.memoryVersion ?? 0;
			const current = memory.read(incarnation);
			if (current.version === base) {
				const wrote = memory.write(incarnation, row.memoryProposed, base, deps.ambient.now());
				if (!wrote.ok) continue;
			} else if (!(current.version === base + 1 && current.text === row.memoryProposed)) {
				console.warn(`[routine] ${row.routineId}:${row.scheduledAt} history superseded; proposal dropped`);
			}
			occurrences.noteMemoryApplied(row.routineId, row.scheduledAt);
		}
	};

	/** Occurrence first: a crash then fails safe, authority already closed. */
	const fileReport = (
		routineId: string,
		scheduledAt: number,
		report: string,
		proposal: { text: string; base: number; force: boolean },
	): FileOutcome => {
		const row = occurrences.at(routineId, scheduledAt);
		const incarnation = row ? memoryKey(row) : null;
		if (!incarnation) return { kind: "refused" };
		// Before any write.
		if (!proposal.force) {
			const current = memory.read(incarnation);
			if (current.version !== proposal.base) {
				occurrences.noteMemoryBounced(routineId, scheduledAt);
				return { kind: "conflict", current };
			}
		}
		const now = deps.ambient.now();
		const filed = occurrences.noteReport(routineId, scheduledAt, report, now, now + ROUTINE_REPORT_GRACE_MS, {
			proposed: proposal.text,
			base: proposal.base,
		});
		if (!filed) return { kind: "refused" };
		const wrote = proposal.force
			? memory.overwrite(incarnation, proposal.text, now)
			: memory.write(incarnation, proposal.text, proposal.base, now);
		// A failed write leaves memoryApplied false for recovery.
		if (wrote && (wrote as { ok?: boolean }).ok !== false) {
			occurrences.noteMemoryApplied(routineId, scheduledAt);
		}
		return { kind: "filed", occurrence: filed };
	};

	return {
		routes: createRoutineRoutes({
			resolveCaller: deps.resolveCaller,
			// Past lives are excluded.
			occurrences: () => occurrences.all().filter((row) => !pastLifeOf(row)),
			routineName: (routineId) => store.get(routineId)?.name ?? null,
			noteRead: (routineId, scheduledAt) => occurrences.noteRead(routineId, scheduledAt, deps.ambient.now()),
			memory: (row) => remembered(row),
			fileReport: (routineId, scheduledAt, report, proposal) =>
				fileReport(routineId, scheduledAt, report, proposal),
		}),
		console: {
			list: () => ({ routines: state(), zone: LEGACY_LIST_ZONE }),
			put: (routine, base) => {
				const result = store.put(routine, { base });
				if (result.stored) {
					occurrences.clearReview(routine.id);
					// The owner's save answers what it wanted.
					attention.clear(routine.id);
					settleGrants(routine.id);
				}
				return result;
			},
			nextAt: (routine) => {
				const refusal = routineRefusal(routine);
				if (refusal) return { nextAt: null, reason: refusal };
				return { nextAt: runner.nextAt(routine, deps.ambient.now()) };
			},
			remove: (routineId) => {
				// Routine first; the incarnation is memory's only key, read before it goes.
				const incarnation = store.get(routineId)?.incarnation;
				const removed = store.remove(routineId);
				if (!removed.deleted) return removed;
				occurrences.clear(routineId);
				attention.clear(routineId);
				if (incarnation) memory.clear(incarnation);
				settleGrants(routineId);
				return removed;
			},
			enable: (routineId, enabled, base) => {
				const result = store.setEnabled(routineId, enabled, base);
				if (result.stored) settleGrants(routineId);
				return result;
			},
			runNow: async (routineId, occurrenceId) => {
				const ran = await runner.runNow(routineId, Number(occurrenceId));
				return ran ? { applied: true } : { applied: false, reason: "that occurrence cannot be run now" };
			},
			run: async (routineId) => {
				const opened = await runner.runFresh(routineId);
				return opened === null
					? { ran: false, reason: "this Gateway could not start a run" }
					: { ran: true, occurrenceId: String(opened) };
			},
			dismiss: (routineId, occurrenceId) =>
				runner.dismiss(routineId, Number(occurrenceId))
					? { applied: true }
					: { applied: false, reason: "that occurrence is not waiting to be dismissed" },
		},
		start: () => {
			// Reviews outlive their cause.
			settleRenderReviews(store.list());
			runner.start();
		},
		stop: () => runner.stop(),
		reconcile: () => runner.reconcile(),
		bindExecution: (attempt) => {
			bound = attempt;
		},
		reserves: (sessionTarget) =>
			store.list().some((routine) => targetRules(routine).ownsSession && routineTeam(routine) === sessionTarget),
		workingRoutine: (sessionTarget) => {
			const held = runner.firstWorkingOccurrence(sessionTarget);
			const routine = held && store.get(held.routineId);
			// Authority never follows a name.
			if (!routine || !targetRules(routine).holdsSecrets || !ownsIts(sessionTarget, routine)) return null;
			return routine.id;
		},
		openRuns: (sessionTarget) =>
			runner.workingOccurrences(sessionTarget).flatMap((held) => {
				const routine = store.get(held.routineId);
				if (!routine || !ownsIts(sessionTarget, routine)) return [];
				return [{ occurrenceId: occurrenceIdOf(held.routineId, held.scheduledAt), routine: routine.name }];
			}),
		runbookMoved,
		launchSettled: (run, outcome, team) => runner.launchEnded(run.routineId, run.scheduledAt, outcome, team),
		sessionEnded: (sessionTarget) => {
			// Every window; one left open keeps authority.
			for (const held of runner.workingOccurrences(sessionTarget)) {
				occurrences.noteWork(held.routineId, held.scheduledAt, "done");
			}
		},
		secretUnanswered: (sessionTarget, entryId) => {
			const held = runner.workingOccurrences(sessionTarget).find((row) => {
				const routine = store.get(row.routineId);
				return routine !== null && targetRules(routine).holdsSecrets;
			});
			if (!held) return;
			attention.note({
				routineId: held.routineId,
				scheduledAt: held.scheduledAt,
				entryId,
				at: deps.ambient.now(),
			});
		},
	};
}
