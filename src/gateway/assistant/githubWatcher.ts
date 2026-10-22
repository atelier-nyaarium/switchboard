// GitHub notifications. The cursor is `Last-Modified`.

import { z } from "zod";
import { GITHUB_WATCHER_ID } from "../../shared/schemasAssistantActions.js";
import {
	GITHUB_API,
	GITHUB_FLOOR_MS,
	GITHUB_MAX_WAIT_MS,
	type GithubClient,
	HIDDEN,
	isRefusal,
} from "./githubClient.js";
import { type ListQuery, MAX_POLL_EVENTS, type Watcher, type WatcherEvent } from "./watcher.js";

const NOTIFICATIONS = `${GITHUB_API}/notifications?`;
const PAGE_SIZE = 50;
const MAX_PAGES = MAX_POLL_EVENTS / PAGE_SIZE;

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
	`${NOTIFICATIONS}per_page=${PAGE_SIZE}${since === undefined ? "" : `&since=${isoOf(since)}`}`;

/** Newest copy of each thread. */
function unique(events: WatcherEvent[]): WatcherEvent[] {
	const seen = new Set<string>();
	return events.filter((event) => !seen.has(event.id) && Boolean(seen.add(event.id)));
}

export const ThreadSchema = z.object({
	id: z.string().regex(/^\d{1,32}$/),
	updated_at: z.string(),
	reason: z.string(),
	subject: z.object({ title: z.string(), type: z.string(), url: z.string().nullable() }),
	repository: z.object({ full_name: z.string() }),
});

export type Thread = z.infer<typeof ThreadSchema>;

const cut = (text: string, max: number) => text.slice(0, max);

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SUBJECT_RE = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(pulls|issues|commits)\/([^/?#]+)$/;

/** Built from validated parts, or none. */
export function linkOf(thread: Thread): string | undefined {
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
	return url?.startsWith(`${GITHUB_API}/`) ? url : null;
}

function intervalOf(response: Response): number {
	const seconds = Number(response.headers.get("x-poll-interval"));
	return Number.isFinite(seconds) && seconds > 0
		? Math.min(GITHUB_MAX_WAIT_MS, Math.max(GITHUB_FLOOR_MS, seconds * 1000))
		: GITHUB_FLOOR_MS;
}

/** The notification endpoints take no fine-grained token. */
const GITHUB_SECRET = `
GitHub PAT (Classic) with scope:
- Notifications
`.trim();

export function createGithubWatcher(client: GithubClient): Watcher {
	return {
		id: GITHUB_WATCHER_ID,
		fields: ["reason", "repository", "type", "title"],
		secret: GITHUB_SECRET,
		async poll(cursor, signal) {
			const token = await client.token(signal);
			if (isRefusal(token)) return token;
			const events: WatcherEvent[] = [];
			let url: string | null = `${GITHUB_API}/notifications?per_page=${PAGE_SIZE}`;
			let validator = validatorOf(cursor, token.key);
			let nextPollMs = GITHUB_FLOOR_MS;
			for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
				// Only the first page asks whether anything changed.
				const since = page === 0 ? validator : null;
				const response = await client.request(token, url, { since }, signal);
				if (isRefusal(response)) return response;
				if (page === 0) {
					nextPollMs = intervalOf(response);
					if (response.status === 304) return { kind: "unchanged", nextPollMs };
					validator = response.headers.get("last-modified") ?? validator;
				}
				if (response.status === 404) return HIDDEN;
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
			const token = await client.token(signal);
			if (isRefusal(token)) throw new Error(token.reason);
			const held = query.page === undefined ? null : readPage(query.page, token.key, query.scope);
			if (query.page !== undefined && !held) throw new Error("stale page; list again");
			const since = held ? held.since : query.scope === "new" ? query.since : undefined;
			const url = held?.url ?? firstPageOf(since);
			const response = await client.request(token, url, {}, signal);
			if (isRefusal(response)) throw new Error(response.reason);
			if (response.status === 404) throw new Error(HIDDEN.reason);
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
