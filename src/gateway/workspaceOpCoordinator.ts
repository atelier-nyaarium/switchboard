// Correlates a workspace op with its reply, the way `HostOpCoordinator` does for host ops.
//
// What it adds is a GENERATION: a pending entry remembers the socket it was issued on, so a late
// answer from a replaced socket cannot settle a request issued against its successor. Without it the
// rule would rest on reqId randomness rather than on anything stated.

import type { Ambient, TimerHandle } from "../shared/ambient.js";
import type { WorkspaceOpResult } from "../shared/workspace-op.js";

interface Waiter {
	generation: number;
	resolve: (result: WorkspaceOpResult) => void;
	timer: TimerHandle;
}

export class WorkspaceOpCoordinator {
	private pending = new Map<string, Waiter>();

	constructor(private readonly ambient: Pick<Ambient, "setTimer" | "clearTimer">) {}

	wait(reqId: string, generation: number, timeoutMs: number): Promise<WorkspaceOpResult> {
		return new Promise((resolve) => {
			const timer = this.ambient.setTimer(() => {
				this.pending.delete(reqId);
				resolve({ ok: false, failure: "timeout", detail: "the session did not answer in time" });
			}, timeoutMs);
			this.pending.set(reqId, { generation, resolve, timer });
		});
	}

	/** A reply whose generation has been replaced is dropped, not settled. */
	settle(reqId: string, generation: number, result: WorkspaceOpResult): boolean {
		const waiter = this.pending.get(reqId);
		if (waiter === undefined || waiter.generation !== generation) return false;
		this.ambient.clearTimer(waiter.timer);
		this.pending.delete(reqId);
		waiter.resolve(result);
		return true;
	}

	/** A dropped socket settles only what it was carrying, so another session's waits are untouched. */
	failGeneration(generation: number, detail: string): number {
		let failed = 0;
		for (const [reqId, waiter] of [...this.pending]) {
			if (waiter.generation !== generation) continue;
			this.ambient.clearTimer(waiter.timer);
			this.pending.delete(reqId);
			waiter.resolve({ ok: false, failure: "disconnected", detail });
			failed += 1;
		}
		return failed;
	}

	failAll(detail: string): void {
		for (const [, waiter] of this.pending) {
			this.ambient.clearTimer(waiter.timer);
			waiter.resolve({ ok: false, failure: "disconnected", detail });
		}
		this.pending.clear();
	}

	get waiting(): number {
		return this.pending.size;
	}
}
