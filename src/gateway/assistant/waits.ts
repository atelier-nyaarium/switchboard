/** What a caller of an assistant road waits; `assistant-waits.test.ts` pins their order. */
export const ASSISTANT_WAITS = {
	/** Counts the queue. */
	action: 60_000,
	/** One GitHub request inside an action. */
	request: 15_000,
	list: 25_000,
	/** A console op, inside the phone's answer wait. */
	preview: 25_000,
} as const;
