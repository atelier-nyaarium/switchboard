import { describe, expect, it } from "vitest";
import { createOriginMarker, createSendGuard } from "../gateway/assistant/sendGuard.js";
import { createOwnerRequests } from "../gateway/ownerRequests.js";
import type { BoundTarget, SendRecord } from "../gateway/routes/routesSend.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import type { PendingDelivery } from "../shared/pending-delivery-store.js";
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
	it("reads the owner only while the newest acceptance it saw was the owner's", () => {
		const marker = createOriginMarker();
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
		const marker = createOriginMarker(10);
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
		const staged = new Map<string, number>();
		const guard = createSendGuard({
			ambient,
			approveEverySend: () => options.approveEverySend ?? true,
			readsOwner: () => options.readsOwner ?? false,
			routes: () => ({
				bindTarget: (to): BoundTarget => options.bindTarget?.(to) ?? { ok: true, target, exists: true },
				sendFromAssistant: async ({ record }) => {
					sent.push(record);
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
		return { ambient, guard, cards, retracts, sent, staged, caller, signal, stepped };
	}

	it("lapses an unanswered send at its deadline, retracting the card and still answering a late collect", async () => {
		const { ambient, guard, cards, retracts, sent, caller, signal, stepped } = bench();
		const pending = await stepped(guard.send(caller, { to: target, body: "hi", waitMs: 0 }, signal));
		const requestId = cards[0]?.requestId ?? "";
		await ambient.advance(VAULT_REQUEST_DEADLINE_MS + 60_000);
		const late = await guard.collect(ASSISTANT_TEAM, requestId, 0, signal);

		expect(pending.body).toMatchObject({ outcome: "pending", requestId });
		expect(late.body).toEqual({ outcome: "expired" });
		expect(guard.answer(requestId, "approve")).toMatchObject({ ok: false });
		expect(retracts).toEqual([requestId]);
		expect(sent).toEqual([]);
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
		staged.set(blobId, 6);

		guard.answer(requestId, "approve");
		const outcome = await guard.collect(ASSISTANT_TEAM, requestId, 1_000, signal);

		expect(outcome.body).toMatchObject({ outcome: "failed" });
		expect(sent).toEqual([]);
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
});

describe("owner requests read past their deadline", () => {
	it("settles on the read and keeps the lapse for a collect until its hold ends", async () => {
		let clock = 1_000;
		const ambient = fakeAmbient({ drive: "manual", now: () => clock });
		const core = createOwnerRequests<{ requestId: string; sessionTarget: string; deadlineAt: number }, string>({
			ambient,
			deadlineMs: 60_000,
			maxOpenPerTarget: 8,
			deliver: () => true,
			lapsed: (why) => why,
			holdSettledMs: 600_000,
		});
		const opened = core.open({
			sessionTarget: "host.a",
			build: (requestId, deadlineAt) => ({ requestId, sessionTarget: "host.a", deadlineAt }),
		});
		if (opened.kind !== "opened") throw new Error("not opened");
		const { requestId } = opened.request;
		clock += 61_000;

		const live = core.live(requestId);
		const collected = await core.collect(requestId, "host.a")?.answer;
		const answered = core.answered(requestId);
		clock += 600_000;
		const afterHold = core.collect(requestId, "host.a");

		expect([live, collected, answered, afterHold]).toEqual([null, "expired", false, undefined]);
	});
});

describe("owner requests across a restart", () => {
	it("retracts what an earlier process left open, keeping a stub whose retraction did not queue", () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
		let saved: unknown = null;
		const ledger = {
			load: () => saved,
			save: (state: unknown) => {
				saved = state;
			},
		};
		let queues = true;
		const build = () =>
			createOwnerRequests<{ requestId: string; sessionTarget: string; deadlineAt: number }, string>({
				ambient,
				deadlineMs: 60_000,
				maxOpenPerTarget: 8,
				deliver: () => true,
				lapsed: (why) => why,
				onSettled: () => queues,
				ledger,
			});
		const before = build();
		const open = (target: string) =>
			before.open({
				sessionTarget: target,
				build: (requestId, deadlineAt) => ({ requestId, sessionTarget: target, deadlineAt }),
			});
		const kept = open("host.a");
		const answered = open("host.b");
		const unretracted = open("host.c");
		if (kept.kind !== "opened" || answered.kind !== "opened" || unretracted.kind !== "opened") {
			throw new Error("not opened");
		}
		before.settle(answered.request.requestId, "done");
		queues = false;
		before.settle(unretracted.request.requestId, "done");

		const after = build();
		const tried: string[] = [];
		after.retractStale((stub) => Boolean(tried.push(stub.requestId)) && false);
		after.retractStale((stub) => Boolean(tried.push(stub.requestId)));
		after.retractStale((stub) => Boolean(tried.push(stub.requestId)));

		const twice = [kept.request.requestId, unretracted.request.requestId];
		expect(tried.sort()).toEqual([...twice, ...twice].sort());
	});
});
