import { describe, expect, it } from "vitest";
import { createOriginMarker, createSendGuard } from "../gateway/assistant/sendGuard.js";
import type { BoundTarget, SendRecord } from "../gateway/routes/routesSend.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import type { ChannelFile } from "../shared/channel-file.js";
import type { MessageDelivery, PendingDelivery } from "../shared/pending-delivery-store.js";
import type { AssistantSendRequest } from "../shared/schemasAssistantSend.js";
import { VAULT_REQUEST_DEADLINE_MS } from "../shared/schemasVault.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const row = (seq: number, origin: PendingDelivery["origin"], team = ASSISTANT_TEAM): PendingDelivery => ({
	deliveryId: `d${seq}`,
	team,
	body: "",
	enqueuedAt: 0,
	channelJobId: "j",
	from: "x",
	seq,
	...(origin ? { origin } : {}),
});

describe("the origin marker", () => {
	const clock = () => 0;

	it("reads the owner only while the newest acceptance it saw was the owner's", () => {
		const marker = createOriginMarker(0, clock);
		const missing = marker.readsOwner();
		marker.delivered(row(1, "owner"));
		const owner = marker.readsOwner();
		// Late acknowledgements cannot rewind origin.
		marker.delivered(row(3, "event"));
		marker.delivered(row(2, "owner"));
		const afterEvent = marker.readsOwner();
		marker.delivered(row(4, "owner"));
		const ownerAgain = marker.readsOwner();
		marker.replyPushed(4);
		const afterReply = marker.readsOwner();
		marker.delivered(row(5, "owner"));
		const afterNewerOwner = marker.readsOwner();
		marker.delivered(row(6, undefined));
		const legacy = marker.readsOwner();
		marker.delivered(row(7, "owner", "host.other"));
		const otherTeam = marker.readsOwner();

		expect([missing, owner, afterEvent, ownerAgain, afterReply, afterNewerOwner, legacy, otherTeam]).toEqual([
			false,
			true,
			false,
			true,
			false,
			true,
			false,
			false,
		]);
	});

	it("asks after a session ends, and never reads an owner row accepted before boot", () => {
		const marker = createOriginMarker(10, clock);
		marker.delivered(row(9, "owner"));
		const preboot = marker.readsOwner();
		marker.delivered(row(10, "owner"));
		const owner = marker.readsOwner();
		marker.ended();
		const afterEnd = marker.readsOwner();
		marker.offered(row(11, "event"));
		marker.delivered(row(12, "owner"));
		const ownerAfterEvent = marker.readsOwner();

		expect([preboot, owner, afterEnd, ownerAfterEvent]).toEqual([false, true, false, true]);
	});

	it("opens writes while the owner prompted last or spoke within half an hour, its own replies aside", () => {
		let now = 0;
		const marker = createOriginMarker(0, () => now);
		const fresh = marker.writes();
		marker.delivered(row(1, "owner"));
		marker.replyPushed(1);
		now = 40 * 60_000;
		const afterOwnReply = marker.writes();
		marker.offered(row(2, "event"));
		const eventLate = marker.writes();
		marker.delivered(row(3, "owner"));
		now += 10 * 60_000;
		marker.offered(row(4, "event"));
		const eventSoon = marker.writes();
		marker.ended();
		const afterEnd = marker.writes();

		expect([fresh, afterOwnReply, eventLate, eventSoon, afterEnd]).toEqual([
			{ kind: "locked", idleMs: null },
			{ kind: "open" },
			{ kind: "locked", idleMs: 40 * 60_000 },
			{ kind: "open" },
			{ kind: "locked", idleMs: null },
		]);
	});

	it("never reads an owner row carrying screen text as the owner's words", () => {
		const marker = createOriginMarker(0, clock);
		const file = (role: ChannelFile["role"]): ChannelFile => ({
			filename: "screen.txt",
			mime: "text/plain",
			size: 4,
			descriptiveKey: "k",
			role,
		});
		const ownerWith = (seq: number, role: ChannelFile["role"]): MessageDelivery => ({
			...(row(seq, "owner") as MessageDelivery),
			files: [file(role)],
		});
		marker.delivered(ownerWith(1, "screen"));
		const withScreen = marker.readsOwner();
		marker.delivered(ownerWith(2, "attachment"));
		const withAttachment = marker.readsOwner();

		expect([withScreen, withAttachment]).toEqual([false, true]);
	});
});

describe("the send guard", () => {
	const target = "home.sakura.host.worker";

	function bench(
		options: { approveEverySend?: boolean; readsOwner?: boolean; bindTarget?: (to: string) => BoundTarget } = {},
	) {
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000_000 });
		const cards: AssistantSendRequest[] = [];
		const retracts: string[] = [];
		const sent: SendRecord[] = [];
		const sentConversations: string[] = [];
		const staged = new Map<string, number>();
		const guard = createSendGuard({
			ambient,
			approveEverySend: () => options.approveEverySend ?? true,
			readsOwner: () => options.readsOwner ?? false,
			routes: () => ({
				bindTarget: (to): BoundTarget => options.bindTarget?.(to) ?? { ok: true, target, exists: true },
				sendFromAssistant: async ({ record, conversationId }) => {
					sent.push(record);
					sentConversations.push(conversationId);
					return new Response(JSON.stringify({ session_id: "s1" }), { status: 200 });
				},
			}),
			blobSize: (blobId) => staged.get(blobId) ?? null,
			deliverCard: (request) => Boolean(cards.push(request)),
			retractCard: (stub) => Boolean(retracts.push(stub.requestId)),
		});
		const caller = { team: ASSISTANT_TEAM, conversationId: "conv-a" };
		const signal = new AbortController().signal;
		/** Flush zero-delay waits. */
		const stepped = async <T>(work: Promise<T>): Promise<T> => {
			await ambient.advance(0);
			return work;
		};
		return { ambient, guard, cards, retracts, sent, sentConversations, staged, caller, signal, stepped };
	}

	it("lapses an unanswered send at its deadline, retracting the card and still answering a late collect", async () => {
		const { ambient, guard, cards, retracts, sent, caller, signal, stepped } = bench();
		const pending = await stepped(guard.send(caller, { to: target, body: "hi", waitMs: 0 }, signal));
		const requestId = cards[0]?.requestId ?? "";
		await ambient.advance(VAULT_REQUEST_DEADLINE_MS + 60_000);
		const late = await guard.collect(ASSISTANT_TEAM, requestId, 0, signal);

		expect(pending.body).toMatchObject({ outcome: "pending", requestId });
		expect(late.body).toEqual({ outcome: "expired" });
		expect(guard.answer(requestId, "approve")).toEqual({ ok: false, reason: "request expired" });
		expect(retracts).toEqual([requestId]);
		expect(sent).toEqual([]);
	});

	it("withdraws a send immediately and rejects a later tap as expired", async () => {
		const { guard, cards, caller, signal, stepped } = bench();
		await stepped(guard.send(caller, { to: target, body: "withdrawn", waitMs: 0 }, signal));
		const requestId = cards[0]?.requestId ?? "";

		expect(guard.withdraw(ASSISTANT_TEAM, requestId).body).toEqual({ withdrawn: true });
		expect(guard.answer(requestId, "approve")).toEqual({ ok: false, reason: "request expired" });
		expect((await guard.collect(ASSISTANT_TEAM, requestId, 0, signal)).status).toBe(404);
	});

	it("sends nothing when a bound attachment changed before the tap", async () => {
		const { guard, cards, sent, staged, caller, signal, stepped } = bench();
		const blobId = `sha256-${"a".repeat(64)}`;
		staged.set(blobId, 5);
		const file = {
			filename: "a.txt",
			descriptiveKey: "a",
			mime: "text/plain",
			size: 5,
			role: "attachment" as const,
			blobId,
		};
		await stepped(guard.send(caller, { to: target, body: "a", files: [file], waitMs: 0 }, signal));
		const requestId = cards[0]?.requestId ?? "";
		expect(guard.namesBlob(blobId)).toBe(true);
		staged.set(blobId, 6);

		guard.answer(requestId, "approve");
		const outcome = await guard.collect(ASSISTANT_TEAM, requestId, 1_000, signal);

		expect(outcome.body).toMatchObject({ outcome: "failed" });
		expect(sent).toEqual([]);
		expect(guard.namesBlob(blobId)).toBe(false);
	});

	it("goes unasked only with approval off and the owner last, and asks when the setting cannot be read", async () => {
		const unasked = bench({ approveEverySend: false, readsOwner: true });
		const notOwner = bench({ approveEverySend: false, readsOwner: false });
		const unreadable = bench({ readsOwner: true });
		const throwing = createSendGuard({
			...{ ambient: unreadable.ambient, blobSize: () => null },
			approveEverySend: () => {
				throw new Error("unreadable");
			},
			readsOwner: () => true,
			routes: () => ({
				bindTarget: () => ({ ok: true, target, exists: true }),
				sendFromAssistant: async () => new Response("{}"),
			}),
			deliverCard: () => true,
			retractCard: () => true,
		});

		const went = await unasked.guard.send(unasked.caller, { to: target, body: "a", waitMs: 0 }, unasked.signal);
		const held = await notOwner.stepped(
			notOwner.guard.send(notOwner.caller, { to: target, body: "a", waitMs: 0 }, notOwner.signal),
		);
		const asked = await unreadable.stepped(
			throwing.send(unasked.caller, { to: target, body: "a", waitMs: 0 }, unasked.signal),
		);

		expect(went.body).toMatchObject({ outcome: "sent", guard: "unasked", sessionId: "s1" });
		expect(unasked.cards).toEqual([]);
		expect(held.body).toMatchObject({ outcome: "pending" });
		expect(asked.body).toMatchObject({ outcome: "pending" });
	});

	it("delivers an approved send once, and a session's end leaves an answer already underway to finish", async () => {
		const { guard, cards, sent, caller, signal, stepped } = bench();
		await stepped(guard.send(caller, { to: target, body: "a", waitMs: 0 }, signal));
		const requestId = cards[0]?.requestId ?? "";

		const approved = guard.answer(requestId, "approve");
		const twice = guard.answer(requestId, "approve");
		guard.sessionEnded(ASSISTANT_TEAM);
		const outcome = await guard.collect(ASSISTANT_TEAM, requestId, 1_000, signal);

		expect([approved.ok, twice]).toEqual([true, { ok: false, reason: "already answered" }]);
		expect(outcome.body).toMatchObject({ outcome: "sent", guard: "approved" });
		expect(sent).toEqual([{ key: requestId, guard: "approved" }]);
	});

	it("keeps a denial and a send open at a session's end collectable after it", async () => {
		const { guard, cards, caller, signal, stepped } = bench();
		await stepped(guard.send(caller, { to: target, body: "denied", waitMs: 0 }, signal));
		await stepped(guard.send(caller, { to: target, body: "open", waitMs: 0 }, signal));
		const [denied, open] = cards.map((card) => card.requestId);
		guard.answer(denied ?? "", "deny");

		guard.sessionEnded(ASSISTANT_TEAM);
		const afterDeny = await guard.collect(ASSISTANT_TEAM, denied ?? "", 0, signal);
		const afterOpen = await guard.collect(ASSISTANT_TEAM, open ?? "", 0, signal);

		expect(afterDeny.body).toEqual({ outcome: "denied" });
		expect(afterOpen.body).toMatchObject({ outcome: "failed" });
	});

	it("refuses a card it could not show as sent: a split label, files to a friend Domain, a body past the cap", async () => {
		const options: Parameters<typeof bench>[0] = {};
		const { guard, cards, caller, signal } = bench(options);
		const file = {
			filename: "a.txt",
			descriptiveKey: "a",
			mime: "text/plain",
			size: 1,
			role: "attachment" as const,
			blobId: `sha256-${"b".repeat(64)}`,
		};

		const label = await guard.send(caller, { to: target, body: "a", displayLabel: "One\nTwo" }, signal);
		const long = await guard.send(caller, { to: target, body: "x".repeat(40_000) }, signal);
		options.bindTarget = () => ({ ok: true, target: "friend.ume.host.w", friendDomain: "friend", exists: null });
		const friendFiles = await guard.send(caller, { to: "friend.ume.host.w", body: "a", files: [file] }, signal);

		expect([label.status, long.status, friendFiles.status]).toEqual([400, 413, 400]);
		expect(cards).toEqual([]);
	});

	it("joins an open card after the setting turns off, and fails the approval once its target is gone", async () => {
		let exists = true;
		const options: Parameters<typeof bench>[0] = { bindTarget: () => ({ ok: true, target, exists }) };
		const { guard, cards, sent, caller, signal, stepped } = bench(options);
		const first = await stepped(guard.send(caller, { to: target, body: "a", waitMs: 0 }, signal));
		options.approveEverySend = false;
		options.readsOwner = true;
		const retry = await stepped(
			guard.send({ ...caller, conversationId: "conv-b" }, { to: target, body: "a", waitMs: 0 }, signal),
		);
		const requestId = cards[0]?.requestId ?? "";
		exists = false;

		guard.answer(requestId, "approve");
		const outcome = await guard.collect(ASSISTANT_TEAM, requestId, 1_000, signal);

		expect(retry.body).toEqual(first.body);
		expect(cards).toHaveLength(1);
		expect(outcome.body).toMatchObject({ outcome: "failed" });
		expect(sent).toEqual([]);
	});

	it("delivers a joined send to the latest conversation", async () => {
		const { guard, cards, caller, signal, stepped, sentConversations } = bench();
		await stepped(guard.send(caller, { to: target, body: "a", waitMs: 0 }, signal));
		await stepped(
			guard.send({ ...caller, conversationId: "conv-b" }, { to: target, body: "a", waitMs: 0 }, signal),
		);
		const requestId = cards[0]?.requestId ?? "";

		guard.answer(requestId, "approve");
		const outcome = await guard.collect(ASSISTANT_TEAM, requestId, 1_000, signal);

		expect(outcome.body).toMatchObject({ outcome: "sent" });
		expect(sentConversations).toEqual(["conv-b"]);
	});
});
