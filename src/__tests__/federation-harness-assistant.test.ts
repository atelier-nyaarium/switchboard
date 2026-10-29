import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Watcher, WatcherEvent } from "../gateway/assistant/watcher.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import type { ConsoleAssistantStateResult } from "../shared/schemasAssistant.js";
import type { AssistantHomeCarried } from "../shared/schemasAssistantHome.js";
import { DEFAULT_RULES } from "../shared/schemasAssistantRules.js";
import { ASSISTANT_COMMANDS } from "../shared/session-commands.js";
import { composeSessionName } from "../shared/session-id.js";
import type { TeamInfo } from "../shared/types.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type DomainPeer, type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

const putHome = async (
	h: FederationHarness,
	gatewayId: string | null,
	workdirPath: string | null,
	carried: AssistantHomeCarried | null = null,
) => {
	const current = await h.phone.homeRead();
	const baseVersion = current.record?.version ?? 0;
	if (gatewayId === null) return h.phone.homePut({ gatewayId: null, workdirPath: null, carried: null, baseVersion });
	if (workdirPath === null) throw new Error("a named home needs a workdir");
	return h.phone.homePut({ gatewayId, workdirPath, carried, baseVersion });
};

const waitHomeReport = (h: FederationHarness, version: number, outcome: "placed" | "refused") =>
	h.waitFor(async () => {
		const answer = await h.phone.homeRead();
		return answer.record?.version === version && answer.report?.outcome === outcome ? answer : undefined;
	}, `the ${outcome} home report`);

describe("the assistant's session through the console", () => {
	let h: FederationHarness;

	const dispatch = async (target: string, op: Parameters<typeof h.phone.deliver>[1]) => {
		const opId = `op-assistant-${op.kind}`;
		expect((await h.phone.deliver(target, op, opId)).outcome).toBe("accepted");
		const row = await h.waitFor(
			async () =>
				(await h.phone.inboxRead()).find(
					(candidate) => candidate.envelope.kind === "op_result" && candidate.envelope.opKey.opId === opId,
				),
			`dispatch result for ${opId}`,
		);
		return h.phone.open(row) as { ok: boolean; error?: string };
	};
	const assistant = async (op: Parameters<typeof h.phone.value>[0]) =>
		(await h.phone.value(op)).result as ConsoleAssistantStateResult & { ok?: boolean };

	beforeAll(async () => {
		h = await startFederationHarness();
	}, 30_000);
	afterAll(async () => {
		if (h) await h.close();
	});

	it("refuses an older app's home operations, which no schema knows", async () => {
		const placed = await h.phone.value({ kind: "assistant_place", workdir: "~/projects/notes" } as never);
		const released = await h.phone.value({ kind: "assistant_release" } as never);
		const home = await h.phone.homeRead();

		expect(placed.result).toMatchObject({ kind: "refusal" });
		expect(released.result).toMatchObject({ kind: "refusal" });
		expect(home.record).toBeNull();
	});

	it("refuses a Gateway that is not registered", async () => {
		const refused = await putHome(h, "not-registered", "~/projects/notes");
		const home = await h.phone.homeRead();

		expect(refused).toMatchObject({ outcome: "refused", refusal: "unroutable", record: null });
		expect(home.record).toBeNull();
	});

	it("lives where the owner places it, and refuses a plain forget", async () => {
		const before = await assistant({ kind: "assistant_state" });
		const invalid = await putHome(h, h.set.gateway.id, "relative/notes");
		if (!invalid.record) throw new Error("the Router did not hold the home choice");
		await waitHomeReport(h, invalid.record.version, "refused");
		const refused = await assistant({ kind: "assistant_state" });
		const placement = await putHome(h, h.set.gateway.id, "~/projects/notes");
		if (!placement.record) throw new Error("the Router did not hold the home choice");
		await waitHomeReport(h, placement.record.version, "placed");
		const placed = await assistant({ kind: "assistant_state" });
		const opsBefore = h.host.ops.length;
		const forgot = await dispatch(ASSISTANT_TEAM, { kind: "forget", target: h.target(ASSISTANT_TEAM) });

		expect(before).toMatchObject({ workdir: null, team: null });
		expect(refused).toMatchObject({ workdir: null, team: null });
		expect(placed).toMatchObject({ workdir: "~/projects/notes", team: ASSISTANT_TEAM });
		expect(placed.watchers.map((watcher) => watcher.id)).toEqual(["github"]);
		expect(placed.watchers[0]?.secret).toBeTruthy();
		expect(forgot.ok, JSON.stringify(forgot)).toBe(false);
		expect(h.host.ops.length).toBe(opsBefore);
	});

	it("moves to itself with its carried rules", async () => {
		await assistant({
			kind: "assistant_rule_put",
			watcherId: "github",
			rule: {
				id: "carried-rule",
				conditions: [{ field: "repository", test: "is", value: "atelier/switchboard" }],
				action: "wake",
				revision: 0,
			},
		});
		const before = await assistant({ kind: "assistant_state" });
		if (!before.workdir) throw new Error("the assistant has no workdir to carry");
		const carried: AssistantHomeCarried = {
			approveEverySend: before.approveEverySend ?? true,
			watchers: before.watchers.map((watcher) => ({
				id: watcher.id,
				rules: watcher.rules ?? DEFAULT_RULES,
				grant: watcher.grants[0] ?? null,
			})),
		};
		const moved = await putHome(h, h.set.gateway.id, before.workdir, carried);
		if (!moved.record) throw new Error("the Router did not hold the moved home");
		await waitHomeReport(h, moved.record.version, "placed");
		const after = await assistant({ kind: "assistant_state" });

		expect(after.watchers.find((watcher) => watcher.id === "github")?.rules?.rules).toContainEqual(
			expect.objectContaining({ id: "carried-rule", action: "wake" }),
		);
	});

	it("grants a watcher its entries, and refuses a watcher it does not know", async () => {
		const granted = await assistant({
			kind: "assistant_watcher_grants",
			watcherId: "github",
			entryIds: ["gh-token"],
		});
		await assistant({ kind: "assistant_watcher_grants", watcherId: "gmail", entryIds: ["x"] });
		await assistant({ kind: "assistant_watcher_grants", watcherId: "github", entryIds: ["a", "b"] });
		const after = await assistant({ kind: "assistant_state" });

		expect(granted.watchers[0]?.grants).toEqual(["gh-token"]);
		expect(after.watchers.map((watcher) => watcher.id)).toEqual(["github"]);
	});

	it("outlives the session sweep that takes an ordinary idle session", async () => {
		const { result } = await h.phone.value({
			kind: "create_session",
			target: h.target("host"),
			displayLabel: "Idle",
		});
		const idle = `host.${(result as { id: string }).id}`;
		await new Promise((resolve) => setTimeout(resolve, 5));

		const swept = h.gateway.faults.sweepSessions(0);
		const assistantState = await assistant({ kind: "assistant_state" });

		expect(swept).toContain(idle);
		expect(swept).not.toContain(ASSISTANT_TEAM);
		expect(assistantState.team).toBe(ASSISTANT_TEAM);
	});

	it("removes the home and ends its session", async () => {
		const killsBefore = h.host.ops.filter((op) => op.kind === "killSession").length;
		const removed = await putHome(h, null, null);
		if (!removed.record) throw new Error("the Router did not hold the removal");
		const ended = await h.waitFor(async () => {
			const state = await assistant({ kind: "assistant_state" });
			const kills = h.host.ops.filter((op) => op.kind === "killSession").length;
			return state.workdir === null && state.team === null && kills > killsBefore ? state : undefined;
		}, "the assistant session ending");
		const home = await h.phone.homeRead();

		expect(removed).toMatchObject({ outcome: "applied", record: { gatewayId: null, sealed: null } });
		expect(ended).toMatchObject({ workdir: null, team: null });
		expect(home.record).toMatchObject({ gatewayId: null, sealed: null });
	});
});

describe("a watcher event reaching the assistant", () => {
	let h: FederationHarness;
	const attached = new Map<string, FakeSession>();
	const event = (id: string, kind: string, at: number): WatcherEvent => ({
		id,
		at,
		title: `${kind} ${id}`,
		fields: { kind },
	});
	// Backlog first, then two newer.
	let polls = 0;
	let wakesIgnored = 0;
	const source = [event("e1", "mention", 3), event("e2", "review", 2), event("e0", "mention", 1)];
	const watcher: Watcher = {
		id: "fake",
		label: "Fake source",
		fieldSpecs: [{ kind: "text", field: "kind", label: "Kind" }],
		poll: async () => {
			polls += 1;
			const events = polls === 1 ? source.slice(-1) : source;
			return { kind: "events", events, cursor: `c${polls}`, capped: false, nextPollMs: 60_000 };
		},
		// Two a page.
		list: async (query) => {
			const pool = source.filter((item) => query.since === undefined || item.at > query.since);
			const start = query.page ? Number(query.page) : 0;
			const more = start + 2 < pool.length;
			const mark = pool.reduce((max, item) => Math.max(max, item.at), query.since ?? 0);
			return {
				events: pool.slice(start, start + 2),
				here: String(start),
				...(more ? { next: String(start + 2) } : {}),
				...(query.scope === "new" && !more ? { mark } : {}),
			};
		},
	};
	const read = async (session: FakeSession | undefined, path: string, body: Record<string, unknown>) =>
		(await (session ?? attachedless(h)).post(path, body)).json() as Promise<Record<string, unknown>>;

	beforeAll(async () => {
		h = await startFederationHarness({ assistantWatchers: [watcher], wakeTimeoutMs: 2_000 });
		const attach = (team: string, sessionToken: string | undefined) => {
			if (attached.has(team)) return;
			const conversationId = `conv-${team.replaceAll(".", "-")}`;
			attached.set(team, attachFakeSession(h.gateway, { team, conversationId, sessionToken }));
		};
		h.host.handlers.onCreateSession = (op) =>
			attach(composeSessionName(op.target.name, op.target.sessionName), op.sessionToken);
		h.host.handlers.onWake = (frame) => {
			// First launch never comes up.
			if (frame.team === ASSISTANT_TEAM && wakesIgnored === 0) {
				wakesIgnored += 1;
				return;
			}
			attach(String(frame.team), frame.sessionToken as string | undefined);
		};
	}, 30_000);
	afterAll(async () => {
		for (const session of attached.values()) session.close();
		if (h) await h.close();
	});

	it("wakes for no backlog, retries a wake that did not land, and wakes once with the new thread as data", async () => {
		const poke = () => h.phone.value({ kind: "assistant_watcher_grants", watcherId: "fake", entryIds: [] });
		const ruleResult = await h.phone.value({
			kind: "assistant_rule_put",
			watcherId: "fake",
			rule: {
				id: "mentions",
				conditions: [{ field: "kind", test: "is", value: "mention" }],
				action: "wake",
				revision: 0,
			},
		});
		const rules = (ruleResult.result as { rules: ConsoleAssistantStateResult["watchers"][number]["rules"] }).rules;
		const placement = await putHome(h, h.set.gateway.id, "~/projects/notes", {
			approveEverySend: true,
			watchers: [{ id: "fake", rules: rules ?? DEFAULT_RULES, grant: null }],
		});
		if (!placement.record) throw new Error("the Router did not hold the home choice");
		await waitHomeReport(h, placement.record.version, "placed");
		await h.waitFor(() => polls >= 1, "the backlog poll");
		await poke();

		await h.waitFor(() => wakesIgnored === 1, "the first wake");
		const woken = await h.waitFor(async () => {
			const frame = attached.get(ASSISTANT_TEAM)?.inbound.find((pushed) => pushed.event === true);
			if (!frame) await poke();
			return frame;
		}, "the retried wake in the assistant's session");
		const settled = polls;
		await poke();
		await h.waitFor(() => polls > settled, "a poll after the wake landed");
		const state = (await h.phone.value({ kind: "assistant_state" })).result as ConsoleAssistantStateResult;

		expect(woken).toMatchObject({ from: "", session_id: "" });
		expect(woken.body).toContain("id: e1");
		expect(woken.body).toContain("Fake source");
		expect(woken.body).not.toContain("e0");
		expect(woken.body).not.toContain("review e2");
		expect(attached.get(ASSISTANT_TEAM)?.inbound.filter((frame) => frame.event === true)).toHaveLength(1);
		expect(state.watchers[0]).toMatchObject({ id: "fake", label: "Fake source", unread: 3 });
	});

	it("lists live, sorted by the rules, and moves the new mark only once a read reaches its last page", async () => {
		const session = attached.get(ASSISTANT_TEAM);
		type Listed = { lists: { label: string; items: { id: string; decision: string }[]; next?: string }[] };
		const list = async (body: Record<string, unknown>) =>
			(await read(session, ASSISTANT_COMMANDS.inbox.path, body)) as unknown as Listed;
		const ids = (answer: Listed) => answer.lists[0]?.items.map((item) => item.id);

		const first = await list({ scope: "new" });
		const again = await list({ scope: "new" });
		const last = await list({ scope: "new", page: first.lists[0]?.next });
		const caughtUp = await list({ scope: "new" });
		source.unshift(event("e3", "review", 4));
		const arrived = await list({ scope: "new" });
		const all = await list({ scope: "all" });

		expect([first, again, last, caughtUp, arrived].map(ids)).toEqual([
			["e1", "e2"],
			["e1", "e2"],
			["e0"],
			[],
			["e3"],
		]);
		expect(first.lists[0]?.items.map((item) => item.decision)).toEqual(["wake", "inbox"]);
		expect(first.lists[0]?.label).toBe("Fake source");
		expect(all.lists[0]?.next).toBeDefined();
	});

	it("continues a page cut by the byte cap, moves the mark once it is shown whole, and refuses an edited token", async () => {
		const session = attached.get(ASSISTANT_TEAM);
		type Listed = { lists: { items: { id: string }[]; cut?: number; next?: string; error?: string }[] };
		const list = async (page?: string) =>
			(await read(session, ASSISTANT_COMMANDS.inbox.path, {
				scope: "new",
				...(page ? { page } : {}),
			})) as unknown as Listed;
		const big = (id: string, at: number) => ({ ...event(id, "review", at), fields: { kind: "x".repeat(40_000) } });
		source.unshift(big("b2", 6), big("b1", 5));

		const cut = await list();
		const token = cut.lists[0]?.next ?? "";
		const edited = await list(`${token.slice(0, -2)}AA`);
		const rest = await list(token);
		const after = await list();

		expect(cut.lists[0]).toMatchObject({ items: [{ id: "b2" }], cut: 1 });
		expect(edited.lists[0]?.error).toBeDefined();
		expect(rest.lists[0]).toMatchObject({ items: [{ id: "b1" }] });
		expect(rest.lists[0]?.cut).toBeUndefined();
		expect(after.lists[0]?.items).toEqual([]);
	});

	it("answers the inbox to the assistant's own token alone", async () => {
		const { result } = await h.phone.value({
			kind: "create_session",
			target: h.target("host"),
			displayLabel: "Other",
		});
		const other = await h.waitFor(
			() => attached.get(`host.${(result as { id: string }).id}`),
			"another session attached",
		);
		await other.ready();

		expect(await read(other, ASSISTANT_COMMANDS.inbox.path, { scope: "all" })).toEqual({ kind: "not_assistant" });
		expect(await read(undefined, ASSISTANT_COMMANDS.inbox.path, { scope: "all" })).toEqual({
			kind: "unauthenticated",
		});
	});
});

describe("the assistant hidden from every session", () => {
	let h: FederationHarness;
	const attached = new Map<string, FakeSession>();
	const created = async (displayLabel: string) => {
		const { result } = await h.phone.value({ kind: "create_session", target: h.target("host"), displayLabel });
		const session = await h.waitFor(() => attached.get(`host.${(result as { id: string }).id}`), displayLabel);
		await session.ready();
		return session;
	};
	const rows = async (session: FakeSession, path: string) =>
		((await (await session.get(path)).json()) as TeamInfo[]).map((row) => row.team);
	const pending = async (session: FakeSession) =>
		((await (await session.get("/pending")).json()) as { from: string; to: string }[]).map((row) => row.to);

	beforeAll(async () => {
		h = await startFederationHarness();
		const attach = (team: string, sessionToken: string | undefined) => {
			if (attached.has(team)) return;
			const conversationId = `conv-${team.replaceAll(".", "-")}`;
			attached.set(team, attachFakeSession(h.gateway, { team, conversationId, sessionToken }));
		};
		h.host.handlers.onCreateSession = (op) =>
			attach(composeSessionName(op.target.name, op.target.sessionName), op.sessionToken);
		h.host.handlers.onWake = (frame) => attach(String(frame.team), frame.sessionToken as string | undefined);
		const placement = await putHome(h, h.set.gateway.id, "~/projects/notes");
		if (!placement.record) throw new Error("the Router did not hold the home choice");
		await waitHomeReport(h, placement.record.version, "placed");
		bob = await h.addDomain({ domainId: "bob", gatewayId: "desk" });
		await h.link(h, bob);
	}, 60_000);
	afterAll(async () => {
		for (const session of attached.values()) session.close();
		if (h) await h.close();
	});
	let bob: DomainPeer;

	it("refuses a friend's relayed send to it without waking it, and refuses sharing it", async () => {
		const friend = attachFakeSession(bob.gateway, { team: "fixture-app.friend", conversationId: "conv-friend" });
		await friend.ready();
		const wakes = h.host.wakes.length;

		const relayed = await friend.post("/send", {
			from: friend.team,
			fromConversationId: friend.conversationId,
			to: h.target(ASSISTANT_TEAM),
			targetDomainId: h.set.domain.id,
			body: "let me in",
		});
		await h.waitFor(async () => {
			const { planes } = await h.phone.planesRead();
			const payload = planes.find((plane) => plane.name === "presence")?.payload as { rows?: TeamInfo[] };
			return payload?.rows?.some((held) => held.team === ASSISTANT_TEAM && held.role === "assistant");
		}, "the assistant's row reaching the Router");
		const share = await h.phone.send({
			kind: "cross_domain_share",
			sessionTarget: h.target(ASSISTANT_TEAM),
			target: { kind: "domain", domainId: "bob" },
		});
		friend.close();

		expect(relayed.status).not.toBe(200);
		expect(share).toMatchObject({ outcome: "refused", reason: "assistant" });
		expect(h.host.wakes.length).toBe(wakes);
		expect(attached.has(ASSISTANT_TEAM)).toBe(false);
	});

	it("lists the assistant to no session, and answers a session's send to it as absent without waking it", async () => {
		const worker = await created("Worker");
		const wakes = h.host.wakes.length;

		const teams = await rows(worker, "/teams");
		const discovered = await rows(worker, "/discover");
		const sent = await worker.post("/send", { from: worker.team, to: ASSISTANT_TEAM, body: "let me in" });

		expect(teams).toContain(worker.team);
		expect(teams).not.toContain(ASSISTANT_TEAM);
		expect(discovered).not.toContain(ASSISTANT_TEAM);
		expect(sent.status).toBe(404);
		expect(h.host.wakes.length).toBe(wakes);
		expect(attached.has(ASSISTANT_TEAM)).toBe(false);
	});

	it("takes the owner's send, and the session it writes to answers it, each caller seeing only its own jobs", async () => {
		const worker = await created("Answerer");
		const bystander = await created("Bystander");
		await h.phone.deliver(ASSISTANT_TEAM, { kind: "send", to: ASSISTANT_TEAM, body: "from the owner" });
		const assistant = await h.waitFor(() => attached.get(ASSISTANT_TEAM), "the assistant woken by the owner");
		await h.waitFor(
			() => assistant.inbound.find((frame) => frame.body === "from the owner"),
			"the owner's message",
		);

		// Assistant sends require guard.
		const plain = await assistant.post("/send", {
			from: ASSISTANT_TEAM,
			fromConversationId: assistant.conversationId,
			to: worker.team,
			body: "what changed?",
		});
		expect(plain.status).toBe(403);
		const held = (await (
			await assistant.post("/assistant/send", {
				to: worker.team,
				body: "what changed?",
				fromConversationId: assistant.conversationId,
				waitMs: 0,
			})
		).json()) as { outcome: string; requestId: string };
		expect(held.outcome).toBe("pending");
		await h.waitFor(
			async () =>
				h.phone
					.entries(await h.phone.inboxRead())
					.find((entry) => entry.pluginId === "assistant" && entry.payload?.requestId === held.requestId),
			"the send card",
		);
		const approved = await h.phone.value({
			kind: "assistant_send_answer",
			requestId: held.requestId,
			decision: "approve",
		});
		expect(approved.result).toEqual({ ok: true });
		const asked = await assistant.post("/assistant/send/collect", { requestId: held.requestId, waitMs: 10_000 });
		const push = await h.waitFor(
			() => worker.inbound.find((frame) => frame.body === "what changed?"),
			"the question",
		);
		const workerJobs = await pending(worker);
		const askerJobs = await pending(assistant);
		const bystanderJobs = await pending(bystander);
		const replied = await worker.reply(String(push.session_id), "the schema");

		expect(await asked.json()).toMatchObject({ outcome: "sent", guard: "approved" });
		expect(workerJobs).toContain(worker.team);
		expect(askerJobs).toContain(worker.team);
		expect(bystanderJobs).not.toContain(worker.team);
		expect(replied.status).toBe(200);
		await h.waitFor(
			() => assistant.frames.find((frame) => JSON.stringify(frame).includes("the schema")),
			"the answer reaching the assistant",
		);

		const removed = await putHome(h, null, null);
		const removedState = await h.waitFor(async () => {
			const state = (await h.phone.value({ kind: "assistant_state" })).result as ConsoleAssistantStateResult;
			return removed.outcome === "applied" && state.team === null ? state : undefined;
		}, "the assistant removal");
		expect(removedState).toMatchObject({ workdir: null, team: null });
		assistant.close();
		attached.delete(ASSISTANT_TEAM);
		expect(await pending(bystander)).not.toContain(worker.team);
	});
});

/** No session token. */
function attachedless(h: FederationHarness): Pick<FakeSession, "post"> {
	return {
		post: (path, body) =>
			h.gateway.router(
				new Request(`http://gateway.test${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			),
	};
}
