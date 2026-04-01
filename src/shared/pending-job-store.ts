////////////////////////////////
//  Interfaces & Types

export type JobState = "waiting" | "timed_out" | "stored";

interface JobEntry<T> {
	id: string;
	from: string;
	to: string;
	state: JobState;
	createdAt: number;
	timer: ReturnType<typeof setTimeout> | null;
	resolve: ((result: WaitResult<T>) => void) | null;
	storedResult: T | null;
}

export interface WaitResult<T> {
	delivered: boolean;
	result?: T;
}

////////////////////////////////
//  Class

export class PendingJobStore<T> {
	private entries = new Map<string, JobEntry<T>>();
	private ttlMs: number;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(ttlMs = 600_000) {
		this.ttlMs = ttlMs;
	}

	get size(): number {
		return this.entries.size;
	}

	startCleanup(intervalMs = 60_000): void {
		if (this.cleanupTimer) return;
		this.cleanupTimer = setInterval(() => this.sweep(), intervalMs);
	}

	stopCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	create(id: string, from: string, to: string): void {
		const existing = this.entries.get(id);
		if (existing?.timer) clearTimeout(existing.timer);
		this.entries.set(id, {
			id,
			from,
			to,
			state: "waiting",
			createdAt: Date.now(),
			timer: null,
			resolve: null,
			storedResult: null,
		});
	}

	waitForResult(id: string, timeoutMs: number): Promise<WaitResult<T>> {
		const entry = this.entries.get(id);
		if (!entry) return Promise.resolve({ delivered: false });
		return new Promise((resolve) => {
			entry.resolve = resolve;
			entry.timer = setTimeout(() => {
				entry.state = "timed_out";
				entry.timer = null;
				entry.resolve = null;
				resolve({ delivered: false });
			}, timeoutMs);
		});
	}

	deliver(id: string, result: T): { delivered: boolean; from: string; to: string } | false {
		const entry = this.entries.get(id);
		if (!entry) return false;

		if (entry.state === "waiting" && entry.resolve) {
			// Synchronous delivery: someone is waiting via waitForResult()
			if (entry.timer) clearTimeout(entry.timer);
			entry.timer = null;
			entry.resolve({ delivered: true, result });
			entry.resolve = null;
			this.entries.delete(id);
			return { delivered: true, from: entry.from, to: entry.to };
		}

		if (entry.state === "waiting" && !entry.resolve) {
			// Async delivery: channel mode, no one called waitForResult(). Store for polling.
			entry.state = "stored";
			entry.storedResult = result;
			entry.createdAt = Date.now();
			return { delivered: true, from: entry.from, to: entry.to };
		}

		if (entry.state === "timed_out") {
			entry.state = "stored";
			entry.storedResult = result;
			entry.createdAt = Date.now();
			return { delivered: true, from: entry.from, to: entry.to };
		}

		if (entry.state === "stored") {
			// Re-delivery: channel sessions may receive multiple replies
			entry.storedResult = result;
			entry.createdAt = Date.now();
			return { delivered: true, from: entry.from, to: entry.to };
		}

		return false;
	}

	remove(id: string): void {
		const entry = this.entries.get(id);
		if (entry?.timer) clearTimeout(entry.timer);
		this.entries.delete(id);
	}

	poll(id: string): T | null | undefined {
		const entry = this.entries.get(id);
		if (!entry) return undefined;

		if (entry.state === "stored" && entry.storedResult !== null) {
			const result = entry.storedResult;
			this.entries.delete(id);
			return result;
		}

		if (entry.state === "timed_out") {
			return null;
		}

		return undefined;
	}

	getIdsForTeam(team: string): string[] {
		const ids: string[] = [];
		for (const [id, entry] of this.entries) {
			if (entry.to === team) ids.push(id);
		}
		return ids;
	}

	listAll(): Array<{ id: string; from: string; to: string; state: JobState }> {
		return [...this.entries.values()].map(({ id, from, to, state }) => ({ id, from, to, state }));
	}

	private sweep(): void {
		const now = Date.now();
		for (const [id, entry] of this.entries) {
			if (entry.state !== "waiting" && now - entry.createdAt > this.ttlMs) {
				if (entry.timer) clearTimeout(entry.timer);
				this.entries.delete(id);
			}
		}
	}
}
