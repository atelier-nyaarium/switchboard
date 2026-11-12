import type { AgentBackendSession } from "../agents/backendSession.js";
import type { LocalBackendSpec } from "./localAgentRuntime.js";

export interface LocalChildHost {
	spec: LocalBackendSpec;
	now(): number;
	inFlight(): number;
	hasActiveTurn(): boolean;
	/** A child that closed, by reap, by drop or on its own. */
	onClosed(session: AgentBackendSession): void;
}

/** Idle duration before local child reaping. */
export const LOCAL_IDLE_REAP_MS = 10 * 60_000;

export class LocalChildSession {
	private session?: AgentBackendSession;
	private opening?: Promise<AgentBackendSession>;
	/** Child activity clock, independent of agent timestamps. */
	private lastUsedAt = 0;
	private idleTimer?: ReturnType<typeof setInterval>;

	constructor(private readonly host: LocalChildHost) {}

	reapIfIdle(): boolean {
		if (!this.session || !this.host.spec.threadsResumable) return false;
		if (this.host.inFlight() > 0) return false;
		if (this.host.now() - this.lastUsedAt < LOCAL_IDLE_REAP_MS) return false;
		if (this.host.hasActiveTurn()) return false;
		this.drop(this.session);
		return true;
	}

	/** Ends a child. The next open starts another. */
	drop(session: AgentBackendSession): void {
		// Clear locally even if close omits its callback.
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
		if (this.session) return Promise.resolve(this.session);
		this.startIdleReaper();
		// Share one child to avoid duplicate readers and ID spaces.
		this.opening ??= this.host.spec
			.openSession()
			.then((session) => {
				this.session = session;
				// Identity-guard late closes from evicting successors.
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
