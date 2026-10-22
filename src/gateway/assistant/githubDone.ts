import type { ParamsOf } from "../../shared/schemasAssistantActions.js";
import type { RecordThread } from "../../shared/schemasAssistantRecord.js";
import {
	type GithubClient,
	type GithubHold,
	type GithubRefusal,
	type GithubToken,
	holdText,
	isRefusal,
} from "./githubClient.js";
import { linkOf, ThreadSchema } from "./githubWatcher.js";
import { ASSISTANT_WAITS } from "./waits.js";
import { type ActionContext, bounded, stoppedBy, WatcherAction } from "./watcherAction.js";

interface Step {
	thread: RecordThread;
	stop?: string;
	note?: string;
}

const TITLE_MAX = 300;

/** Only GitHub's limit is `rate_limited`. */
const refused = (thread: Omit<RecordThread, "outcome">, refusal: GithubRefusal | GithubHold): Step =>
	refusal.kind === "backoff"
		? { thread: { ...thread, outcome: "rate_limited" }, stop: holdText(refusal.retryMs) }
		: { thread: { ...thread, outcome: "not_attempted" }, stop: refusal.reason };

export class GithubDone extends WatcherAction<"github_done"> {
	readonly key = "github_done";

	constructor(private readonly client: GithubClient) {
		super();
	}

	async run(params: ParamsOf<"github_done">, ctx: ActionContext) {
		const unsent = (from: number): RecordThread[] =>
			params.ids.slice(from).map((threadId) => ({ threadId, outcome: "not_attempted" }));
		const before = stoppedBy(ctx);
		if (before) return { threads: unsent(0), note: before };
		const token = await this.client
			.token(ctx.signal)
			.catch((error: Error): GithubRefusal => ({ kind: "stopped", reason: error.message.slice(0, 400) }));
		if (isRefusal(token)) return { threads: unsent(0), note: stoppedBy(ctx) ?? token.reason };
		const threads: RecordThread[] = [];
		let note: string | undefined;
		for (const [index, threadId] of params.ids.entries()) {
			const wait = this.client.waitLeft();
			const halt = stoppedBy(ctx) ?? (wait > 0 ? holdText(wait) : null);
			if (halt) return { threads: [...threads, ...unsent(index)], note: halt };
			const step = await this.one(token, threadId, ctx);
			threads.push(step.thread);
			note ??= step.note;
			if (step.stop) return { threads: [...threads, ...unsent(index + 1)], note: step.stop.slice(0, 400) };
		}
		return { threads, ...(note === undefined ? {} : { note: note.slice(0, 400) }) };
	}

	private async one(token: GithubToken, threadId: string, ctx: ActionContext): Promise<Step> {
		const path = `/notifications/threads/${threadId}`;
		// GitHub supplies metadata.
		const read = await bounded(ctx, ASSISTANT_WAITS.request, async (signal) => {
			const response = await this.client.request(token, path, {}, signal);
			if (isRefusal(response)) return response;
			return { status: response.status, body: response.ok ? await response.json() : null };
		}).catch((error: Error) => ({ failed: error.message }));
		if ("failed" in read) {
			return { thread: { threadId, outcome: "not_attempted" }, note: `reading ${threadId}: ${read.failed}` };
		}
		if (isRefusal(read)) return refused({ threadId }, read);
		if (read.status === 404) return { thread: { threadId, outcome: "not_found" } };
		if (read.status !== 200) {
			return {
				thread: { threadId, outcome: "not_attempted" },
				note: `reading ${threadId}: GitHub answered ${read.status}`,
			};
		}
		const thread = ThreadSchema.safeParse(read.body);
		const url = thread.success && thread.data.id === threadId ? linkOf(thread.data) : undefined;
		const title =
			thread.success && thread.data.id === threadId ? thread.data.subject.title.slice(0, TITLE_MAX) : "";
		const known = { threadId, ...(title ? { title } : {}), ...(url === undefined ? {} : { url }) };

		const late = stoppedBy(ctx);
		if (late) return { thread: { ...known, outcome: "not_attempted" }, stop: late };
		const cleared = await bounded(ctx, ASSISTANT_WAITS.request, (signal) =>
			this.client.request(token, path, { method: "DELETE" }, signal),
		).catch(() => null);
		// Lost replies stay uncertain.
		if (cleared === null) return { thread: { ...known, outcome: "uncertain" } };
		if (isRefusal(cleared)) return refused(known, cleared);
		if (cleared.status === 404) return { thread: { ...known, outcome: "not_found" } };
		if (!cleared.ok) return { thread: { ...known, outcome: "uncertain" } };
		// Mark done before read.
		const marked = await bounded(ctx, ASSISTANT_WAITS.request, (signal) =>
			this.client.request(token, path, { method: "PATCH" }, signal),
		).catch((error: Error) => ({ failed: error.message }));
		const done = { ...known, outcome: "done" as const };
		// 304: already read.
		const nowRead = !("failed" in marked) && !isRefusal(marked) && (marked.ok || marked.status === 304);
		if (nowRead) return { thread: done };
		const unread = `${threadId} is done but still unread, so it stays in inbox; send it again`;
		if (isRefusal(marked)) {
			const why = marked.kind === "backoff" ? holdText(marked.retryMs) : marked.reason;
			return { thread: done, stop: `${unread}; ${why}` };
		}
		const why = "failed" in marked ? marked.failed : `GitHub answered ${marked.status}`;
		return { thread: done, note: `${unread}: ${why}` };
	}
}
