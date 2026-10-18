import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Watcher, WatcherEvent } from "../gateway/assistant/watcher.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import type { ConsoleAssistantStateResult } from "../shared/schemasAssistant.js";
import { ASSISTANT_INBOX_CONFIRM_PATH } from "../shared/schemasAssistantInbox.js";
import { ASSISTANT_COMMANDS } from "../shared/session-commands.js";
import { composeSessionName } from "../shared/session-id.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

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

	it("lives where the owner places it, and refuses a plain forget", async () => {
		const before = await assistant({ kind: "assistant_state" });
		await assistant({ kind: "assistant_place", workdir: "relative/notes" });
		const refused = await assistant({ kind: "assistant_state" });
		const placed = await assistant({ kind: "assistant_place", workdir: "~/projects/notes" });
		const opsBefore = h.host.ops.length;
		const forgot = await dispatch(ASSISTANT_TEAM, { kind: "forget", target: h.target(ASSISTANT_TEAM) });

		expect(before).toMatchObject({ workdir: null, team: null });
		expect(refused).toMatchObject({ workdir: null, team: null });
		expect(placed).toMatchObject({ workdir: "~/projects/notes", team: ASSISTANT_TEAM });
		expect(placed.watchers.map((watcher) => watcher.id)).toEqual(["github"]);
		expect(forgot.ok, JSON.stringify(forgot)).toBe(false);
		expect(h.host.ops.length).toBe(opsBefore);
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

		expect(swept).toContain(idle);
		expect(swept).not.toContain(ASSISTANT_TEAM);
		expect(h.gateway.faults.sessionRecord(ASSISTANT_TEAM)).toBeDefined();
	});

	it("leaves on a release, ending its pane and its record", async () => {
		const released = await assistant({ kind: "assistant_release" });

		expect(released).toMatchObject({ workdir: null, team: null });
		expect(h.gateway.faults.sessionRecord(ASSISTANT_TEAM)).toBeUndefined();
		expect(h.host.ops.some((op) => op.kind === "killSession")).toBe(true);
	});
});

describe("a watcher event reaching the assistant", () => {
	let h: FederationHarness;
	const attached = new Map<string, FakeSession>();
	const event = (sourceId: string, kind: string): WatcherEvent => ({
		sourceId,
		at: 1,
		title: `${kind} ${sourceId}`,
		fields: { kind },
	});
	// Second poll replays e1.
	const answers: WatcherEvent[][] = [
		[event("e1", "mention"), event("e2", "review"), event("e3", "mention")],
		[event("e1", "mention")],
	];
	let wakesIgnored = 0;
	const watcher: Watcher = {
		id: "fake",
		fields: ["kind"],
		poll: async () => ({ kind: "events", events: answers.shift() ?? [], cursor: "c", nextPollMs: 60_000 }),
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

	it("retries a wake that did not land, wakes once with the event as data, and leaves the rest in its inbox", async () => {
		const poke = () => h.phone.value({ kind: "assistant_watcher_grants", watcherId: "fake", entryIds: [] });
		await h.phone.value({
			kind: "assistant_rule_put",
			watcherId: "fake",
			rule: {
				id: "mentions",
				conditions: [{ field: "kind", test: "is", value: "mention" }],
				action: "wake",
				revision: 0,
			},
		});
		await h.phone.value({ kind: "assistant_place", workdir: "~/projects/notes" });

		await h.waitFor(() => wakesIgnored === 1, "the first wake");
		const woken = await h.waitFor(async () => {
			const frame = attached.get(ASSISTANT_TEAM)?.inbound.find((pushed) => pushed.event === true);
			if (!frame) await poke();
			return frame;
		}, "the retried wake in the assistant's session");
		await poke();
		await h.waitFor(() => answers.length === 0, "the replayed poll");
		const session = attached.get(ASSISTANT_TEAM);
		const inbox = await read(session, ASSISTANT_COMMANDS.inbox.path, {});
		const confirmed = await read(session, ASSISTANT_INBOX_CONFIRM_PATH, { boundaries: inbox.boundaries });
		const after = await read(session, ASSISTANT_COMMANDS.inbox.path, {});

		expect(woken).toMatchObject({ from: "", session_id: "" });
		expect(woken.body).toContain("mention e1");
		expect(woken.body).toContain("mention e3");
		expect(woken.body).toContain("ping: no");
		expect(session?.inbound.filter((frame) => frame.event === true)).toHaveLength(1);
		expect((inbox.events as { title: string }[]).map((row) => row.title)).toEqual(["review e2"]);
		expect(confirmed).toEqual({ kind: "confirmed" });
		expect(after).toMatchObject({ kind: "events", events: [] });
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

		expect(await read(other, ASSISTANT_COMMANDS.inbox.path, {})).toEqual({ kind: "not_assistant" });
		expect(await read(other, ASSISTANT_INBOX_CONFIRM_PATH, { boundaries: { fake: 99 } })).toEqual({
			kind: "not_assistant",
		});
		expect(await read(undefined, ASSISTANT_INBOX_CONFIRM_PATH, { boundaries: { fake: 99 } })).toEqual({
			kind: "unauthenticated",
		});
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
