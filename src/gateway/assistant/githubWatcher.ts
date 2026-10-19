// GitHub notifications. The cursor is `Last-Modified`.

import { z } from "zod";
import { type ListQuery, MAX_POLL_EVENTS, type PollAnswer, type Watcher, type WatcherEvent } from "./watcher.js";

export const GITHUB_WATCHER_ID = "github";

const API = "https://api.github.com";
const NOTIFICATIONS = `${API}/notifications?`;
const PAGE_SIZE = 50;
const MAX_PAGES = MAX_POLL_EVENTS / PAGE_SIZE;
/** Also GitHub's default `X-Poll-Interval`. */
const FLOOR_MS = 60_000;
const MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/** What the token read answered. */
export type TokenRead =
	/** `key` names the grant a validator belongs to. */
	| { kind: "token"; value: string; key: string }
	| { kind: "stopped"; reason: string }
	| { kind: "backoff"; reason: string };

/** Fetch echoes any other value in its error. */
const TOKEN_RE = /^[!-~]+$/;
const NOT_A_TOKEN = "the secret is not a GitHub token";

const CursorSchema = z.tuple([z.string(), z.string()]);

/** Read under this grant, or none. */
function validatorOf(cursor: string | null, key: string): string | null {
	if (cursor === null) return null;
	try {
		const [held, since] = CursorSchema.parse(JSON.parse(cursor));
		return held === key ? since : null;
	} catch {
		return null;
	}
}

const cursorOf = (key: string, since: string | null) => (since === null ? null : JSON.stringify([key, since]));

const PageSchema = z.tuple([
	z.string(),
	z.enum(["new", "all"]),
	z.string(),
	z.number().nullable(),
	z.number().nullable(),
]);

/** Bound to its grant, scope and GitHub's notification list. */
const pageTokenOf = (key: string, scope: ListQuery["scope"], url: string, since: number | undefined, mark: number) =>
	JSON.stringify([key, scope, url, since ?? null, mark]);

function readPage(token: string, key: string, scope: ListQuery["scope"]) {
	try {
		const [held, heldScope, url, since, mark] = PageSchema.parse(JSON.parse(token));
		if (held !== key || heldScope !== scope || !url.startsWith(NOTIFICATIONS)) return null;
		return { url, since: since ?? undefined, mark: mark ?? 0 };
	} catch {
		return null;
	}
}

/** Second resolution, as GitHub takes it. */
const isoOf = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");

const firstPageOf = (since: number | undefined) =>
	`${NOTIFICATIONS}all=true&per_page=${PAGE_SIZE}${since === undefined ? "" : `&since=${isoOf(since)}`}`;

/** Newest copy of each thread. */
function unique(events: WatcherEvent[]): WatcherEvent[] {
	const seen = new Set<string>();
	return events.filter((event) => !seen.has(event.id) && Boolean(seen.add(event.id)));
}

export interface GithubWatcherDeps {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	/** Through the watcher's own vault grant, each poll. */
	token: () => Promise<TokenRead>;
	now: () => number;
}

const ThreadSchema = z.object({
	id: z.string().regex(/^\d{1,32}$/),
	updated_at: z.string(),
	reason: z.string(),
	subject: z.object({ title: z.string(), type: z.string(), url: z.string().nullable() }),
	repository: z.object({ full_name: z.string() }),
});

type Thread = z.infer<typeof ThreadSchema>;

const cut = (text: string, max: number) => text.slice(0, max);

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SUBJECT_RE = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(pulls|issues|commits)\/([^/?#]+)$/;

/** Built from validated parts, or none. */
function linkOf(thread: Thread): string | undefined {
	const repo = thread.repository.full_name;
	if (!REPO_RE.test(repo)) return undefined;
	const [, owner, kind, ref] = thread.subject.url?.match(SUBJECT_RE) ?? [];
	const numbered = (kind === "pulls" || kind === "issues") && /^\d{1,12}$/.test(ref ?? "");
	const commit = kind === "commits" && /^[0-9a-f]{7,40}$/.test(ref ?? "");
	if (owner !== repo || !(numbered || commit)) return `https://github.com/${repo}`;
	return `https://github.com/${repo}/${kind === "pulls" ? "pull" : kind === "commits" ? "commit" : "issues"}/${ref}`;
}

function eventOf(thread: Thread): WatcherEvent {
	const at = Date.parse(thread.updated_at);
	const url = linkOf(thread);
	return {
		id: thread.id,
		at: Number.isFinite(at) && at > 0 ? at : 0,
		title: cut(thread.subject.title, 300),
		fields: {
			reason: cut(thread.reason, 64),
			repository: cut(thread.repository.full_name, 201),
			type: cut(thread.subject.type, 64),
			title: cut(thread.subject.title, 300),
		},
		...(url === undefined ? {} : { url }),
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
async function refusalOf(
	response: Response,
	now: number,
): Promise<Extract<PollAnswer, { kind: "stopped" | "backoff" }> | null> {
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

/** The notification endpoints take no fine-grained token. */
const GITHUB_SECRET = `
GitHub PAT (Classic) with scope:
- Notifications
`.trim();

const headersOf = (token: string, since: string | null): Record<string, string> => ({
	Accept: "application/vnd.github+json",
	Authorization: `Bearer ${token}`,
	"User-Agent": "switchboard-assistant",
	"X-GitHub-Api-Version": "2022-11-28",
	...(since ? { "If-Modified-Since": since } : {}),
});

export function createGithubWatcher(deps: GithubWatcherDeps): Watcher {
	/** Shared by polls and listings. */
	let limitedUntil = 0;
	const limited = (refusal: Extract<PollAnswer, { kind: "stopped" | "backoff" }>) => {
		if (refusal.kind === "backoff") limitedUntil = Math.max(limitedUntil, deps.now() + refusal.retryMs);
		return refusal;
	};
	/** A usable token, or why not. */
	const tokenOf = async (
		signal: AbortSignal,
	): Promise<{ value: string; key: string } | Extract<PollAnswer, { kind: "stopped" | "backoff" }>> => {
		const token = await deps.token();
		signal.throwIfAborted();
		if (token.kind === "stopped") return { kind: "stopped", reason: token.reason };
		if (token.kind === "backoff") return { kind: "backoff", retryMs: FLOOR_MS, reason: token.reason };
		const value = token.value.trim();
		if (!TOKEN_RE.test(value)) return { kind: "stopped", reason: NOT_A_TOKEN };
		const left = limitedUntil - deps.now();
		if (left > 0) return { kind: "backoff", retryMs: wait(left), reason: "GitHub rate limit" };
		return { value, key: token.key };
	};

	return {
		id: GITHUB_WATCHER_ID,
		fields: ["reason", "repository", "type", "title"],
		secret: GITHUB_SECRET,
		async poll(cursor, signal) {
			const token = await tokenOf(signal);
			if ("kind" in token) return token;
			const events: WatcherEvent[] = [];
			let url: string | null = `${API}/notifications?per_page=${PAGE_SIZE}`;
			let validator = validatorOf(cursor, token.key);
			let nextPollMs = FLOOR_MS;
			for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
				// Only the first page asks whether anything changed.
				const since = page === 0 ? validator : null;
				const response = await deps.fetch(url, { headers: headersOf(token.value, since), signal });
				if (page === 0) {
					nextPollMs = intervalOf(response);
					if (response.status === 304) return { kind: "unchanged", nextPollMs };
					validator = response.headers.get("last-modified") ?? validator;
				}
				const refusal = await refusalOf(response, deps.now());
				if (refusal) return limited(refusal);
				if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
				events.push(...eventsOf(await response.json()));
				url = nextPage(response.headers.get("link"));
			}
			const read = unique(events);
			return {
				kind: "events",
				events: read.slice(0, MAX_POLL_EVENTS),
				cursor: cursorOf(token.key, validator),
				capped: url !== null || read.length > MAX_POLL_EVENTS,
				nextPollMs,
			};
		},
		/** `new` holds its `since` and mark across pages; the mark lands with the last page. */
		async list(query, signal) {
			const token = await tokenOf(signal);
			if ("kind" in token) throw new Error(token.reason);
			const held = query.page === undefined ? null : readPage(query.page, token.key, query.scope);
			if (query.page !== undefined && !held) throw new Error("stale page; list again");
			const since = held ? held.since : query.scope === "new" ? query.since : undefined;
			const url = held?.url ?? firstPageOf(since);
			const response = await deps.fetch(url, { headers: headersOf(token.value, null), signal });
			const refusal = await refusalOf(response, deps.now());
			if (refusal) throw new Error(limited(refusal).reason);
			if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
			// GitHub's `since` filters loosely, so the mark is applied here.
			const read = unique(eventsOf(await response.json()));
			const events = read.filter((event) => since === undefined || event.at > since);
			const mark = held?.mark ?? events.reduce((max, event) => Math.max(max, event.at), since ?? 0);
			// Newest first: past the mark, older pages hold nothing new.
			const reachedMark = events.length < read.length;
			const next = reachedMark ? null : nextPage(response.headers.get("link"));
			const more = next?.startsWith(NOTIFICATIONS) ? next : null;
			return {
				events,
				here: pageTokenOf(token.key, query.scope, url, since, mark),
				...(more ? { next: pageTokenOf(token.key, query.scope, more, since, mark) } : {}),
				...(query.scope === "new" && !more ? { mark } : {}),
			};
		},
	};
}
