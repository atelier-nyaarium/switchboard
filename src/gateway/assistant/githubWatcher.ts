// GitHub notifications, read-only. The cursor is `Last-Modified`; a 304 is free.

import { z } from "zod";
import { MAX_POLL_EVENTS, type PollAnswer, type Watcher, type WatcherEvent } from "./watcher.js";

export const GITHUB_WATCHER_ID = "github";

const API = "https://api.github.com";
const PAGE_SIZE = 50;
const MAX_PAGES = MAX_POLL_EVENTS / PAGE_SIZE;
/** Also GitHub's default `X-Poll-Interval`. */
const FLOOR_MS = 60_000;
const MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/** What the token read answered. */
export type TokenRead =
	| { kind: "token"; value: string }
	| { kind: "stopped"; reason: string }
	| { kind: "backoff"; reason: string };

export interface GithubWatcherDeps {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	/** Through the watcher's own vault grant, each poll. */
	token: () => Promise<TokenRead>;
	now: () => number;
}

const ThreadSchema = z.object({
	id: z.string().min(1),
	updated_at: z.string(),
	reason: z.string(),
	subject: z.object({ title: z.string(), type: z.string(), url: z.string().nullable() }),
	repository: z.object({ full_name: z.string(), html_url: z.string() }),
});

type Thread = z.infer<typeof ThreadSchema>;

const cut = (text: string, max: number) => text.slice(0, max);

/** Thread web URL. */
function pageOf(thread: Thread): string {
	const repo = thread.repository.html_url;
	const path = thread.subject.url?.match(/\/repos\/[^/]+\/[^/]+\/(pulls|issues|commits)\/([^/?#]+)$/);
	if (!path) return repo;
	const kind = path[1] === "pulls" ? "pull" : path[1] === "commits" ? "commit" : "issues";
	return `${repo}/${kind}/${path[2]}`;
}

function eventOf(thread: Thread): WatcherEvent {
	const at = Date.parse(thread.updated_at);
	return {
		// An update to the thread is a new event, not a replay.
		sourceId: cut(`${thread.id}@${thread.updated_at}`, 256),
		at: Number.isFinite(at) && at > 0 ? at : 0,
		title: cut(thread.subject.title, 1_000),
		fields: {
			reason: cut(thread.reason, 1_000),
			repository: cut(thread.repository.full_name, 1_000),
			type: cut(thread.subject.type, 1_000),
			title: cut(thread.subject.title, 1_000),
		},
		url: cut(pageOf(thread), 2_000),
	};
}

function eventsOf(body: unknown): WatcherEvent[] {
	if (!Array.isArray(body)) throw new Error("GitHub answered something other than a list");
	return body.flatMap((raw) => {
		const thread = ThreadSchema.safeParse(raw);
		return thread.success ? [eventOf(thread.data)] : [];
	});
}

/** Only GitHub's own API, so the token never follows a link elsewhere. */
function nextPage(link: string | null): string | null {
	const next = link?.split(",").find((part) => /;\s*rel="next"/.test(part));
	const url = next?.match(/<([^>]+)>/)?.[1];
	return url?.startsWith(`${API}/`) ? url : null;
}

function intervalOf(response: Response): number {
	const seconds = Number(response.headers.get("x-poll-interval"));
	return Number.isFinite(seconds) && seconds > 0
		? Math.min(MAX_WAIT_MS, Math.max(FLOOR_MS, seconds * 1000))
		: FLOOR_MS;
}

/** A secondary limit with no wait named. */
const SECONDARY_WAIT_MS = 5 * 60_000;
const SCOPE = "the token needs the notifications scope";

const wait = (ms: number) => Math.min(MAX_WAIT_MS, Math.max(FLOOR_MS, Math.ceil(ms)));

/** A refusal GitHub explains: a bad token or scope stops, a rate limit waits it out. */
async function refusalOf(response: Response, now: number): Promise<PollAnswer | null> {
	if (response.status === 401) return { kind: "stopped", reason: "GitHub refused the token" };
	// GitHub hides what a token may not see.
	if (response.status === 404) return { kind: "stopped", reason: `GitHub hid the notifications; ${SCOPE}` };
	if (response.status !== 403 && response.status !== 429) return null;
	const retryAfter = Number(response.headers.get("retry-after"));
	if (Number.isFinite(retryAfter) && retryAfter > 0) {
		return { kind: "backoff", retryMs: wait(retryAfter * 1000), reason: "GitHub rate limit" };
	}
	const reset = Number(response.headers.get("x-ratelimit-reset"));
	if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset)) {
		return { kind: "backoff", retryMs: wait(reset * 1000 - now), reason: "GitHub rate limit" };
	}
	const body = response.status === 403 ? await response.text().catch(() => "") : "";
	if (response.status === 429 || /rate limit/i.test(body)) {
		return { kind: "backoff", retryMs: SECONDARY_WAIT_MS, reason: "GitHub secondary rate limit" };
	}
	return { kind: "stopped", reason: `GitHub refused access to notifications; ${SCOPE}` };
}

export function createGithubWatcher(deps: GithubWatcherDeps): Watcher {
	return {
		id: GITHUB_WATCHER_ID,
		fields: ["reason", "repository", "type", "title"],
		// Feeds default to quiet.
		pingDefault: false,
		async poll(cursor, signal) {
			const token = await deps.token();
			signal.throwIfAborted();
			if (token.kind === "stopped") return { kind: "stopped", reason: token.reason };
			if (token.kind === "backoff") return { kind: "backoff", retryMs: FLOOR_MS, reason: token.reason };
			const headers = (since: string | null): Record<string, string> => ({
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token.value}`,
				"User-Agent": "switchboard-assistant",
				"X-GitHub-Api-Version": "2022-11-28",
				...(since ? { "If-Modified-Since": since } : {}),
			});
			const events: WatcherEvent[] = [];
			let url: string | null = `${API}/notifications?per_page=${PAGE_SIZE}`;
			let nextCursor = cursor;
			let nextPollMs = FLOOR_MS;
			for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
				// Only the first page asks whether anything changed.
				const response = await deps.fetch(url, { headers: headers(page === 0 ? cursor : null), signal });
				if (page === 0) {
					nextPollMs = intervalOf(response);
					if (response.status === 304) return { kind: "events", events: [], cursor, nextPollMs };
					nextCursor = response.headers.get("last-modified") ?? cursor;
				}
				const refusal = await refusalOf(response, deps.now());
				if (refusal) return refusal;
				if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
				events.push(...eventsOf(await response.json()));
				url = nextPage(response.headers.get("link"));
			}
			return { kind: "events", events: events.slice(0, MAX_POLL_EVENTS), cursor: nextCursor, nextPollMs };
		},
	};
}
