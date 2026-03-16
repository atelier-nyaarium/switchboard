////////////////////////////////
//  Class

export class Mutex {
	public locked = false;
	public queue: (() => void)[] = [];
	public holder: string | null = null;

	public acquire(callbackId: string): Promise<() => void> {
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

	public release(): void {
		this.holder = null;
		this.locked = false;
		if (this.queue.length > 0) {
			this.queue.shift()!();
		}
	}
}

////////////////////////////////
//  Functions & Helpers

export function getMutex(targetLocks: Map<string, Mutex>, team: string): Mutex {
	if (!targetLocks.has(team)) {
		targetLocks.set(team, new Mutex());
	}
	return targetLocks.get(team)!;
}
