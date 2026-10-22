import { describe, expect, it } from "vitest";
import { createGithubClient, type TokenRead } from "../gateway/assistant/githubClient.js";
import { GithubDone } from "../gateway/assistant/githubDone.js";
import { createSourceLanes } from "../gateway/assistant/sourceLane.js";
import { FRESH_STATE } from "../gateway/assistant/watcherState.js";
import { type FakeAmbient, fakeAmbient } from "../testing/fakeAmbient.js";

const T0 = 1_800_000_000_000;
const TOKEN: TokenRead = { kind: "token", value: "ghp_test", key: "entry-a" };

const thread = (id: string) => ({
	id,
	updated_at: "2026-10-18T10:00:00Z",
	reason: "subscribed",
	unread: false,
	subject: {
		title: `Thread ${id}`,
		type: "PullRequest",
		url: `https://api.github.com/repos/atelier/app/pulls/${id}`,
	},
	repository: { full_name: "atelier/app" },
});

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "hang";

/** Ordered replies; hangs abort. */
function github(ambient: FakeAmbient, replies: Reply[], token: TokenRead = TOKEN) {
	const asked: string[] = [];
	const client = createGithubClient({
		now: () => ambient.now(),
		token: async () => token,
		fetch: async (url, init) => {
			asked.push(`${init.method ?? "GET"} ${url.replace("https://api.github.com", "")}`);
			const reply = replies.shift();
			if (!reply) throw new Error("no reply scripted");
			if (reply === "hang") {
				return new Promise((_, reject) =>
					init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
				);
			}
			const body = reply.body === undefined ? null : JSON.stringify(reply.body);
			return new Response(body, { status: reply.status, headers: reply.headers });
		},
	});
	const done = new GithubDone(client);
	// Through a real lane, so the deadline is the one the Gateway runs.
	const lane = createSourceLanes({
		ambient,
		state: { get: () => FRESH_STATE, put: () => true },
		watchers: [{ id: "github", poll: async () => ({ kind: "unchanged", nextPollMs: 60_000 }) }],
		sort: () => "wake",
		wake: () => null,
		to: "host.assistant",
		render: () => "",
	});
	const run = async (ids: string[], deadlineMs = 60_000) => {
		const answer = await lane.write("github", deadlineMs, (signal) => done.run({ ids }, { signal, ambient }));
		if (answer.kind !== "ran") throw new Error(`not started: ${answer.end}`);
		return answer.value;
	};
	return { run, asked };
}

describe("github_done", () => {
	it("reads each thread for GitHub's own title and link before marking it done, and deletes nothing it cannot read", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const { run, asked } = github(ambient, [
			{ status: 200, body: thread("7") },
			{ status: 204 },
			{ status: 404 },
			{ status: 502 },
		]);

		const answer = await run(["7", "8", "9"]);

		expect(answer.threads).toEqual([
			{ threadId: "7", title: "Thread 7", url: "https://github.com/atelier/app/pull/7", outcome: "done" },
			{ threadId: "8", outcome: "not_found" },
			{ threadId: "9", outcome: "not_attempted" },
		]);
		expect(answer.note).toMatch(/502/);
		expect(asked).toEqual([
			"GET /notifications/threads/7",
			"DELETE /notifications/threads/7",
			"GET /notifications/threads/8",
			"GET /notifications/threads/9",
		]);
	});

	it("stops at a rate limit naming the wait, and sends nothing more until it is out", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const { run, asked } = github(ambient, [
			{ status: 200, body: thread("1") },
			{ status: 403, headers: { "retry-after": "120" } },
		]);

		const first = await run(["1", "2", "3"]);
		const again = await run(["2"]);

		expect(first.threads.map((item) => item.outcome)).toEqual(["rate_limited", "not_attempted", "not_attempted"]);
		expect(first.note).toMatch(/wait 120s/);
		expect(again.threads.map((item) => item.outcome)).toEqual(["not_attempted"]);
		expect(again.note).toMatch(/wait 120s/);
		expect(asked).toHaveLength(2);
	});

	it("answers a delete unanswered at the deadline as uncertain, and starts nothing after it", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const { run, asked } = github(ambient, [{ status: 200, body: thread("1") }, "hang"]);

		const ran = run(["1", "2"], 1_000);
		await ambient.advance(0);
		await ambient.advance(1_000);
		const answer = await ran;

		expect(answer.threads.map((item) => item.outcome)).toEqual(["uncertain", "not_attempted"]);
		expect(answer.note).toMatch(/out of time/);
		expect(asked).toHaveLength(2);
	});

	it("attempts nothing without a usable token", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const { run, asked } = github(ambient, [], { kind: "stopped", reason: "needs a secret" });

		const answer = await run(["1", "2"]);

		expect(answer).toEqual({
			threads: [
				{ threadId: "1", outcome: "not_attempted" },
				{ threadId: "2", outcome: "not_attempted" },
			],
			note: "needs a secret",
		});
		expect(asked).toEqual([]);
	});
});
