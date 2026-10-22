import { z } from "zod";
import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { createOpDedupe } from "../../shared/op-dedupe.js";
import type {
	AssistantActionKey,
	AssistantActionRequest,
	AssistantActionResult,
	ParamsOf,
} from "../../shared/schemasAssistantActions.js";
import type { RecordThread } from "../../shared/schemasAssistantRecord.js";
import { PAST_DEADLINE, STOPPING, type WatcherActions } from "./watcherAction.js";

/** Includes queue time. */
export const ACTION_WAIT_MS = 60_000;
/** Retry hold, milliseconds. */
const CALL_HOLD_MS = 10 * 60_000;

const LATE = Symbol("late");

export interface ActionRecord {
	notify: boolean;
	body?: string;
	threads: RecordThread[];
}

export interface ActionDispatchDeps {
	actions: WatcherActions;
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	/** Lane held through settlement. */
	act: <T>(watcherId: string, work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
	record: (callId: string, record: ActionRecord) => boolean;
}

/** Retries join by call id. */
export function createActionDispatch(
	deps: ActionDispatchDeps,
): (request: AssistantActionRequest) => Promise<AssistantActionResult> {
	const calls = createOpDedupe<AssistantActionResult>({ now: () => deps.ambient.now(), holdMs: CALL_HOLD_MS });

	/** Queue timeout aborts work; late starts do nothing. */
	const inLane = <T>(watcherId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | typeof LATE> => {
		const deadline = new AbortController();
		let started = false;
		let timer: TimerHandle | undefined;
		const late = new Promise<typeof LATE>((resolve) => {
			timer = deps.ambient.setTimer(() => {
				deadline.abort(PAST_DEADLINE);
				if (!started) resolve(LATE);
			}, ACTION_WAIT_MS);
		});
		const flight = deps.act(watcherId, async (laneSignal): Promise<T | typeof LATE> => {
			if (deadline.signal.aborted) return LATE;
			started = true;
			const stop = () => deadline.abort(STOPPING);
			if (laneSignal.aborted) stop();
			laneSignal.addEventListener("abort", stop, { once: true });
			try {
				return await work(deadline.signal);
			} finally {
				laneSignal.removeEventListener("abort", stop);
			}
		});
		// Late starts do nothing.
		flight.catch(() => undefined);
		return Promise.race([flight, late]).finally(() => {
			if (timer !== undefined) deps.ambient.clearTimer(timer);
		});
	};

	const runOne = async <K extends AssistantActionKey>(
		key: K,
		raw: unknown,
		callId: string,
	): Promise<AssistantActionResult> => {
		const action = deps.actions[key];
		const { declaration } = action;
		const parsed = z.strictObject(declaration.params).safeParse(raw);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			return { kind: "refused", reason: `${issue?.path.join(".") || "params"}: ${issue?.message}`.slice(0, 400) };
		}
		const params = parsed.data as ParamsOf<K>;
		let answer: z.infer<typeof declaration.answer>;
		try {
			const ran = await inLane(declaration.watcherId, (signal) =>
				action.run(params, { signal, ambient: deps.ambient }),
			);
			if (ran === LATE) return { kind: "refused", reason: "the watcher stayed busy; nothing was sent" };
			answer = declaration.answer.parse(ran);
		} catch (error) {
			return { kind: "refused", reason: (error as Error).message.slice(0, 400) };
		}
		// Record attempted actions only.
		const attempted = answer.threads.some((thread) => thread.outcome !== "not_attempted");
		const { summary } = parsed.data as { summary?: string };
		const recorded =
			attempted &&
			deps.record(callId, {
				notify: summary !== undefined,
				...(summary === undefined ? {} : { body: summary }),
				threads: answer.threads,
			});
		return { kind: "ran", answer, recorded };
	};

	return (request) => calls.once(request.callId, () => runOne(request.action, request.params, request.callId));
}
