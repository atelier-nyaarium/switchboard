// Which home choice this Gateway acts on, and the retries that carry it out. The effects are the stage's.

import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import type { AssistantHomeRecord } from "../../shared/schemasAssistantHome.js";
import { fireAndForget } from "../fireAndForget.js";
import type { HomeMark, HomeMarkStore } from "./homeMark.js";

/** A let-go whose forget was refused tries again after this. */
export const LET_GO_RETRY_MS = 30_000;
export const REPORT_RETRY_MS = 10_000;

export type HomeReportAnswer = "accepted" | "dropped" | "retry";

export interface HomeFollowEffects {
	stopLanes: () => Promise<void>;
	startLanes: () => void;
	/** Lands a choice naming this Gateway: null placed it, a string is why not. */
	apply: (record: AssistantHomeRecord) => Promise<string | null>;
	/** True once nothing of the assistant is left here. */
	letGo: () => Promise<boolean>;
	/** `retry` when the Router did not take it; `dropped` when it never will. */
	report: (mark: { version: number; outcome: "placed" | "refused"; reason?: string }) => Promise<HomeReportAnswer>;
}

export interface HomeFollowDeps {
	mark: HomeMarkStore;
	localGatewayId: string;
	/** The stage's one queue, shared with owner edits. */
	serial: <T>(work: () => T | Promise<T>) => Promise<T>;
	ambient: Pick<Ambient, "setTimer" | "clearTimer">;
	effects: HomeFollowEffects;
}

export function createHomeFollow(deps: HomeFollowDeps) {
	const { mark: home, ambient, effects } = deps;
	let stopped = false;
	let letGoRetry: TimerHandle | null = null;
	let reportRetry: TimerHandle | null = null;

	const report = (mark: HomeMark | null) => {
		if (!mark?.named || mark.applied === null || stopped) return;
		if (reportRetry) ambient.clearTimer(reportRetry);
		reportRetry = null;
		const { version, applied: outcome, reason } = mark;
		const sent = effects.report({ version, outcome, ...(reason ? { reason } : {}) }).then((answer) => {
			// Refused while migrating, or lost.
			if (answer !== "retry" || home.get()?.version !== version || stopped) return;
			reportRetry = ambient.setTimer(() => {
				reportRetry = null;
				report(home.get());
			}, REPORT_RETRY_MS);
		});
		fireAndForget("assistant home report", sent);
	};

	const letGoUntilDone = async (): Promise<void> => {
		if (letGoRetry) ambient.clearTimer(letGoRetry);
		letGoRetry = null;
		if ((await effects.letGo()) || stopped) return;
		letGoRetry = ambient.setTimer(() => {
			letGoRetry = null;
			if (home.letGo()) fireAndForget("assistant let-go", deps.serial(letGoUntilDone));
		}, LET_GO_RETRY_MS);
	};

	/** The mark lands before anything is awaited; a version at or below it is never applied again. */
	const follow = (record: AssistantHomeRecord | null, { registered }: { registered: boolean }) =>
		deps.serial(async () => {
			// Never written: the local record stays as it is.
			if (record === null) return;
			const mark = home.get();
			if (mark && record.version < mark.version) return;
			const named = record.gatewayId === deps.localGatewayId;
			if (mark?.version === record.version) {
				if (!mark.named) return letGoUntilDone();
				if (mark.applied !== null) {
					if (registered) report(mark);
					return;
				}
				// An unfinished apply reruns.
			} else if (!home.set({ version: record.version, named, applied: null })) {
				// Unsaved, it still stops acting.
				await effects.stopLanes();
				throw new Error("the home mark could not be saved");
			}
			if (!named) return letGoUntilDone();
			let refusal: string | null;
			try {
				refusal = await effects.apply(record);
			} catch (error) {
				refusal = (error as Error).message;
			}
			const applied: HomeMark = {
				version: record.version,
				named: true,
				applied: refusal === null ? "placed" : "refused",
				...(refusal === null ? {} : { reason: refusal.slice(0, 512) }),
			};
			if (!home.set(applied)) throw new Error("the home mark could not be saved");
			if (refusal === null) effects.startLanes();
			report(applied);
		});

	return {
		follow,
		/** Resumes a let-go a restart cut short. */
		start: () => {
			if (home.letGo()) fireAndForget("assistant let-go", deps.serial(letGoUntilDone));
		},
		/** Nothing re-arms after this. */
		stop: () => {
			stopped = true;
			if (letGoRetry) ambient.clearTimer(letGoRetry);
			if (reportRetry) ambient.clearTimer(reportRetry);
		},
	};
}
