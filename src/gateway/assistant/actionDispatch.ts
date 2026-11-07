import type { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import { createOpDedupe } from "../../shared/op-dedupe.js";
import {
	type AssistantActionKey,
	type AssistantActionRequest,
	type AssistantActionResult,
	type ParamsOf,
	watcherParamsSchema,
} from "../../shared/schemasAssistantActions.js";
import type { RecordThread } from "../../shared/schemasAssistantRecord.js";
import type { SourceLanes } from "./sourceLane.js";
import { ASSISTANT_WAITS, CALL_HOLD_MS } from "./waits.js";
import type { WatcherActions } from "./watcherAction.js";

export interface ActionRecord {
	notify: boolean;
	body?: string;
	threads: RecordThread[];
}

export interface ActionDispatchDeps {
	actions: WatcherActions;
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	write: SourceLanes["write"];
	recount: SourceLanes["recount"];
	record: (callId: string, record: ActionRecord) => boolean;
	/** Held in the lane, so no poll overwrites it. */
	hideNotFound: (watcherId: string, ids: string[]) => void;
}

/** Retries join by call id. */
export function createActionDispatch(
	deps: ActionDispatchDeps,
): (request: AssistantActionRequest) => Promise<AssistantActionResult> {
	const calls = createOpDedupe<AssistantActionResult>({ now: () => deps.ambient.now(), holdMs: CALL_HOLD_MS });

	const runOne = async <K extends AssistantActionKey>(
		key: K,
		raw: unknown,
		callId: string,
	): Promise<AssistantActionResult> => {
		const action = deps.actions[key];
		const { declaration } = action;
		const parsed = watcherParamsSchema(key).safeParse(raw);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			return { kind: "refused", reason: `${issue?.path.join(".") || "params"}: ${issue?.message}`.slice(0, 400) };
		}
		const params = parsed.data as ParamsOf<K>;
		let answer: z.infer<typeof declaration.answer>;
		try {
			const ran = await deps.write(declaration.watcherId, ASSISTANT_WAITS.action, async (signal) => {
				const value = await action.run(params, { signal, ambient: deps.ambient });
				const gone = value.threads.filter((thread) => thread.outcome === "not_found");
				deps.hideNotFound(
					declaration.watcherId,
					gone.map((thread) => thread.threadId),
				);
				return value;
			});
			if (ran.kind === "not_started") {
				const why = ran.end === "stopping" ? "the assistant is stopping" : "the watcher stayed busy";
				return { kind: "refused", reason: `${why}; nothing was sent` };
			}
			answer = declaration.answer.parse(ran.value);
		} catch (error) {
			return { kind: "refused", reason: (error as Error).message.slice(0, 400) };
		}
		// Record attempted actions only.
		const attempted = answer.threads.some((thread) => thread.outcome !== "not_attempted");
		if (attempted) deps.recount(declaration.watcherId);
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
