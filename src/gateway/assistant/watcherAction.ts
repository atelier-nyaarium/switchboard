// Class required per action.

import type { Ambient } from "../../shared/ambient.js";
import {
	type AnswerOf,
	ASSISTANT_ACTIONS,
	type AssistantActionKey,
	type ParamsOf,
} from "../../shared/schemasAssistantActions.js";

/** Action stop reasons. */
export const PAST_DEADLINE = "out of time; send the rest again";
export const STOPPING = "the assistant is stopping";

export interface ActionContext {
	/** Deadline or shutdown reason. */
	signal: AbortSignal;
	ambient: Pick<Ambient, "setTimer" | "clearTimer">;
}

export abstract class WatcherAction<K extends AssistantActionKey> {
	abstract readonly key: K;

	get declaration(): (typeof ASSISTANT_ACTIONS)[K] {
		return ASSISTANT_ACTIONS[this.key];
	}

	/** Lane held until settlement. */
	abstract run(params: ParamsOf<K>, ctx: ActionContext): Promise<AnswerOf<K>>;
}

export type WatcherActions = { [K in AssistantActionKey]: WatcherAction<K> };

export function stoppedBy(ctx: ActionContext): string | null {
	if (!ctx.signal.aborted) return null;
	return typeof ctx.signal.reason === "string" ? ctx.signal.reason : STOPPING;
}

/** Timeout and action abort bound work. */
export async function bounded<T>(
	ctx: ActionContext,
	maxMs: number,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const own = new AbortController();
	const forward = () => own.abort();
	if (ctx.signal.aborted) own.abort();
	ctx.signal.addEventListener("abort", forward, { once: true });
	const timer = ctx.ambient.setTimer(() => own.abort(), maxMs);
	try {
		return await work(own.signal);
	} finally {
		ctx.ambient.clearTimer(timer);
		ctx.signal.removeEventListener("abort", forward);
	}
}
