import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Watcher, WatcherEvent } from "../gateway/assistant/watcher.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import { blobIdFor } from "../shared/blob-store.js";
import type { ConsoleAssistantStateResult } from "../shared/schemasAssistant.js";
import type { AssistantWatcherRules } from "../shared/schemasAssistantRules.js";
import { type AssistantSendRequest, AssistantSendRequestSchema } from "../shared/schemasAssistantSend.js";
import { composeSessionName } from "../shared/session-id.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type DomainPeer, type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

type Answer = {
	outcome?: string;
	requestId?: string;
	note?: string;
	guard?: string;
	sessionId?: string;
	error?: string;
};

describe("the assistant's guarded sends", () => {
	let h: FederationHarness;
	let bob: DomainPeer;
	const attached = new Map<string, FakeSession>();
	const tokens = new Map<string, string | undefined>();
	/** Next registration drops immediately. */
	const dropOnWake = new Set<string>();
	const events: WatcherEvent[] = [];
	let polls = 0;
	const watcher: Watcher = {
		id: "fake",
		label: "Fake source",
		fieldSpecs: [{ kind: "text", field: "kind", label: "Kind" }],
		poll: async () => {
			polls += 1;
			return { kind: "events", events: [...events], cursor: `c${polls}`, capped: false, nextPollMs: 60_000 };
		},
	};

	const attach = (team: string, sessionToken: string | undefined, fresh = false) => {
		tokens.set(team, sessionToken);
		const held = attached.get(team);
		if (held && !fresh && !dropOnWake.has(team)) return held;
		const session = attachFakeSession(h.gateway, {
			team,
			conversationId: `conv-${team.replaceAll(".", "-")}`,
			sessionToken,
		});
		attached.set(team, session);
		if (dropOnWake.delete(team)) session.close();
		return session;
	};
	const assistant = () => {
		const session = attached.get(ASSISTANT_TEAM);
		if (!session) throw new Error("the assistant is not attached");
		return session;
	};
	const created = async (displayLabel: string) => {
		const { result } = await h.phone.value({ kind: "create_session", target: h.target("host"), displayLabel });
		const session = await h.waitFor(() => attached.get(`host.${(result as { id: string }).id}`), displayLabel);
		await session.ready();
		return session;
	};
	const post = async (path: string, body: Record<string, unknown>) => {
		const response = await assistant().post(path, body);
		return { status: response.status, json: (await response.json()) as Answer & Record<string, unknown> };
	};
	const send = (to: string, body: string, extra: Record<string, unknown> = {}) =>
		post("/assistant/send", { to, body, fromConversationId: assistant().conversationId, waitMs: 0, ...extra });
	const collect = (requestId: string) => post("/assistant/send/collect", { requestId, waitMs: 10_000 });
	const answer = async (requestId: string, decision: "approve" | "deny", note?: string) =>
		(
			await h.phone.value({
				kind: "assistant_send_answer",
				requestId,
				decision,
				...(note ? { note } : {}),
			})
		).result as { ok: boolean };
	const rows = async (actionType: string) =>
		h.phone
			.entries(await h.phone.inboxRead())
			.filter((entry) => entry.pluginId === "assistant" && entry.actionType === actionType);
	const card = (requestId: string): Promise<AssistantSendRequest> =>
		h.waitFor(async () => {
			const row = (await rows("send-request")).find((entry) => entry.payload?.requestId === requestId);
			return row ? AssistantSendRequestSchema.parse(row.payload) : undefined;
		}, "the send card");
	const retracted = (requestId: string) =>
		h.waitFor(
			async () => (await rows("send-retract")).find((entry) => entry.payload?.requestId === requestId),
			"the retracted card",
		);
	const records = async (body: string) =>
		h.phone.entries(await h.phone.inboxRead()).filter((entry) => entry.kind === "peer" && entry.body === body);
	const ownerSays = async (body: string) => {
		await h.phone.deliver(ASSISTANT_TEAM, { kind: "send", to: ASSISTANT_TEAM, body });
		await h.waitFor(
			() => attached.get(ASSISTANT_TEAM)?.inbound.find((frame) => frame.body === body),
			`the owner's "${body}"`,
		);
	};
	const safety = async (approveEverySend: boolean) =>
		(await h.phone.value({ kind: "assistant_safety", approveEverySend })).result as ConsoleAssistantStateResult;

	let worker: FakeSession;
	let friend: FakeSession;

	beforeAll(async () => {
		h = await startFederationHarness({ assistantWatchers: [watcher], wakeTimeoutMs: 2_000 });
		h.host.handlers.onCreateSession = (op) =>
			void attach(composeSessionName(op.target.name, op.target.sessionName), op.sessionToken);
		h.host.handlers.onWake = (frame) => void attach(String(frame.team), frame.sessionToken as string | undefined);
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
		const rules = (ruleResult.result as { rules: AssistantWatcherRules }).rules;
		const current = await h.phone.homeRead();
		const placement = await h.phone.homePut({
			gatewayId: h.set.gateway.id,
			workdirPath: "~/projects/notes",
			carried: { approveEverySend: true, watchers: [{ id: "fake", rules, grant: null }] },
			baseVersion: current.record?.version ?? 0,
		});
		if (!placement.record) throw new Error("the Router did not hold the home choice");
		await h.waitFor(async () => {
			const answer = await h.phone.homeRead();
			return answer.report?.version === placement.record?.version && answer.report?.outcome === "placed"
				? answer
				: undefined;
		}, "the assistant placement report");
		await h.waitFor(() => polls >= 1, "the priming poll");
		await ownerSays("hello");
		worker = await created("Worker");

		bob = await h.addDomain({ domainId: "bob", gatewayId: "desk" });
		await h.link(h, bob);
		friend = attachFakeSession(bob.gateway, { team: "fixture-app.friend", conversationId: "conv-friend" });
		await friend.ready();
		const sessionTarget = bob.target(friend.team);
		await h.waitFor(async () => {
			const shared = (await bob.phone.send({
				kind: "cross_domain_share",
				sessionTarget,
				target: { kind: "domain", domainId: h.set.domain.id },
			})) as { ok?: boolean; reason?: string };
			return shared.reason === "session" ? undefined : shared;
		}, "the friend's share");
		await h.waitFor(
			() => bob.gateway.faults.sharesHeld().sessionTargets.includes(sessionTarget) || undefined,
			"the friend Gateway's copy of the share",
		);
	}, 90_000);
	afterAll(async () => {
		for (const session of attached.values()) session.close();
		friend?.close();
		if (h) await h.close();
	});

	it("holds a send on the owner's card and delivers it once, exactly as bound, at the tap", async () => {
		const held = await send(worker.team, "first question", { disposition: "asking" });
		const shown = await card(held.json.requestId ?? "");
		const approved = await answer(shown.requestId, "approve");
		const outcome = await collect(shown.requestId);
		await h.waitFor(() => worker.inbound.find((frame) => frame.body === "first question"), "the delivery");
		const again = await answer(shown.requestId, "approve");
		await retracted(shown.requestId);
		const recorded = await h.waitFor(async () => {
			const found = await records("first question");
			return found.length >= 2 ? found : undefined;
		}, "the send's records");

		expect(held.json.outcome).toBe("pending");
		expect(shown.intent).toEqual({
			target: h.target(worker.team),
			body: "first question",
			disposition: "asking",
			createsSession: false,
			files: [],
		});
		expect(approved).toEqual({ ok: true });
		expect(outcome.json).toMatchObject({ outcome: "sent", guard: "approved", target: h.target(worker.team) });
		expect(again.ok).toBe(false);
		expect(worker.inbound.filter((frame) => frame.body === "first question")).toHaveLength(1);
		expect(recorded.map((entry) => entry.guard)).toEqual(["approved", "approved"]);
	});

	it("creates a host session from an approved send's label, and answers with the address it minted", async () => {
		const typed = h.target("host.github-ops");
		const held = await send(typed, "approve the PRs", { displayLabel: "GitHub Ops" });
		const shown = await card(held.json.requestId ?? "");
		await answer(shown.requestId, "approve");
		const outcome = await collect(shown.requestId);
		const minted = String(outcome.json.target ?? "");
		const session = await h.waitFor(
			() => [...attached.values()].find((candidate) => h.target(candidate.team) === minted),
			"the minted session",
		);
		await h.waitFor(() => session.inbound.find((frame) => frame.body === "approve the PRs"), "the delivery");

		expect(shown.intent).toMatchObject({ displayLabel: "GitHub Ops", createsSession: true });
		expect(outcome.json).toMatchObject({ outcome: "sent", guard: "approved" });
		expect(minted).not.toBe(typed);
	}, 30_000);

	it("joins a repeat to the open card, opens another for different text, and sends nothing withdrawn", async () => {
		const first = await send(worker.team, "joined text");
		const repeat = await send(worker.team, "joined text");
		const other = await send(worker.team, "other text");
		const withdrawn = await post("/assistant/send/withdraw", { requestId: first.json.requestId });
		await post("/assistant/send/withdraw", { requestId: other.json.requestId });
		const late = await answer(first.json.requestId ?? "", "approve");
		const gone = await collect(first.json.requestId ?? "");

		expect(repeat.json.requestId).toBe(first.json.requestId);
		expect(other.json.requestId).not.toBe(first.json.requestId);
		expect(withdrawn.json).toEqual({ withdrawn: true });
		expect(late.ok).toBe(false);
		expect(gone.status).toBe(404);
		expect(worker.inbound.some((frame) => frame.body === "joined text" || frame.body === "other text")).toBe(false);
	});

	it("answers a deny with the owner's note and records nothing", async () => {
		const held = await send(worker.team, "denied text");
		await card(held.json.requestId ?? "");
		const denied = await answer(held.json.requestId ?? "", "deny", "not that team");
		const outcome = await collect(held.json.requestId ?? "");

		expect(denied).toEqual({ ok: true });
		expect(outcome.json).toEqual({ outcome: "denied", note: "not that team" });
		expect(await records("denied text")).toEqual([]);
		expect(worker.inbound.some((frame) => frame.body === "denied text")).toBe(false);
	});

	it("refuses the assistant on the session road, whatever sender it names", async () => {
		const plain = { to: worker.team, fromConversationId: assistant().conversationId };
		const own = await post("/send", { ...plain, from: ASSISTANT_TEAM, body: "unguarded own" });
		const forged = await post("/send", { ...plain, from: "host.nobody", body: "unguarded forged" });

		expect([own.status, forged.status]).toEqual([403, 403]);
		expect(worker.inbound.some((frame) => String(frame.body).startsWith("unguarded"))).toBe(false);
	});

	it("refuses an attachment that does not match its upload, or names no digest", async () => {
		const bytes = Buffer.from("bound bytes");
		const blobId = blobIdFor(bytes);
		await assistant().post("/blob/put", { blobId, offset: 0, chunk: bytes.toString("base64"), final: true });
		const file = {
			filename: "a.txt",
			descriptiveKey: "a",
			mime: "text/plain",
			size: bytes.length,
			role: "attachment",
		};

		const changed = await send(worker.team, "with a file", {
			files: [{ ...file, blobId, size: bytes.length + 1 }],
		});
		const undigested = await send(worker.team, "with a file", { files: [file] });
		const bound = await send(worker.team, "with a file", { files: [{ ...file, blobId }] });
		const shown = await card(bound.json.requestId ?? "");
		await post("/assistant/send/withdraw", { requestId: bound.json.requestId });

		expect(changed.status).toBe(409);
		expect(undigested.status).toBe(400);
		expect(shown.intent.files).toEqual([
			{ digest: blobId, filename: "a.txt", mime: "text/plain", size: bytes.length },
		]);
	});

	it("binds a friend Domain's session by its canonical address and delivers there", async () => {
		const target = bob.target(friend.team);
		const held = await send(target, "across Domains");
		const shown = await card(held.json.requestId ?? "");
		await answer(shown.requestId, "approve");
		const outcome = await collect(shown.requestId);

		expect(shown.intent).toMatchObject({ target, friendDomain: "bob" });
		expect(outcome.json).toMatchObject({ outcome: "sent", guard: "approved" });
		await h.waitFor(() => friend.inbound.find((frame) => frame.body === "across Domains"), "the friend's delivery");
	});

	it("records a send to a sleeping session once, when it is accepted, not again on delivery", async () => {
		const sleeper = await created("Sleeper");
		sleeper.close();
		dropOnWake.add(sleeper.team);
		const held = await send(sleeper.team, "while asleep");
		await answer(held.json.requestId ?? "", "approve");
		const outcome = await collect(held.json.requestId ?? "");
		const queuedRecords = await h.waitFor(async () => {
			const found = await records("while asleep");
			return found.length >= 2 ? found : undefined;
		}, "the queued send's records");
		const woken = attach(sleeper.team, tokens.get(sleeper.team), true);
		await h.waitFor(() => woken.inbound.find((frame) => frame.body === "while asleep"), "the drained delivery");

		expect(outcome.json).toMatchObject({ outcome: "sent", guard: "approved" });
		expect(queuedRecords).toHaveLength(2);
		expect(await records("while asleep")).toHaveLength(2);
	});

	it("with approval off, sends unasked only while the owner spoke last", async () => {
		const off = await safety(false);
		await ownerSays("go ahead");
		const afterOwner = await send(worker.team, "unasked one");

		events.push({ id: "e1", at: 10, title: "mention e1", fields: { kind: "mention" } });
		await h.phone.value({ kind: "assistant_watcher_grants", watcherId: "fake", entryIds: [] });
		await h.waitFor(() => assistant().inbound.find((frame) => frame.event === true), "the watcher's event");
		const afterEvent = await send(worker.team, "after an event");
		await post("/assistant/send/withdraw", { requestId: afterEvent.json.requestId });

		await ownerSays("again");
		const afterOwnerAgain = await send(worker.team, "unasked two");
		const push = await h.waitFor(
			() => worker.inbound.find((frame) => frame.body === "unasked two"),
			"the delivery",
		);
		await worker.reply(String(push.session_id), "a reply");
		await h.waitFor(
			() => assistant().frames.find((frame) => JSON.stringify(frame).includes("a reply")),
			"the reply reaching the assistant",
		);
		const afterReply = await send(worker.team, "after a reply");
		await post("/assistant/send/withdraw", { requestId: afterReply.json.requestId });
		// Mirrors use outbox delivery.
		const unasked = await h.waitFor(async () => {
			const found = await records("unasked one");
			return found.length >= 2 ? found : undefined;
		}, "the unasked send's records");

		expect(off.approveEverySend).toBe(false);
		expect(afterOwner.json).toMatchObject({ outcome: "sent", guard: "unasked" });
		expect(afterEvent.json.outcome).toBe("pending");
		expect(afterOwnerAgain.json).toMatchObject({ outcome: "sent", guard: "unasked" });
		expect(afterReply.json.outcome).toBe("pending");
		expect(unasked.map((entry) => entry.guard)).toEqual(["unasked", "unasked"]);
	});

	it("after a restart, keeps the setting, asks with no marker, and retracts a card it can no longer answer", async () => {
		await ownerSays("before restart");
		const held = await safety(true).then(() => send(worker.team, "held over restart"));
		await card(held.json.requestId ?? "");
		await safety(false);

		await h.restartGateway();
		attach(ASSISTANT_TEAM, tokens.get(ASSISTANT_TEAM), true);
		await assistant().ready();
		await retracted(held.json.requestId ?? "");
		const state = (await h.phone.value({ kind: "assistant_state" })).result as ConsoleAssistantStateResult;
		const late = await answer(held.json.requestId ?? "", "approve");
		const asked = await send(worker.team, "no marker yet");
		await post("/assistant/send/withdraw", { requestId: asked.json.requestId });

		expect(state.approveEverySend).toBe(false);
		expect(late.ok).toBe(false);
		expect(asked.json.outcome).toBe("pending");
	});
});
