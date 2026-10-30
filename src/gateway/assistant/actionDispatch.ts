import { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import { createOpDedupe } from "../../shared/op-dedupe.js";
import type {
	AssistantActionKey,
	AssistantActionRequest,
	AssistantActionResult,
	ParamsOf,
} from "../../shared/schemasAssistantActions.js";
import type { RecordThread } from "../../shared/schemasAssistantRecord.js";
import type { SourceLanes } from "./sourceLane.js";
import { ASSISTANT_WAITS } from "./waits.js";
import type { WatcherActions } from "./watcherAction.js";

/** Retry hold, milliseconds. */
const CALL_HOLD_MS = 10 * 60_000;

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
		const parsed = z.strictObject(declaration.params).safeParse(raw);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			return { kind: "refused", reason: `${issue?.path.join(".") || "params"}: ${issue?.message}`.slice(0, 400) };
		}
		const params = parsed.data as ParamsOf<K>;
		let answer: z.infer<typeof declaration.answer>;
		try {
			const ran = await deps.write(declaration.watcherId, ASSISTANT_WAITS.action, (signal) =>
				action.run(params, { signal, ambient: deps.ambient }),
			);
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
