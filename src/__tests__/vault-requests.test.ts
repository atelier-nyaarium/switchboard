import { describe, expect, it } from "vitest";
import type { GrantScope } from "../gateway/vault/decisions.js";
import { createVaultRequests, MAX_OPEN_PER_TARGET } from "../gateway/vault/requests.js";
import type { ContentEnvelope } from "../shared/schemasContentKey.js";
import { VAULT_REQUEST_DEADLINE_MS, type VaultRequest } from "../shared/schemasVault.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const envelope = (text: string): ContentEnvelope => ({ v: 1, epoch: 1, nonce: "AAAA", ciphertext: text });

function bench(options: { deliverable?: boolean; validate?: (scope: GrantScope) => string | null } = {}) {
	const ambient = fakeAmbient({ drive: "manual", now: () => 1_000_000 });
	const delivered: VaultRequest[] = [];
	const approved: Array<{ sessionTarget: string; entryId: string; decision: string; policyId?: string }> = [];
	const settled: string[] = [];
	const requests = createVaultRequests({
		ambient,
		deliver: (request) => {
			if (options.deliverable === false) return false;
			delivered.push(request);
			return true;
		},
		openTyped: (value, requestId) => (value.ciphertext === `typed:${requestId}` ? "hunter2" : null),
		validate: options.validate,
		onApproved: (scope, decision) =>
			approved.push({
				sessionTarget: scope.sessionTarget,
				entryId: scope.entryId,
				decision,
				...(scope.policy ? { policyId: scope.policy.policyId } : {}),
			}),
		onSettled: (request) => Boolean(settled.push(request.requestId)),
	});
	return { ambient, requests, delivered, approved, settled };
}

describe("vault requests", () => {
	it("opens as a request row, answers once, and refuses the second tap", async () => {
		const { requests, delivered, approved } = bench();
		const opened = requests.open({
			kind: "entry",
			entryId: "deploy",
			operation: "ssh deploy@prod",
			sessionTarget: "host.alice",
		});
		if (opened.kind !== "opened") throw new Error("the request did not open");
		expect(delivered[0]).toMatchObject({
			v: 1,
			kind: "entry",
			entryId: "deploy",
			displayShape: "ssh deploy@prod",
			coveredShapes: ["ssh deploy@prod"],
			sessionTarget: "host.alice",
			deadlineAt: 1_000_000 + VAULT_REQUEST_DEADLINE_MS,
		});
		expect(requests.answer(opened.request.requestId, "window")).toEqual({ ok: true });
		await expect(opened.answer).resolves.toEqual({
			kind: "approved",
			decision: "window",
			source: { kind: "entry", entryId: "deploy" },
		});
		expect(approved).toEqual([{ sessionTarget: "host.alice", entryId: "deploy", decision: "window" }]);
		expect(requests.answer(opened.request.requestId, "deny")).toMatchObject({
			ok: false,
			refusal: { code: "answered" },
		});
		expect(requests.answer("unknown", "once")).toMatchObject({ ok: false, refusal: { code: "expired" } });
	});

	it("a deny and the deadline both refuse, and an undeliverable row never opens", async () => {
		const { ambient, requests, delivered, settled } = bench();
		const denied = requests.open({
			kind: "entry",
			entryId: "deploy",
			operation: "ssh deploy@prod",
			sessionTarget: "host.alice",
		});
		const expired = requests.open({
			kind: "typed",
			operation: "sudo apt install foo",
			sessionTarget: "host.carol",
		});
		if (denied.kind !== "opened" || expired.kind !== "opened") throw new Error("the requests did not open");
		expect(requests.answer(denied.request.requestId, "deny", undefined, "use the deploy user")).toEqual({
			ok: true,
		});
		await expect(denied.answer).resolves.toEqual({ kind: "refused", note: "use the deploy user" });

		await ambient.advance(VAULT_REQUEST_DEADLINE_MS + 1);
		await expect(expired.answer).resolves.toEqual({ kind: "refused" });
		expect(requests.collect(expired.request.requestId, "host.carol")).toBeUndefined();
		expect(delivered).toHaveLength(2);
		// Each settlement retracts once, whichever road it took.
		expect(settled).toEqual([denied.request.requestId, expired.request.requestId]);
		requests.answer(denied.request.requestId, "deny");
		expect(settled).toHaveLength(2);

		const undeliverable = bench({ deliverable: false }).requests.open({
			kind: "entry",
			entryId: "deploy",
			operation: "ssh deploy@prod",
			sessionTarget: "host.alice",
		});
		expect(undeliverable).toEqual({ kind: "undeliverable", reason: "unreachable" });
	});

	it("an answer waits to be collected until the deadline, and a session's end drops its requests", async () => {
		const { ambient, requests } = bench();
		const opened = requests.open({
			kind: "entry",
			entryId: "deploy",
			operation: "ssh prod",
			sessionTarget: "host.alice",
		});
		if (opened.kind !== "opened") throw new Error("the request did not open");
		const { requestId } = opened.request;
		expect(requests.answer(requestId, "once")).toEqual({ ok: true });
		await ambient.advance(VAULT_REQUEST_DEADLINE_MS - 1);
		expect(requests.collect(requestId, "host.alice")?.request.requestId).toBe(requestId);
		await ambient.advance(2);
		expect(requests.collect(requestId, "host.alice")).toBeUndefined();

		const late = requests.open({
			kind: "entry",
			entryId: "deploy",
			operation: "ssh prod",
			sessionTarget: "host.alice",
		});
		const ended = requests.open({
			kind: "entry",
			entryId: "deploy",
			operation: "ssh prod",
			sessionTarget: "host.carol",
		});
		if (late.kind !== "opened" || ended.kind !== "opened") throw new Error("the requests did not open");
		requests.sessionEnded("host.carol");
		await expect(ended.answer).resolves.toEqual({ kind: "refused" });
		expect(requests.collect(ended.request.requestId, "host.carol")).toBeUndefined();
		expect(requests.collect(late.request.requestId, "host.alice")).toBeDefined();
	});

	it("a typed request needs a value sealed to it, and collect answers only the asking session", async () => {
		const { requests, approved } = bench();
		const typed = requests.open({ kind: "typed", operation: "sudo apt install foo", sessionTarget: "host.carol" });
		if (typed.kind !== "opened") throw new Error("the request did not open");
		const { requestId } = typed.request;
		expect(typed.request).toMatchObject({ displayShape: "sudo apt", coveredShapes: ["apt install"] });
		expect(requests.answer(requestId, "once")).toMatchObject({ ok: false });
		expect(requests.answer(requestId, "once", envelope("typed:other"))).toMatchObject({ ok: false });
		expect(requests.collect(requestId, "host.alice")).toBeUndefined();
		expect(requests.collect(requestId, "host.carol")?.request.requestId).toBe(requestId);
		// A typed value is once, whatever tier the phone named.
		expect(requests.answer(requestId, "session", envelope(`typed:${requestId}`))).toEqual({ ok: true });
		await expect(typed.answer).resolves.toEqual({
			kind: "approved",
			decision: "once",
			source: { kind: "typed", value: "hunter2" },
		});
		// Typed values never grant.
		expect(approved).toEqual([]);
		expect(requests.take(requestId)).toBe(true);
		expect(requests.take(requestId)).toBe(false);
		expect(requests.collect(requestId, "host.carol")).toBeUndefined();
	});

	it("a typed request answered from an entry grants that entry under the policy, and only once", async () => {
		const { requests, approved, delivered } = bench();
		const typed = requests.open({
			kind: "typed",
			operation: "sudo apt-mark hold foo",
			sessionTarget: "host.carol",
			why: { code: "no_policy" },
			runsAnything: true,
		});
		const entry = requests.open({
			kind: "entry",
			entryId: "deploy",
			operation: "ssh x",
			sessionTarget: "host.carol",
		});
		if (typed.kind !== "opened" || entry.kind !== "opened") throw new Error("the requests did not open");
		expect(delivered[0]).toMatchObject({ kind: "typed", why: { code: "no_policy" }, runsAnything: true });
		const policy = { policyId: "apt", policyRevision: 2 };

		expect(requests.claimTyped(entry.request.requestId)).toEqual({ code: "not_typed" });
		const claimed = requests.claimTyped(typed.request.requestId);
		if ("code" in claimed) throw new Error("the request was not claimed");
		expect(requests.claimTyped(typed.request.requestId)).toEqual({ code: "answered" });
		expect(requests.answerEntry(claimed, "window", "sudo-pass", policy)).toBeNull();
		await expect(typed.answer).resolves.toEqual({
			kind: "approved",
			decision: "window",
			source: { kind: "entry", entryId: "sudo-pass" },
		});
		expect(approved).toEqual([
			{ sessionTarget: "host.carol", entryId: "sudo-pass", decision: "window", policyId: "apt" },
		]);
		expect(requests.claimTyped(typed.request.requestId)).toEqual({ code: "answered" });
		expect(requests.claimTyped("unknown")).toEqual({ code: "expired" });
		expect(approved).toHaveLength(1);
	});

	it("reads a claimed request's life once: answered past its deadline, or lapsed once given back", async () => {
		const { ambient, requests } = bench();
		const open = (operation: string) => {
			const opened = requests.open({ kind: "typed", operation, sessionTarget: "host.carol" });
			if (opened.kind !== "opened") throw new Error("the request did not open");
			return opened;
		};
		const kept = open("sudo foo x");
		const given = open("sudo bar y");
		const claimedKept = requests.claimTyped(kept.request.requestId);
		const claimedGiven = requests.claimTyped(given.request.requestId);
		if ("code" in claimedKept || "code" in claimedGiven) throw new Error("the requests were not claimed");

		// Deadline passes mid-answer.
		await ambient.advance(VAULT_REQUEST_DEADLINE_MS + 1);
		expect(requests.answerEntry(claimedKept, "once", "pw")).toBeNull();
		await expect(kept.answer).resolves.toMatchObject({ kind: "approved", source: { entryId: "pw" } });

		requests.unclaim(given.request.requestId);
		await ambient.advance(1);
		await expect(given.answer).resolves.toEqual({ kind: "refused" });
	});

	it("only the opener withdraws, an answer already given stands, and a late answer grants nothing", async () => {
		const { requests, approved, settled } = bench();
		const open = (sessionTarget: string) => {
			const opened = requests.open({
				kind: "entry",
				entryId: "deploy",
				operation: "ssh deploy@prod",
				sessionTarget,
			});
			if (opened.kind !== "opened") throw new Error("the request did not open");
			return opened;
		};
		const withdrawn = open("host.carol");
		expect(requests.withdraw(withdrawn.request.requestId, "host.alice")).toBe(false);
		expect(requests.withdraw(withdrawn.request.requestId, "host.carol")).toBe(true);
		await expect(withdrawn.answer).resolves.toEqual({ kind: "refused" });
		expect(settled).toEqual([withdrawn.request.requestId]);
		expect(requests.answer(withdrawn.request.requestId, "session")).toMatchObject({ ok: false });
		expect(approved).toEqual([]);

		const answered = open("host.carol");
		expect(requests.answer(answered.request.requestId, "window")).toEqual({ ok: true });
		expect(requests.withdraw(answered.request.requestId, "host.carol")).toBe(false);
		expect(requests.collect(answered.request.requestId, "host.carol")?.request.requestId).toBe(
			answered.request.requestId,
		);
	});

	it("a retry finds the request still open for the same asker, entry, and operation, and nothing else", async () => {
		const { requests } = bench();
		const input = { kind: "entry" as const, entryId: "deploy", operation: "ssh prod", sessionTarget: "host.alice" };
		expect(requests.find(input)).toBeUndefined();
		const opened = requests.open(input);
		if (opened.kind !== "opened") throw new Error("the request did not open");
		expect(requests.find(input)?.request.requestId).toBe(opened.request.requestId);
		expect(requests.find({ ...input, operation: "ssh prod ls" })).toBeUndefined();
		expect(requests.find({ ...input, sessionTarget: "host.bob" })).toBeUndefined();
		expect(requests.find({ ...input, entryId: "other" })).toBeUndefined();
		expect(requests.find({ ...input, policy: { policyId: "apt", policyRevision: 1 } })).toBeUndefined();
		requests.answer(opened.request.requestId, "once");
		expect(requests.find(input)).toBeUndefined();
	});

	it("a request resolved through a policy is validated at the tap, and a policy that moved refuses it", async () => {
		let refusal: string | null = null;
		const { requests, approved, delivered } = bench({ validate: () => refusal });
		const input = {
			kind: "entry" as const,
			entryId: "deploy",
			operation: "ssh prod",
			sessionTarget: "host.alice",
			policy: { policyId: "apt", policyRevision: 1 },
		};
		const first = requests.open(input);
		if (first.kind !== "opened") throw new Error("the request did not open");
		expect(delivered[0]).toMatchObject({ policy: { policyId: "apt", policyRevision: 1 } });
		expect(requests.find(input)?.request.requestId).toBe(first.request.requestId);
		expect(requests.find({ ...input, policy: { policyId: "apt", policyRevision: 2 } })).toBeUndefined();

		refusal = "the policy changed";
		expect(requests.answer(first.request.requestId, "window")).toEqual({ ok: false, reason: "the policy changed" });
		await expect(first.answer).resolves.toEqual({ kind: "refused", note: "the policy changed" });
		expect(approved).toEqual([]);

		refusal = null;
		const second = requests.open(input);
		const bare = requests.open({
			kind: "entry",
			entryId: "deploy",
			operation: "ssh prod",
			sessionTarget: "host.bob",
		});
		const still = requests.open({ ...input, sessionTarget: "host.carol" });
		if (second.kind !== "opened" || bare.kind !== "opened" || still.kind !== "opened")
			throw new Error("the requests did not open");
		// Selects carol's line, not alice's.
		requests.reviseEntries((request) => (request.sessionTarget === "host.carol" ? { revision: 2 } : "refuse"));
		await expect(second.answer).resolves.toMatchObject({ kind: "refused" });
		expect(requests.collect(second.request.requestId, "host.alice")).toBeUndefined();
		expect(requests.collect(bare.request.requestId, "host.bob")).toBeDefined();
		expect(requests.answer(bare.request.requestId, "window")).toEqual({ ok: true });
		const revised = { ...input, sessionTarget: "host.carol", policy: { policyId: "apt", policyRevision: 2 } };
		expect(requests.find(revised)?.request.requestId).toBe(still.request.requestId);
		expect(requests.answer(still.request.requestId, "window")).toEqual({ ok: true });
		expect(approved).toEqual([
			{ sessionTarget: "host.bob", entryId: "deploy", decision: "window" },
			{ sessionTarget: "host.carol", entryId: "deploy", decision: "window", policyId: "apt" },
		]);
	});

	it("a policy takes over a typed request under its deadline, or answers it from a covering grant", async () => {
		const { ambient, requests, delivered } = bench();
		const policy = { policyId: "foo", policyRevision: 1 };
		const typed = (operation: string, sessionTarget = "host.carol") => {
			const opened = requests.open({ kind: "typed", operation, sessionTarget });
			if (opened.kind !== "opened") throw new Error("the request did not open");
			return opened;
		};
		const moving = typed("sudo foo x");
		await ambient.advance(60_000);

		expect(requests.takeOver(moving.request.requestId, "pw", policy, () => null)).toBe("moved");
		const takeover = delivered.at(-1);
		expect(takeover).toMatchObject({
			kind: "entry",
			entryId: "pw",
			replaces: moving.request.requestId,
			deadlineAt: moving.request.deadlineAt,
			policy,
		});
		await expect(moving.answer).resolves.toEqual({
			kind: "moved",
			requestId: takeover?.requestId,
			deadlineAt: moving.request.deadlineAt,
		});
		expect(requests.claimTyped(moving.request.requestId)).toEqual({ code: "answered" });

		const covered = typed("sudo bar y");
		expect(requests.takeOver(covered.request.requestId, "pw", policy, () => "session")).toBe("covered");
		await expect(covered.answer).resolves.toMatchObject({
			kind: "approved",
			decision: "session",
			source: { kind: "entry", entryId: "pw" },
		});

		const crowded = Array.from({ length: MAX_OPEN_PER_TARGET }, (_, i) => typed(`sudo c${i} z`, "host.dan"));
		const first = crowded[0]?.request.requestId ?? "";
		expect(requests.takeOver(first, "pw", policy, () => null)).toBe("moved");
		expect(requests.open({ kind: "typed", operation: "sudo more", sessionTarget: "host.dan" })).toMatchObject({
			kind: "undeliverable",
			reason: "flooded",
		});

		const replacement = delivered.at(-1)?.requestId ?? "";
		expect(requests.withdraw(first, "host.dan")).toBe(true);
		expect(requests.collect(replacement, "host.dan")).toBeUndefined();
	});

	it("one caller cannot bury the phone: past the cap the request does not open", () => {
		const { requests, delivered } = bench();
		const open = (operation: string, sessionTarget = "host.alice") =>
			requests.open({ kind: "entry", entryId: "deploy", operation, sessionTarget });
		for (let i = 0; i < MAX_OPEN_PER_TARGET; i += 1) expect(open(`ssh prod ${i}`).kind).toBe("opened");
		expect(open("ssh prod over")).toEqual({ kind: "undeliverable", reason: "flooded" });
		// The cap is per caller, and answering one makes room again.
		expect(open("ssh prod other", "host.bob").kind).toBe("opened");
		requests.answer(delivered[0].requestId, "once");
		expect(open("ssh prod again").kind).toBe("opened");
	});
});
