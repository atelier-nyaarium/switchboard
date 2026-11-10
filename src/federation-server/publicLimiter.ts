import type { Clock } from "../shared/ambient.js";

////////////////////////////////
//  Constants

const DEFAULT_MAX_GLOBAL_PER_WINDOW = 600;
const DEFAULT_MAX_PER_ID_PER_WINDOW = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

////////////////////////////////
//  Interfaces & Types

export interface PublicLimits {
	maxGlobalPerWindow?: number;
	maxPerIdPerWindow?: number;
	rateLimitWindowMs?: number;
}

////////////////////////////////
//  Classes

/** One fixed window for a public route: a count for everyone and a count per id. */
export class PublicLimiter {
	private readonly maxGlobalPerWindow: number;
	private readonly maxPerIdPerWindow: number;
	private readonly rateLimitWindowMs: number;
	private windowStartedAt = 0;
	private globalCount = 0;
	private readonly perId = new Map<string, number>();

	public constructor(
		private readonly ambient: Clock,
		limits: PublicLimits = {},
	) {
		this.maxGlobalPerWindow = limits.maxGlobalPerWindow ?? DEFAULT_MAX_GLOBAL_PER_WINDOW;
		this.maxPerIdPerWindow = limits.maxPerIdPerWindow ?? DEFAULT_MAX_PER_ID_PER_WINDOW;
		this.rateLimitWindowMs = limits.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
	}

	public globalLimited(): boolean {
		this.rollWindow();
		this.globalCount += 1;
		return this.globalCount > this.maxGlobalPerWindow;
	}

	public idLimited(id: string): boolean {
		const next = (this.perId.get(id) ?? 0) + 1;
		this.perId.set(id, next);
		return next > this.maxPerIdPerWindow;
	}

	private rollWindow(): void {
		const now = this.ambient.now();
		if (now - this.windowStartedAt >= this.rateLimitWindowMs) {
			this.windowStartedAt = now;
			this.globalCount = 0;
			this.perId.clear();
		}
	}
}
