import {
	hasActiveTeammate,
	hasWorkflow,
	isAgentWorking,
	isCompacting,
	isLoggedOut,
	limitNotice,
	restartPending,
} from "../../shared/agent-screen.js";
import { type HostPeekResult, paneKey, type TmuxTarget } from "../../shared/host-op.js";
import { type DerivedPresence, sameDerived } from "../../shared/schemasPresence.js";
import {
	foldHarness,
	mintedIdOf,
	type PaneAutoAnswer,
	paneRoad,
	readHarness,
	type SessionHarness,
} from "../../shared/session-harness.js";
import { PromptOccurrences, type SeenPrompt, seePrompt } from "./permissionPrompt.js";
import { limitContinueDigit, type PromptSight, surveyShowing } from "./promptAnswer.js";

////////////////////////////////
//  Interfaces & Types

/** The frame's shape, with the prompt as seen. */
export type DerivedState = Omit<DerivedPresence, "prompt"> & { prompt?: SeenPrompt };

export interface WatchEntry {
	team: string;
	target: TmuxTarget;
	cadenceMs: number;
	harness: SessionHarness;
}

/** Null when this build cannot watch it. */
export function readWatch(
	raw: unknown,
): { team: string; cadenceMs: number; harness: SessionHarness; sessionId?: string } | null {
	const entry = (raw ?? {}) as Record<string, unknown>;
	if (typeof entry.team !== "string" || typeof entry.cadenceMs !== "number") return null;
	const harness = foldHarness(readHarness(entry.harness), {
		named: (named) => named,
		// An older Gateway named Copilot only by its session id.
		unnamed: (assumed) => (mintedIdOf("copilot", entry.copilotSessionId) ? "copilot" : assumed),
		unknown: () => null,
	});
	if (!harness) return null;
	// FIXME 2026-11-23: drop the `copilotSessionId` read.
	const sessionId = mintedIdOf(harness, entry.mintedSessionId ?? entry.copilotSessionId);
	return { team: entry.team, cadenceMs: entry.cadenceMs, harness, ...(sessionId ? { sessionId } : {}) };
}

/** Peeks without the resize side effect. Injected to stay testable. */
export type NoResizePeek = (target: TmuxTarget) => Promise<HostPeekResult>;

////////////////////////////////
//  Class

/**
 * Per-team 2-peek hysteresis, so one flicker cannot become a confirmed flip.
 *
 * Agreement is on the derived VALUE, never on frame identity. An idle pane is byte-identical capture
 * after capture, so requiring two distinct frames made the flip back to not-working unreachable.
 */
class HysteresisTracker {
	private pending: DerivedState | undefined;
	private confirmed: DerivedState | undefined;

	/** The confirmed value if this observation just confirmed it. */
	observe(value: DerivedState): DerivedState | undefined {
		if (sameValue(value, this.confirmed)) {
			// The blip settled back.
			this.pending = undefined;
			return undefined;
		}
		if (this.pending !== undefined && sameValue(value, this.pending)) {
			this.confirmed = value;
			this.pending = undefined;
			return value;
		}
		this.pending = value;
		return undefined;
	}

	confirmedValue(): DerivedState | undefined {
		return this.confirmed;
	}

	/** Clear to unknown, so reconnection re-derives from scratch. */
	clear(): void {
		this.pending = undefined;
		this.confirmed = undefined;
	}
}

// autoDeny stays local.
function sameValue(a: DerivedState, b: DerivedState | undefined): boolean {
	return b !== undefined && sameDerived(a, b) && a.prompt?.autoDeny === b.prompt?.autoDeny;
}

/** Tmux frames only: boot text in container logs would false-positive. */
export function deriveFromPeek(
	peek: HostPeekResult,
	sight: PromptSight = (screen) => seePrompt(new PromptOccurrences(), "", screen),
): DerivedState | undefined {
	if (peek.kind !== "tmux") return undefined;
	const limit = limitNotice(peek.ansi);
	const prompt = sight(peek.ansi);
	return {
		working: isAgentWorking(peek.ansi),
		needsLogin: isLoggedOut(peek.ansi),
		limitBlocked: limit !== null,
		...(limit?.detail ? { limitDetail: limit.detail } : {}),
		...(prompt ? { prompt } : {}),
		...(hasWorkflow(peek.ansi) ? { workflow: true } : {}),
		...(hasActiveTeammate(peek.ansi) ? { teammates: true } : {}),
		...(isCompacting(peek.ansi) ? { compacting: true } : {}),
	};
}

/** Peeks each watched session on its own timer and reports a confirmed change once per flip. */
export class PresenceScheduler {
	private readonly peek: NoResizePeek;
	private readonly report: (team: string, value: DerivedState | undefined) => void;
	private readonly onAutoDeny: (target: TmuxTarget, promptId: string) => void;
	private readonly onLimitDialog: (target: TmuxTarget) => void;
	private readonly onSurvey: (target: TmuxTarget) => void;
	private readonly onRestartPending: (team: string, pending: boolean) => void;
	private readonly restartShown = new Map<string, boolean>();
	private readonly occurrences: PromptOccurrences;
	private readonly now: () => number;
	private readonly watches = new Map<string, WatchEntry>();
	private readonly watchTokens = new Map<string, symbol>();
	private readonly trackers = new Map<string, HysteresisTracker>();
	private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
	private readonly consecutiveFailures = new Map<string, number>();
	private readonly observedFrames = new Map<string, HostPeekResult>();
	private readonly ticking = new Set<symbol>();
	private readonly dialogs: Record<
		PaneAutoAnswer,
		{ shows: (screen: string) => boolean; answer: (target: TmuxTarget) => void }
	> = {
		limit: {
			shows: (screen) => limitContinueDigit(screen) !== null,
			answer: (target) => this.onLimitDialog(target),
		},
		survey: { shows: surveyShowing, answer: (target) => this.onSurvey(target) },
	};
	/** Facts no pane shows, merged into every report. */
	private readonly overlays = new Map<string, Partial<DerivedState>>();

	constructor(opts: {
		peek: NoResizePeek;
		/** `undefined` means derivation became impossible, not a pending observation. */
		report: (team: string, value: DerivedState | undefined) => void;
		/** A confirmed prompt is counting down to a deny. */
		onAutoDeny?: (target: TmuxTarget, promptId: string) => void;
		/** A frame shows the usage-limit dialog with a wait option. */
		onLimitDialog?: (target: TmuxTarget) => void;
		/** A frame shows Copilot's feedback box. */
		onSurvey?: (target: TmuxTarget) => void;
		/** Whether the pane waits on a restart to apply an update, told on each change. */
		onRestartPending?: (team: string, pending: boolean) => void;
		/** Shared with the answer, so both name a prompt alike. */
		occurrences?: PromptOccurrences;
		now?: () => number;
	}) {
		this.peek = opts.peek;
		this.report = opts.report;
		this.onAutoDeny = opts.onAutoDeny ?? (() => {});
		this.onLimitDialog = opts.onLimitDialog ?? (() => {});
		this.onSurvey = opts.onSurvey ?? (() => {});
		this.onRestartPending = opts.onRestartPending ?? (() => {});
		this.occurrences = opts.occurrences ?? new PromptOccurrences();
		this.now = opts.now ?? (() => Date.now());
	}

	/** Replace the full watch set. A cadence change keeps its hysteresis history. Resolves once every
	 * rescheduled entry's first tick has run, which tests await. */
	setWatches(entries: WatchEntry[]): Promise<void> {
		const next = new Map(entries.map((e) => [e.team, e]));
		for (const [team] of this.watches) {
			if (!next.has(team)) this.stopWatching(team);
		}
		const initialTicks: Promise<void>[] = [];
		for (const entry of entries) {
			const existing = this.watches.get(entry.team);
			if (!existing || !sameTarget(existing.target, entry.target) || existing.cadenceMs !== entry.cadenceMs) {
				this.watchTokens.set(entry.team, Symbol());
				this.observedFrames.delete(entry.team);
			}
			if (existing && existing.cadenceMs === entry.cadenceMs) {
				this.watches.set(entry.team, entry); // target may have changed even if cadence didn't
				continue;
			}
			this.watches.set(entry.team, entry);
			initialTicks.push(this.rescheduleTimer(entry));
		}
		return Promise.all(initialTicks).then(() => undefined);
	}

	/** A change re-reports the confirmed value under it. */
	setOverlay(team: string, overlay: Partial<DerivedState> | undefined): void {
		const before = JSON.stringify(this.overlays.get(team) ?? null);
		if (overlay === undefined) this.overlays.delete(team);
		else this.overlays.set(team, overlay);
		if (before === JSON.stringify(overlay ?? null)) return;
		const confirmed = this.trackers.get(team)?.confirmedValue();
		if (confirmed) this.report(team, this.withOverlay(team, confirmed));
	}

	private withOverlay(team: string, value: DerivedState): DerivedState {
		const overlay = this.overlays.get(team);
		return overlay ? { ...value, ...overlay } : value;
	}

	/** Also called directly when a session's lifecycle ends. */
	stopWatching(team: string): void {
		const timer = this.timers.get(team);
		if (timer) clearInterval(timer);
		this.timers.delete(team);
		this.watches.delete(team);
		this.overlays.delete(team);
		this.watchTokens.delete(team);
		this.observedFrames.delete(team);
		this.consecutiveFailures.delete(team);
		this.restartShown.delete(team);
		const tracker = this.trackers.get(team);
		if (tracker) {
			tracker.clear();
			this.report(team, undefined);
		}
		this.trackers.delete(team);
	}

	/** Every frame source vanished at once. Watches are kept, so reconnect resumes peeking. */
	clearAll(): void {
		for (const team of this.trackers.keys()) this.report(team, undefined);
		for (const tracker of this.trackers.values()) tracker.clear();
		// Re-told after a reconnect.
		this.restartShown.clear();
	}

	private rescheduleTimer(entry: WatchEntry): Promise<void> {
		const existingTimer = this.timers.get(entry.team);
		if (existingTimer) clearInterval(existingTimer);
		const fresh = !this.trackers.has(entry.team);
		if (fresh) this.trackers.set(entry.team, new HysteresisTracker());
		const timer = setInterval(() => void this.tick(entry.team), entry.cadenceMs);
		timer.unref?.();
		this.timers.set(entry.team, timer);
		// Only a new team peeks now. An extra peek would land inside the cadence floor and hand back
		// the capture the last tick already consumed, counting one frame as two agreeing peeks.
		return fresh ? this.tick(entry.team) : Promise.resolve();
	}

	/** One peek-and-derive cycle, independent of the timer. Also the deterministic test entry. */
	async tick(team: string): Promise<void> {
		const entry = this.watches.get(team);
		const tracker = this.trackers.get(team);
		const token = this.watchTokens.get(team);
		if (!entry || !tracker || !token) return;
		if (this.ticking.has(token)) return;
		this.ticking.add(token);
		try {
			const peek = await this.peek(entry.target);
			if (!this.isCurrentWatch(team, token)) return;
			this.consecutiveFailures.set(team, 0);
			if (this.observedFrames.get(team) === peek) return;
			this.observedFrames.set(team, peek);
			const derived = deriveFromPeek(peek, (screen) =>
				seePrompt(this.occurrences, paneKey(entry.target), screen),
			);
			if (!derived) return; // Logs derive no state.
			if (peek.kind === "tmux") {
				for (const kind of paneRoad(entry.harness)?.autoAnswers ?? []) {
					if (this.dialogs[kind].shows(peek.ansi)) this.dialogs[kind].answer(entry.target);
				}
			}
			if (peek.kind === "tmux") {
				const pending = restartPending(entry.harness, peek.ansi);
				if (this.restartShown.get(team) !== pending) {
					this.restartShown.set(team, pending);
					this.onRestartPending(team, pending);
				}
			}
			const confirmed = tracker.observe(derived);
			if (!confirmed) return;
			this.report(team, this.withOverlay(team, confirmed));
			if (confirmed.prompt?.autoDeny) this.onAutoDeny(entry.target, confirmed.prompt.id);
		} catch {
			if (!this.isCurrentWatch(team, token)) return;
			// One blip retains frame.
			const failures = (this.consecutiveFailures.get(team) ?? 0) + 1;
			this.consecutiveFailures.set(team, failures);
			if (failures >= 3) {
				tracker.clear();
				this.report(team, undefined);
			}
		} finally {
			this.ticking.delete(token);
		}
	}

	private isCurrentWatch(team: string, token: symbol): boolean {
		return this.watches.has(team) && this.watchTokens.get(team) === token;
	}
}

function sameTarget(a: TmuxTarget, b: TmuxTarget): boolean {
	return a.kind === b.kind && a.name === b.name && a.sessionName === b.sessionName;
}
