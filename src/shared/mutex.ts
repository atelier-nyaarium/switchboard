// ---------------------------------------------------------------------------
// Mutex for serializing concurrent sends to the same target team.
// ---------------------------------------------------------------------------
export class Mutex {
	locked = false;
	queue: (() => void)[] = [];
	holder: string | null = null;

	acquire(callbackId: string): Promise<() => void> {
		return new Promise((resolve) => {
			const tryAcquire = () => {
				if (!this.locked) {
					this.locked = true;
					this.holder = callbackId;
					resolve(() => this.release());
				} else {
					this.queue.push(tryAcquire);
				}
			};
			tryAcquire();
		});
	}

	release(): void {
		this.holder = null;
		this.locked = false;
		if (this.queue.length > 0) {
			this.queue.shift()!();
		}
	}
}

export function getMutex(targetLocks: Map<string, Mutex>, team: string): Mutex {
	if (!targetLocks.has(team)) {
		targetLocks.set(team, new Mutex());
	}
	return targetLocks.get(team)!;
}
