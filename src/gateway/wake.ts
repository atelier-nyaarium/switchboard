import type { Ambient, TimerHandle } from "../shared/ambient.js";
import type { LaunchFailure, SendRefusal } from "../shared/launch-notice.js";
import type { WakeStage } from "../shared/schemasWake.js";
import type { SessionHarness } from "../shared/session-harness.js";
import { sanitizeLabel } from "../shared/session-sanitize.js";

export const DEFAULT_WAKE_TIMEOUT_MS = 600_000;
export const POST_WAKE_SETTLE_MS = 3_000;

// Timeout and disconnect are ambiguous host outcomes.
export interface WakeResult {
	ok: boolean;
	errorKind?: "timeout" | "disconnected";
	error?: string;
	/** Why it did not come up, as the daemon typed it. */
	failure?: LaunchFailure;
	/** Why nothing was launched; the sender words it. */
	refusal?: SendRefusal;
	resolvedTeam?: string;
}

/** What a wake may create a missing session from. */
export interface WakeCreate {
	displayLabel?: string;
	/** Absent takes the place's only CLI. */
	harness?: SessionHarness;
	mintedFrom?: string;
	/** The send guard cleared it; a host spawn point mints nothing without. */
	cleared?: true;
}

export type WakeCreateDecision =
	| { kind: "reattach" }
	| { kind: "mint"; sessionLabel: string }
	| { kind: "refuse"; error: string; refusal: SendRefusal };

// Existing records reattach. Usable labels permit minting.
export function decideWakeCreate(
	team: string,
	hasExistingRecord: boolean,
	displayLabel: string | undefined,
): WakeCreateDecision {
	if (hasExistingRecord) return { kind: "reattach" };
	const clean = sanitizeLabel(displayLabel);
	if (!clean)
		return {
			kind: "refuse",
			error: `"${team}" does not exist yet; retry with a displayLabel to create it`,
			refusal: { kind: "no_label" },
		};
	return { kind: "mint", sessionLabel: clean };
}

interface WakeWaiter {
	resolve: (result: WakeResult) => void;
	/** Null while a container builds. */
	timer: TimerHandle | null;
	deadlineAt: number;
	timeoutMs: number;
}

export class WakeCoordinator {
	private waiters = new Map<string, WakeWaiter[]>();

	constructor(
		private readonly ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">,
		/** Late waiters read state. */
		private readonly isRegistered: (team: string) => boolean = () => false,
	) {}

	waitFor(team: string, timeoutMs: number): Promise<WakeResult> {
		if (this.isRegistered(team)) return Promise.resolve({ ok: true });
		return new Promise((resolve) => {
			const timer = this.ambient.setTimer(() => {
				this.removeWaiter(team, entry);
				resolve({ ok: false, errorKind: "timeout" });
			}, timeoutMs);
			const entry: WakeWaiter = { resolve, timer, deadlineAt: this.ambient.now() + timeoutMs, timeoutMs };
			if (!this.waiters.has(team)) this.waiters.set(team, []);
			this.waiters.get(team)!.push(entry);
		});
	}

	notify(team: string, success = true): void {
		this.settle(team, { ok: success });
	}

	/** The daemon's word that it will not come up. */
	fail(team: string, detail: Pick<WakeResult, "failure" | "error">): void {
		this.settle(team, { ok: false, ...detail });
	}

	/** A build holds the countdown; it runs whole from the container coming up. */
	stage(team: string, stage: WakeStage): void {
		const entries = this.waiters.get(team);
		if (!entries || stage === "cli_found") return;
		const now = this.ambient.now();
		for (const entry of entries) {
			this.clear(entry);
			if (stage === "building") {
				entry.deadlineAt = Number.POSITIVE_INFINITY;
				continue;
			}
			entry.deadlineAt = now + entry.timeoutMs;
			entry.timer = this.arm(team, entry, entry.timeoutMs);
		}
	}

	private settle(team: string, result: WakeResult): void {
		const entries = this.waiters.get(team);
		if (!entries) return;
		for (const entry of entries) {
			this.clear(entry);
			entry.resolve(result);
		}
		this.waiters.delete(team);
	}

	private clear(entry: WakeWaiter): void {
		if (entry.timer) this.ambient.clearTimer(entry.timer);
		entry.timer = null;
	}

	private arm(team: string, entry: WakeWaiter, ms: number): TimerHandle {
		return this.ambient.setTimer(() => {
			this.removeWaiter(team, entry);
			entry.resolve({ ok: false, errorKind: "timeout" });
		}, ms);
	}

	// Registration deadlines never extend the original wake timeout.
	ackReceived(team: string, registerWindowMs: number): void {
		const entries = this.waiters.get(team);
		if (!entries) return;
		const now = this.ambient.now();
		for (const entry of entries) {
			this.clear(entry);
			entry.timer = this.arm(team, entry, Math.max(0, Math.min(registerWindowMs, entry.deadlineAt - now)));
		}
	}

	// A dropped host link does not prove the wake failed.
	failAll(): void {
		for (const entries of this.waiters.values()) {
			for (const entry of entries) {
				this.clear(entry);
				entry.resolve({ ok: false, errorKind: "disconnected" });
			}
		}
		this.waiters.clear();
	}

	private removeWaiter(team: string, target: WakeWaiter): void {
		const entries = this.waiters.get(team);
		if (!entries) return;
		const idx = entries.indexOf(target);
		if (idx >= 0) entries.splice(idx, 1);
		if (entries.length === 0) this.waiters.delete(team);
	}
}
