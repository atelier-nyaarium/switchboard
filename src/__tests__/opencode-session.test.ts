import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApiSession, createOpencodeSession } from "../mcp/opencode/session.js";
import { opencodeAuth, promptIdOf } from "../shared/opencode.js";
import type { DerivedPresence } from "../shared/schemasPresence.js";
import type { ChannelPushPayload } from "../shared/types.js";
import { createFakeOpencodeServer, type FakeOpencodeServer } from "../testing/fakeOpencodeServer.js";

const SES = "ses_sbmain";
const ENV_READ = { id: "per_1", sessionID: SES, action: "read", resources: ["/p/.env"] };

interface Plug {
	server: FakeOpencodeServer;
	session: ApiSession;
	reports: Array<DerivedPresence | undefined>;
	/** Holds reconnects until `release`. */
	hold(): void;
	release(): void;
}

const live: ApiSession[] = [];
afterEach(() => {
	for (const session of live.splice(0)) session.stop();
});

/** Started, first read landed. */
async function plug(): Promise<Plug> {
	const server = createFakeOpencodeServer();
	server.addSession(SES, "/p");
	const reports: Plug["reports"] = [];
	let held = false;
	const waiting: Array<() => void> = [];
	let ids = 0;
	const session = createOpencodeSession({
		file: { url: server.url, password: server.password, sessionId: SES, directory: "/p" },
		fetch: server.fetch,
		render: async (payload) => `<channel>${"body" in payload ? payload.body : payload.response}</channel>`,
		report: (derived) => reports.push(derived),
		newId: () => `fresh-${++ids}`,
		sleep: async () => {
			if (held) await new Promise<void>((resolve) => waiting.push(resolve));
			else await new Promise((resolve) => setTimeout(resolve, 0));
		},
		log: () => undefined,
	});
	live.push(session);
	session.start();
	await vi.waitFor(() => expect(reports).toHaveLength(1));
	return {
		server,
		session,
		reports,
		hold: () => {
			held = true;
		},
		release: () => {
			held = false;
			for (const resolve of waiting.splice(0)) resolve();
		},
	};
}

const push = (body: string, extra: Partial<ChannelPushPayload> = {}): ChannelPushPayload => ({
	type: "channel_push",
	from: "host.peer",
	body,
	session_id: "conv-1",
	...extra,
});

const last = (p: Plug) => p.reports.at(-1);
const compactingEdges = (p: Plug) => p.reports.filter((derived) => derived?.compacting).length;

/** The server's own running list. */
async function activeOf(server: FakeOpencodeServer): Promise<unknown> {
	const response = await server.fetch(`${server.url}/api/session/active`, {
		headers: { authorization: opencodeAuth(server.password) },
	});
	return ((await response.json()) as { data?: unknown }).data;
}

describe("delivery into an OpenCode session", () => {
	it("lands a delivery once however often it is retried, and starts a turn", async () => {
		const p = await plug();

		await p.session.deliver(push("hello", { delivery_id: "d1" }));
		await p.session.deliver(push("hello", { delivery_id: "d1" }));
		await p.session.respond({ type: "response_push", session_id: "conv-1", response: "answered" });

		expect(p.server.messages(SES)).toEqual([
			{ id: promptIdOf("d1"), type: "user", text: "<channel>hello</channel>" },
			{ id: promptIdOf("fresh-1"), type: "user", text: "<channel>answered</channel>" },
		]);
		await vi.waitFor(() => expect(last(p)?.working).toBe(true));
	});

	it("retries a server that failed, and gives up on one that refused", async () => {
		const p = await plug();

		p.server.failNext(503, 2);
		await p.session.deliver(push("after a hiccup", { delivery_id: "d2" }));
		p.server.failNext(400);
		const refused = p.session.deliver(push("malformed", { delivery_id: "d3" }));

		await expect(refused).rejects.toThrow();
		expect(p.server.messages(SES).map((row) => row.id)).toEqual([promptIdOf("d2")]);
	});

	it("adds a notice that asks nothing as context, without a turn", async () => {
		const p = await plug();

		await p.session.deliver(push("fyi", { delivery_id: "d4", no_ack: true, act: "no_act" }));
		const afterNotice = await activeOf(p.server);
		await p.session.deliver(push("act on this", { delivery_id: "d5", no_ack: true, act: "act_now" }));

		expect(afterNotice).toEqual({});
		expect(p.server.messages(SES).map((row) => row.type)).toEqual(["synthetic", "user"]);
		await vi.waitFor(() => expect(last(p)?.working).toBe(true));
	});
});

describe("a permission answered from the phone", () => {
	it("approves once, and the prompt leaves the session's state", async () => {
		const p = await plug();
		p.server.ask(ENV_READ);
		await vi.waitFor(() => expect(last(p)?.prompt?.id).toBe("per_1"));

		const answer = await p.session.control({ kind: "answerPrompt", promptId: "per_1", decision: "approve" });

		expect(answer).toEqual({ ok: true, outcome: "answered" });
		expect(p.server.replies).toEqual([{ id: "per_1", sessionID: SES, decision: "once" }]);
		await vi.waitFor(() => expect(last(p)?.prompt).toBeUndefined());
	});

	it("denies with the owner's note, and answers a second answer as stale", async () => {
		const p = await plug();
		p.server.ask({ ...ENV_READ, sessionID: "ses_subagent" });
		await vi.waitFor(() => expect(last(p)?.prompt?.id).toBe("per_1"));
		const deny = { kind: "answerPrompt", promptId: "per_1", decision: "deny", reason: "use .env.example" } as const;

		const first = await p.session.control(deny);
		const second = await p.session.control(deny);

		expect([first, second]).toEqual([
			{ ok: true, outcome: "answered" },
			{ ok: true, outcome: "stale" },
		]);
		expect(p.server.replies).toEqual([
			{ id: "per_1", sessionID: "ses_subagent", decision: "reject", message: "use .env.example" },
		]);
	});

	it("answers stale for a prompt the server already closed", async () => {
		const p = await plug();
		p.server.ask(ENV_READ);
		await vi.waitFor(() => expect(last(p)?.prompt?.id).toBe("per_1"));
		p.hold();
		p.server.cutStreams();
		await p.server.fetch(`${p.server.url}/api/session/${SES}/permission/per_1/reply`, {
			method: "POST",
			headers: { authorization: opencodeAuth(p.server.password) },
			body: JSON.stringify({ decision: "once" }),
		});

		const answer = await p.session.control({ kind: "answerPrompt", promptId: "per_1", decision: "approve" });

		expect(answer).toEqual({ ok: true, outcome: "stale" });
	});
});

describe("an OpenCode session's state across a dropped stream", () => {
	it("reads a turn that ended during a cut as ended once it reconnects", async () => {
		const p = await plug();
		await p.session.deliver(push("work", { delivery_id: "d6" }));
		await vi.waitFor(() => expect(last(p)?.working).toBe(true));

		p.hold();
		p.server.cutStreams();
		p.server.finishTurn(SES);
		p.release();

		await vi.waitFor(() => expect(last(p)?.working).toBe(false));
		expect(p.server.streams()).toBe(1);
	});

	it("reports a compaction that began and ended during a cut as one start and one end", async () => {
		const p = await plug();

		p.hold();
		p.server.cutStreams();
		p.server.startCompaction(SES);
		p.server.finishCompaction(SES);
		p.release();
		await vi.waitFor(() => expect(compactingEdges(p)).toBe(1));
		p.server.cutStreams();
		await vi.waitFor(() => expect(p.server.streams()).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 20));

		const edge = p.reports.findIndex((derived) => derived?.compacting);
		expect(p.reports[edge + 1]?.compacting).toBeUndefined();
		expect(compactingEdges(p)).toBe(1);
	});

	it("reports a second compaction inside a cut apart from one that ended live before it", async () => {
		const p = await plug();
		p.server.startCompaction(SES);
		p.server.finishCompaction(SES);
		await vi.waitFor(() => expect(compactingEdges(p)).toBe(1));
		await vi.waitFor(() => expect(last(p)?.compacting).toBeUndefined());

		p.hold();
		p.server.cutStreams();
		p.server.startCompaction(SES);
		p.server.finishCompaction(SES);
		p.release();
		await vi.waitFor(() => expect(compactingEdges(p)).toBe(2));
		p.server.cutStreams();
		await vi.waitFor(() => expect(p.server.streams()).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(last(p)?.compacting).toBeUndefined();
		expect(compactingEdges(p)).toBe(2);
	});

	/** Start in a cut, end live. */
	async function compactionAcrossCut(p: Plug, steer: boolean): Promise<number> {
		p.hold();
		p.server.cutStreams();
		p.server.startCompaction(SES);
		if (steer) await p.session.deliver(push("steer mid-compaction", { delivery_id: "d7" }));
		p.release();
		await vi.waitFor(() => expect(last(p)?.working).toBe(true));
		const before = compactingEdges(p);
		p.server.finishCompaction(SES);
		await vi.waitFor(() => expect(last(p)?.working).toBe(false));
		p.server.cutStreams();
		await vi.waitFor(() => expect(p.server.streams()).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		return before;
	}

	it.each([
		["", false],
		[", a prompt listed above it,", true],
	])(
		"reports one start and end for a compaction whose start fell in a cut%s and whose end arrived live",
		async (_label, steer) => {
			const p = await plug();

			const before = await compactionAcrossCut(p, steer);

			expect(before).toBe(1);
			expect(compactingEdges(p)).toBe(1);
		},
	);

	it("reports one start and end for a compaction that finished mid-turn in a cut and whose turn ended live", async () => {
		const p = await plug();
		p.hold();
		p.server.cutStreams();
		p.server.startCompaction(SES);
		p.server.finishCompaction(SES, { midTurn: true });
		p.release();
		await vi.waitFor(() => expect(last(p)?.compacting).toBe(true));

		p.server.finishTurn(SES);
		await vi.waitFor(() => expect(last(p)?.working).toBe(false));
		p.server.cutStreams();
		await vi.waitFor(() => expect(p.server.streams()).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(last(p)?.compacting).toBeUndefined();
		expect(compactingEdges(p)).toBe(1);
	});

	it("reports one start and end for a compaction whose start event never arrived", async () => {
		const p = await plug();

		p.server.emit("session.compaction.ended", { sessionID: SES, reason: "auto", inputID: "msg_lost" });
		await vi.waitFor(() => expect(compactingEdges(p)).toBe(1));
		p.server.cutStreams();
		await vi.waitFor(() => expect(p.server.streams()).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(last(p)?.compacting).toBeUndefined();
		expect(compactingEdges(p)).toBe(1);
	});

	it.each([
		["live", false],
		["inside a cut", true],
	])("adds no edge at the next resync for a compaction that failed %s", async (_label, inCut) => {
		const p = await plug();
		const broke = { type: "compaction.failed", message: "context too long" };
		p.server.startCompaction(SES);
		p.server.finishCompaction(SES);
		await vi.waitFor(() => expect(compactingEdges(p)).toBe(1));
		await vi.waitFor(() => expect(last(p)?.compacting).toBeUndefined());

		if (inCut) p.hold();
		p.server.cutStreams();
		if (!inCut) await vi.waitFor(() => expect(p.server.streams()).toBe(1));
		p.server.startCompaction(SES);
		p.server.finishCompaction(SES, { error: broke });
		if (inCut) p.release();
		if (!inCut) await vi.waitFor(() => expect(last(p)?.working).toBe(false));
		p.server.cutStreams();
		await vi.waitFor(() => expect(p.server.streams()).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(compactingEdges(p)).toBe(inCut ? 1 : 2);
		expect(last(p)?.compacting).toBeUndefined();
	});

	it.each([
		["running", "arrival"],
		["finished", "release"],
	] as const)(
		"reports one edge for a compaction whose end arrived during a read that saw it %s",
		async (_label, computed) => {
			const p = await plug();
			p.hold();
			p.server.cutStreams();
			p.server.startCompaction(SES);
			const reads = ["/api/session/active", "/api/permission/request", `/api/session/${SES}/message`].map(
				(route) => p.server.stallNext(route, computed),
			);
			const mark = p.server.requests.length;
			p.release();
			await vi.waitFor(() =>
				expect(p.server.requests.slice(mark).some((req) => req.route.startsWith("/api/session/active"))).toBe(
					true,
				),
			);

			p.server.finishCompaction(SES);
			for (const read of reads) read.release();
			await vi.waitFor(() => expect(last(p)?.working).toBe(false));
			p.server.cutStreams();
			await vi.waitFor(() => expect(p.server.streams()).toBe(1));
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(compactingEdges(p)).toBe(1);
			expect(last(p)?.compacting).toBeUndefined();
		},
	);

	it("keeps a held limit through a repeated prompt's empty execution and a resync", async () => {
		const p = await plug();
		await p.session.deliver(push("work", { delivery_id: "d9" }));
		await vi.waitFor(() => expect(last(p)?.working).toBe(true));
		p.server.finishTurn(SES, { type: "provider.free-limit", message: "resets 5pm" });
		await vi.waitFor(() => expect(last(p)?.limitBlocked).toBe(true));
		const limitedAt = p.reports.length - 1;

		await p.session.deliver(push("work", { delivery_id: "d9" }));
		p.server.cutStreams();
		await vi.waitFor(() => expect(p.server.streams()).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(p.server.messages(SES).at(-1)?.type).toBe("idle");
		expect(p.reports.slice(limitedAt).every((derived) => derived?.limitBlocked)).toBe(true);
	});

	it("ignores a read from a dropped connection that lands after its successor's", async () => {
		const p = await plug();
		p.hold();
		const stale = p.server.stallNext("/api/session/active");
		p.server.cutStreams();
		p.release();
		await vi.waitFor(() => expect(p.server.streams()).toBe(1));
		p.server.cutStreams("reset");
		await p.session.deliver(push("newer work", { delivery_id: "d8" }));
		await vi.waitFor(() => expect(last(p)?.working).toBe(true));
		const settled = p.reports.length;

		stale.release();
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(p.reports).toHaveLength(settled);
		expect(p.session.current()?.working).toBe(true);
	});
});
