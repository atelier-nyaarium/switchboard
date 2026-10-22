import { describe, expect, it } from "vitest";
import { createGithubClient, type TokenRead } from "../gateway/assistant/githubClient.js";
import { createGithubWatcher } from "../gateway/assistant/githubWatcher.js";
import { type ListQuery, PollAnswerSchema } from "../gateway/assistant/watcher.js";

const NOW = 1_800_000_000_000;

function thread(id: string, updatedAt: string, subjectUrl: string | null = null) {
	return {
		id,
		updated_at: updatedAt,
		reason: "review_requested",
		unread: true,
		subject: { title: `Thread ${id}`, type: "PullRequest", url: subjectUrl },
		repository: { full_name: "atelier/app", html_url: "https://github.com/atelier/app" },
	};
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** Ordered fake responses. */
function github(replies: Reply[], token: TokenRead = { kind: "token", value: "ghp_test", key: "entry-a" }) {
	const asked: { url: string; headers: Record<string, string> }[] = [];
	let current = token;
	const watcher = createGithubWatcher(
		createGithubClient({
			now: () => NOW,
			token: async () => current,
			fetch: async (url, init) => {
				asked.push({ url, headers: init.headers as Record<string, string> });
				const reply = replies.shift();
				if (!reply) throw new Error("no reply scripted");
				const body = reply.body === undefined ? null : JSON.stringify(reply.body);
				return new Response(body, { status: reply.status, headers: reply.headers });
			},
		}),
	);
	const poll = async (cursor: string | null) =>
		PollAnswerSchema.parse(await watcher.poll(cursor, new AbortController().signal));
	const list = async (query: ListQuery = { scope: "all" }) => {
		const page = await watcher.list?.(query, new AbortController().signal);
		if (!page) throw new Error("no listing");
		return page;
	};
	const use = (next: TokenRead) => {
		current = next;
	};
	return { poll, list, use, asked };
}

const NEWLINE = String.fromCharCode(10);

describe("the GitHub notifications watcher", () => {
	it("reads each unread thread by its id and update time, with the page a person opens", async () => {
		const { poll, asked } = github([
			{
				status: 200,
				body: [
					thread("1", "2026-10-18T10:00:00Z", "https://api.github.com/repos/atelier/app/pulls/7"),
					thread("2", "2026-10-18T09:00:00Z"),
					{ id: "malformed" },
				],
				headers: { "last-modified": "Sun, 18 Oct 2026 10:00:00 GMT", "x-poll-interval": "120" },
			},
		]);

		const answer = await poll(null);

		expect(answer).toMatchObject({ kind: "events", capped: false, nextPollMs: 120_000 });
		if (answer.kind !== "events") throw new Error("expected events");
		expect(answer.events.map((event) => [event.id, event.at, event.url])).toEqual([
			["1", Date.parse("2026-10-18T10:00:00Z"), "https://github.com/atelier/app/pull/7"],
			["2", Date.parse("2026-10-18T09:00:00Z"), "https://github.com/atelier/app"],
		]);
		expect(answer.events[0]?.fields).toMatchObject({ reason: "review_requested", repository: "atelier/app" });
		expect(asked[0]?.headers.Authorization).toBe("Bearer ghp_test");
		expect(asked[0]?.headers["If-Modified-Since"]).toBeUndefined();
	});

	it("sends the validator back only under the grant that read it, and a 304 answers unchanged", async () => {
		const { poll, use, asked } = github([
			{ status: 200, body: [], headers: { "last-modified": "Sun, 18 Oct 2026 10:00:00 GMT" } },
			{ status: 304, headers: { "x-poll-interval": "30" } },
			{ status: 200, body: [] },
		]);

		const first = await poll(null);
		const cursor = first.kind === "events" ? first.cursor : null;
		const quiet = await poll(cursor);
		use({ kind: "token", value: "ghp_other", key: "entry-b" });
		await poll(cursor);

		expect(quiet).toEqual({ kind: "unchanged", nextPollMs: 60_000 });
		expect(asked.map((request) => request.headers["If-Modified-Since"])).toEqual([
			undefined,
			"Sun, 18 Oct 2026 10:00:00 GMT",
			undefined,
		]);
	});

	it("follows the next page on GitHub's API only, keeping one copy of a thread a shifted page repeats", async () => {
		const { poll, asked } = github([
			{
				status: 200,
				body: [thread("1", "2026-10-18T10:00:00Z")],
				headers: { link: '<https://api.github.com/notifications?page=2>; rel="next"' },
			},
			{
				status: 200,
				body: [thread("1", "2026-10-18T10:00:00Z"), thread("2", "2026-10-18T09:00:00Z")],
				headers: { link: '<https://evil.example/notifications?page=3>; rel="next"' },
			},
		]);

		const answer = await poll(null);

		expect(answer).toMatchObject({ kind: "events", capped: false });
		expect(answer.kind === "events" ? answer.events.map((event) => event.id) : []).toEqual(["1", "2"]);
		expect(asked.map((request) => request.url)).toEqual([
			"https://api.github.com/notifications?per_page=50",
			"https://api.github.com/notifications?page=2",
		]);
	});

	it("stops paging at the poll's event cap and says more are unread", async () => {
		const page = (n: number): Reply => ({
			status: 200,
			body: Array.from({ length: 50 }, (_, i) => thread(`${n * 100 + i}`, "2026-10-18T10:00:00Z")),
			headers: { link: `<https://api.github.com/notifications?page=${n + 1}>; rel="next"` },
		});
		const { poll, asked } = github(Array.from({ length: 11 }, (_, n) => page(n)));

		const answer = await poll(null);

		expect(answer.kind === "events" ? answer.events : []).toHaveLength(500);
		expect(answer).toMatchObject({ capped: true });
		expect(asked).toHaveLength(10);
	});

	it("lists the unread threads a page at a time, since GitHub lists done ones under all=true", async () => {
		const { list, asked } = github([
			{
				status: 200,
				body: [thread("9", "2026-10-18T10:00:00Z"), thread("8", "2026-10-18T09:00:00Z")],
				headers: { link: '<https://api.github.com/notifications?page=2>; rel="next"' },
			},
			{ status: 200, body: [thread("7", "2026-10-18T08:00:00Z")] },
		]);

		const first = await list();
		const second = await list({ scope: "all", page: first.next });

		expect([first.events, second.events].map((events) => events.map((event) => event.id))).toEqual([
			["9", "8"],
			["7"],
		]);
		expect(second.next).toBeUndefined();
		expect(first.mark ?? second.mark).toBeUndefined();
		expect(asked.map((request) => request.url)).toEqual([
			"https://api.github.com/notifications?per_page=50",
			"https://api.github.com/notifications?page=2",
		]);
		await expect(github([{ status: 401 }]).list()).rejects.toThrow();
		await expect(github([], { kind: "stopped", reason: "needs a secret" }).list()).rejects.toThrow();
	});

	it("reads new threads strictly after the mark, holds it across pages, and ends at the page that reaches it", async () => {
		const mark = Date.parse("2026-10-18T09:00:00Z");
		const { list, asked } = github([
			{
				status: 200,
				body: [thread("3", "2026-10-18T11:00:00Z"), thread("2", "2026-10-18T10:00:00Z")],
				headers: { link: '<https://api.github.com/notifications?since=x&page=2>; rel="next"' },
			},
			// GitHub keeps a thread at exactly the mark, and links on past it.
			{
				status: 200,
				body: [thread("1", "2026-10-18T09:30:00Z"), thread("0", "2026-10-18T09:00:00Z")],
				headers: { link: '<https://api.github.com/notifications?since=x&page=3>; rel="next"' },
			},
		]);

		const first = await list({ scope: "new", since: mark });
		const last = await list({ scope: "new", since: Date.parse("2026-10-18T10:30:00Z"), page: first.next });

		expect(asked[0]?.url).toBe("https://api.github.com/notifications?per_page=50&since=2026-10-18T09:00:00Z");
		expect(first.mark).toBeUndefined();
		expect(last.events.map((event) => event.id)).toEqual(["1"]);
		expect(last.next).toBeUndefined();
		expect(last.mark).toBe(Date.parse("2026-10-18T11:00:00Z"));
	});

	it("reads the same page again from its own token, holding that read's since and mark", async () => {
		const page = { status: 200, body: [thread("3", "2026-10-18T11:00:00Z"), thread("2", "2026-10-18T10:00:00Z")] };
		const { list, asked } = github([page, page]);

		const first = await list({ scope: "new", since: Date.parse("2026-10-18T09:00:00Z") });
		const again = await list({ scope: "new", since: Date.parse("2026-10-18T10:30:00Z"), page: first.here });

		expect(asked[1]?.url).toBe(asked[0]?.url);
		expect(again.events.map((event) => event.id)).toEqual(["3", "2"]);
		expect(again.mark).toBe(first.mark);
	});

	it("refuses a page from another grant, another scope, or anywhere but the notification list", async () => {
		const linked = (url: string): Reply => ({ status: 200, body: [], headers: { link: `<${url}>; rel="next"` } });
		const { list, use, asked } = github([linked("https://api.github.com/notifications?page=2")]);
		const first = await list();
		const forged = JSON.stringify(["entry-a", "all", "https://api.github.com/user/repos?page=2", null, 0]);

		await expect(list({ scope: "new", page: first.next })).rejects.toThrow();
		await expect(list({ scope: "all", page: forged })).rejects.toThrow();
		use({ kind: "token", value: "ghp_other", key: "entry-b" });
		await expect(list({ scope: "all", page: first.next })).rejects.toThrow();
		expect(asked).toHaveLength(1);
	});

	it("links only from a validated repository and subject, and drops a thread with a malformed id", async () => {
		const at = "2026-10-18T10:00:00Z";
		const repo = (full_name: string) => ({ repository: { full_name } });
		const { list } = github([
			{
				status: 200,
				body: [
					thread("1", at, "https://api.github.com/repos/atelier/app/issues/12"),
					thread("2", at, "https://api.github.com/repos/atelier/app/commits/0123abc"),
					thread("3", at, "https://api.github.com/repos/other/app/pulls/5"),
					{ ...thread("4", at), ...repo("evil.example/../x") },
					{ ...thread("5", at, "https://api.github.com/repos/atelier/app/pulls/5x") },
					thread("6x", at),
				],
			},
		]);

		const links = (await list()).events.map((event) => [event.id, event.url]);

		expect(links).toEqual([
			["1", "https://github.com/atelier/app/issues/12"],
			["2", "https://github.com/atelier/app/commit/0123abc"],
			["3", "https://github.com/atelier/app"],
			["4", undefined],
			["5", "https://github.com/atelier/app"],
		]);
	});

	it("stops on a refused token, and waits out a rate limit", async () => {
		const refused = await github([{ status: 401 }]).poll("c");
		const scoped = await github([{ status: 403 }]).poll("c");
		const limited = await github([
			{
				status: 403,
				headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 15 * 60_000) / 1000) },
			},
		]).poll("c");
		const throttled = github([{ status: 429, headers: { "retry-after": "90" } }]);
		const retry = await throttled.poll("c");
		const again = await throttled.poll("c");
		const listedWhileLimited = throttled.list();
		const secondary = await github([
			{ status: 403, body: { message: "You have exceeded a secondary rate limit." } },
		]).poll("c");
		const hidden = await github([{ status: 404 }]).poll("c");

		expect(refused.kind).toBe("stopped");
		expect(scoped.kind).toBe("stopped");
		expect(limited).toMatchObject({ kind: "backoff", retryMs: 15 * 60_000 });
		expect(retry).toMatchObject({ kind: "backoff", retryMs: 90_000 });
		// The limit holds for polls and listings alike.
		expect(again.kind).toBe("backoff");
		await expect(listedWhileLimited).rejects.toThrow();
		expect(throttled.asked).toHaveLength(1);
		expect(secondary.kind).toBe("backoff");
		expect(hidden.kind).toBe("stopped");
	});

	it("asks GitHub nothing without a token it may read, and never with one a header cannot carry", async () => {
		const missing = github([], { kind: "stopped", reason: "needs a secret" });
		const unreachable = github([], { kind: "backoff", reason: "vault unavailable" });
		const value = `ghp_a${NEWLINE}zq9tail`;
		const malformed = github([], { kind: "token", value, key: "entry-a" });
		const pasted = github([{ status: 200, body: [] }], {
			kind: "token",
			value: `ghp_ok${NEWLINE}`,
			key: "entry-a",
		});

		expect(await missing.poll(null)).toEqual({ kind: "stopped", reason: "needs a secret" });
		expect((await unreachable.poll(null)).kind).toBe("backoff");
		const refused = await malformed.poll(null);
		expect(refused.kind).toBe("stopped");
		expect(JSON.stringify(refused)).not.toContain("zq9tail");
		await expect(malformed.list()).rejects.toThrow();
		expect([...missing.asked, ...unreachable.asked, ...malformed.asked]).toEqual([]);
		await pasted.poll(null);
		expect(pasted.asked[0]?.headers.Authorization).toBe("Bearer ghp_ok");
	});
});
