import { describe, expect, it } from "vitest";
import { createGithubWatcher, type TokenRead } from "../gateway/assistant/githubWatcher.js";
import { PollAnswerSchema } from "../gateway/assistant/watcher.js";

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
function github(replies: Reply[], token: TokenRead = { kind: "token", value: "ghp_test" }) {
	const asked: { url: string; headers: Record<string, string> }[] = [];
	const watcher = createGithubWatcher({
		now: () => NOW,
		token: async () => token,
		fetch: async (url, init) => {
			asked.push({ url, headers: init.headers as Record<string, string> });
			const reply = replies.shift();
			if (!reply) throw new Error("no reply scripted");
			const body = reply.body === undefined ? null : JSON.stringify(reply.body);
			return new Response(body, { status: reply.status, headers: reply.headers });
		},
	});
	const poll = async (cursor: string | null) =>
		PollAnswerSchema.parse(await watcher.poll(cursor, new AbortController().signal));
	return { poll, asked };
}

describe("the GitHub notifications watcher", () => {
	it("reads each thread update as its own event, with the page a person opens", async () => {
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

		expect(answer).toMatchObject({ kind: "events", cursor: "Sun, 18 Oct 2026 10:00:00 GMT", nextPollMs: 120_000 });
		if (answer.kind !== "events") throw new Error("expected events");
		expect(answer.events.map((event) => [event.sourceId, event.url])).toEqual([
			["1@2026-10-18T10:00:00Z", "https://github.com/atelier/app/pull/7"],
			["2@2026-10-18T09:00:00Z", "https://github.com/atelier/app"],
		]);
		expect(answer.events[0]?.fields).toMatchObject({ reason: "review_requested", repository: "atelier/app" });
		expect(asked[0]?.headers.Authorization).toBe("Bearer ghp_test");
		expect(asked[0]?.headers["If-Modified-Since"]).toBeUndefined();
	});

	it("asks whether anything changed since the cursor, and a 304 keeps it", async () => {
		const { poll, asked } = github([{ status: 304, headers: { "x-poll-interval": "30" } }]);

		const answer = await poll("Sun, 18 Oct 2026 10:00:00 GMT");

		expect(answer).toEqual({
			kind: "events",
			events: [],
			cursor: "Sun, 18 Oct 2026 10:00:00 GMT",
			nextPollMs: 60_000,
		});
		expect(asked[0]?.headers["If-Modified-Since"]).toBe("Sun, 18 Oct 2026 10:00:00 GMT");
	});

	it("follows the next page on GitHub's API only", async () => {
		const { poll, asked } = github([
			{
				status: 200,
				body: [thread("1", "2026-10-18T10:00:00Z")],
				headers: { link: '<https://api.github.com/notifications?page=2>; rel="next"' },
			},
			{
				status: 200,
				body: [thread("2", "2026-10-18T09:00:00Z")],
				headers: { link: '<https://evil.example/notifications?page=3>; rel="next"' },
			},
		]);

		const answer = await poll(null);

		expect(answer.kind === "events" ? answer.events.map((event) => event.sourceId) : []).toHaveLength(2);
		expect(asked.map((request) => request.url)).toEqual([
			"https://api.github.com/notifications?per_page=50",
			"https://api.github.com/notifications?page=2",
		]);
	});

	it("stops paging at the poll's event cap", async () => {
		const page = (n: number): Reply => ({
			status: 200,
			body: Array.from({ length: 50 }, (_, i) => thread(`${n}-${i}`, "2026-10-18T10:00:00Z")),
			headers: { link: `<https://api.github.com/notifications?page=${n + 1}>; rel="next"` },
		});
		const { poll, asked } = github(Array.from({ length: 11 }, (_, n) => page(n)));

		const answer = await poll(null);

		expect(answer.kind === "events" ? answer.events : []).toHaveLength(500);
		expect(asked).toHaveLength(10);
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
		const retry = await github([{ status: 429, headers: { "retry-after": "90" } }]).poll("c");
		const secondary = await github([
			{ status: 403, body: { message: "You have exceeded a secondary rate limit." } },
		]).poll("c");
		const hidden = await github([{ status: 404 }]).poll("c");

		expect(refused.kind).toBe("stopped");
		expect(scoped.kind).toBe("stopped");
		expect(limited).toMatchObject({ kind: "backoff", retryMs: 15 * 60_000 });
		expect(retry).toMatchObject({ kind: "backoff", retryMs: 90_000 });
		expect(secondary.kind).toBe("backoff");
		expect(hidden.kind).toBe("stopped");
	});

	it("asks GitHub nothing without a token it may read", async () => {
		const missing = github([], { kind: "stopped", reason: "needs a secret" });
		const unreachable = github([], { kind: "backoff", reason: "vault unavailable" });

		expect(await missing.poll(null)).toEqual({ kind: "stopped", reason: "needs a secret" });
		expect((await unreachable.poll(null)).kind).toBe("backoff");
		expect([...missing.asked, ...unreachable.asked]).toEqual([]);
	});
});
