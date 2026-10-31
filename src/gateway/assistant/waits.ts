/** Order pinned by `gateway-serve-limits.test.ts`. */
export const ASSISTANT_WAITS = {
	/** Counts the queue. */
	action: 60_000,
	/** One GitHub request inside an action. */
	request: 15_000,
	list: 25_000,
	/** Inside `CONSOLE_ANSWER_WAIT_MS`. */
	preview: 25_000,
	phone: 120_000,
} as const;
