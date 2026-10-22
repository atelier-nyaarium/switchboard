// Class required per action.

import { type Ambient, linkedSignal } from "../../shared/ambient.js";
import {
	type AnswerOf,
	ASSISTANT_ACTIONS,
	type AssistantActionKey,
	type ParamsOf,
} from "../../shared/schemasAssistantActions.js";
import { type LaneEnd, laneEnd } from "./sourceLane.js";

export interface ActionContext {
	/** The lane's; ends at the deadline or on stop. */
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

const NOTES: Record<LaneEnd, string> = {
	past_deadline: "out of time; send the rest again",
	stopping: "the assistant is stopping",
};

/** Why nothing more may start, as a note. */
export function stoppedBy(ctx: ActionContext): string | null {
	if (!ctx.signal.aborted) return null;
	return NOTES[laneEnd(ctx.signal) ?? "stopping"];
}

/** One request, cut at `maxMs` or when the lane ends the action. */
export async function bounded<T>(
	ctx: ActionContext,
	maxMs: number,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const request = linkedSignal(ctx.ambient, { parent: ctx.signal, ms: maxMs });
	try {
		return await work(request.signal);
	} finally {
		request.dispose();
	}
}
