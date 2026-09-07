import type { Ambient, IntervalHandle, TimerHandle } from "../../shared/ambient.js";
import { fireAndForget } from "../fireAndForget.js";

export interface ShareAttestorDeps {
	shares: () => string[];
	liveJobIds: (sessionTarget: string) => string[];
	send: (action: string, params: Record<string, unknown>) => Promise<unknown>;
	incarnation: () => number | null;
	intervalMs?: number;
	/** Minimum interval between change-triggered attestations. */
	minGapMs?: number;
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer" | "setInterval" | "clearInterval">;
}

export function createShareAttestor(deps: ShareAttestorDeps) {
	let previousLive = new Map<string, string[]>();
	/** Targets whose attestation was refused, carried to the next sweep. */
	const pendingRetry = new Set<string>();
	let timer: IntervalHandle | null = null;
	let coalesce: TimerHandle | null = null;
	let lastAt = Number.NEGATIVE_INFINITY;
	const now = () => deps.ambient.now();
	const minGapMs = deps.minGapMs ?? 1_000;

	const attest = (): void => {
		if (coalesce) return;
		const wait = Math.max(0, minGapMs - (now() - lastAt));
		if (wait === 0) {
			send();
			return;
		}
		coalesce = deps.ambient.setTimer(() => {
			coalesce = null;
			send();
		}, wait);
	};

	const send = (): void => {
		const incarnation = deps.incarnation();
		if (incarnation === null) return;
		lastAt = now();
		const current = new Set(deps.shares());
		const currentLive = new Map<string, string[]>();
		// A refusal queues its target rather than writing back into a map a later sweep replaces.
		const retrying = new Set(pendingRetry);
		pendingRetry.clear();
		for (const sessionTarget of new Set([...current, ...previousLive.keys(), ...retrying])) {
			const jobIds = deps.liveJobIds(sessionTarget);
			if (jobIds.length === 0 && !previousLive.has(sessionTarget) && !retrying.has(sessionTarget)) continue;
			if (jobIds.length > 0) currentLive.set(sessionTarget, jobIds);
			fireAndForget(
				`share attestation for ${sessionTarget}`,
				deps.send("share_job_live", { sessionTarget, jobIds, observedAt: now() }),
				() => pendingRetry.add(sessionTarget),
			);
		}
		previousLive = currentLive;
	};

	const start = (): void => {
		// The interval sends the heartbeat directly, bypassing change coalescing.
		if (timer) return;
		timer = deps.ambient.setInterval(send, deps.intervalMs ?? 60_000);
	};

	const stop = (): void => {
		if (coalesce) deps.ambient.clearTimer(coalesce);
		coalesce = null;
		if (!timer) return;
		deps.ambient.clearInterval(timer);
		timer = null;
	};

	return { attest, start, stop };
}
