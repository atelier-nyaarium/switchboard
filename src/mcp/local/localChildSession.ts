import type { AgentBackendSession } from "../agents/backendSession.js";
import type { LocalBackendSpec } from "./localAgentRuntime.js";

export interface LocalChildHost {
	spec: LocalBackendSpec;
	now(): number;
	inFlight(): number;
	hasActiveTurn(): boolean;
	/** Session closure from any source. */
	onClosed(session: AgentBackendSession): void;
}

export const LOCAL_IDLE_REAP_MS = 10 * 60_000;

/** Local mode's one child: open, idle reap, drop, shutdown. */
export class LocalChildSession {
	private session?: AgentBackendSession;
	private opening?: Promise<AgentBackendSession>;
	/** Reaping uses its own activity clock. */
	private lastUsedAt = 0;
	private idleTimer?: ReturnType<typeof setInterval>;
	/** No child opens after shutdown. */
	private ended = false;

	constructor(private readonly host: LocalChildHost) {}

	reapIfIdle(): boolean {
		if (!this.session || !this.host.spec.threadsResumable) return false;
		if (this.host.inFlight() > 0) return false;
		if (this.host.now() - this.lastUsedAt < LOCAL_IDLE_REAP_MS) return false;
		if (this.host.hasActiveTurn() || this.session.busy?.()) return false;
		this.drop(this.session);
		return true;
	}

	isOpen(): boolean {
		return this.session !== undefined || this.opening !== undefined;
	}

	drop(session: AgentBackendSession): void {
		// Clear locally if close omits callback.
		if (this.session === session) {
			this.session = undefined;
			this.opening = undefined;
		}
		session.close();
	}

	markUsed(at: number = this.host.now()): void {
		this.lastUsedAt = Math.max(this.lastUsedAt, at);
	}

	open(): Promise<AgentBackendSession> {
		if (this.ended) return Promise.reject(new Error(`${this.host.spec.displayName} is shut down`));
		if (this.session) return Promise.resolve(this.session);
		this.startIdleReaper();
		// Share one child to preserve thread IDs.
		this.opening ??= this.host.spec
			.openSession()
			.then((session) => {
				if (this.ended) {
					session.close();
					throw new Error(`${this.host.spec.displayName} is shut down`);
				}
				this.session = session;
				// Stale closes must not clear successors.
				session.onClosed(() => {
					if (this.session === session) this.session = undefined;
					this.host.onClosed(session);
				});
				return session;
			})
			.finally(() => {
				this.opening = undefined;
			});
		return this.opening;
	}

	shutdown(): void {
		this.ended = true;
		if (this.idleTimer) clearInterval(this.idleTimer);
		this.idleTimer = undefined;
		this.session?.close();
		this.session = undefined;
		this.opening = undefined;
	}

	private startIdleReaper(): void {
		if (this.idleTimer || !this.host.spec.threadsResumable) return;
		this.idleTimer = setInterval(() => this.reapIfIdle(), LOCAL_IDLE_REAP_MS / 2);
		this.idleTimer.unref?.();
	}
}
