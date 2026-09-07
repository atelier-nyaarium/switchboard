import { describe, expect, it } from "vitest";
import { processAmbient } from "../shared/ambient.js";
import { type JobContract, PendingJobStore, type WaitResult } from "../shared/pending-job-store.js";
import { Address, storeKey } from "../shared/session-id.js";

const DOMAIN = "bob";
const GW = "hostb";

function convKey(conv: string, spawn: string, session = "dev"): string {
	return storeKey({ kind: "conv", conversationId: conv, address: Address.of(DOMAIN, GW, spawn, session) });
}

function sessionTarget(spawn: string, session = "dev"): string {
	return Address.of(DOMAIN, GW, spawn, session).canonical;
}

function local(conv: string): JobContract {
	return { kind: "local", reply: { kind: "conversation", conversationId: conv } };
}

function outbound(conv: string, dstDomainId: string | null): JobContract {
	return { kind: "outbound", reply: { kind: "conversation", conversationId: conv }, dstDomainId };
}

function inbound(conv: string, id: string, dstDomainId: string | null, srcGateway = "alice-gw"): JobContract {
	return { kind: "inbound", route: { srcGateway, srcConversationId: conv, srcSession: id }, dstDomainId };
}

function anchor<T>(
	store: PendingJobStore<T>,
	id: string,
	contract: JobContract,
	opts: { persistent?: boolean; from?: string; to?: string } = {},
): void {
	const reserved = store.reserve(id, opts.from ?? "a", opts.to ?? "b", contract, {
		persistent: opts.persistent ?? false,
	});
	if (reserved.kind !== "ok") throw new Error(reserved.reason);
	store.commit(reserved.reservation);
}

// Contracts anchor routing.
describe("PendingJobStore.reserve", () => {
	it("refuses a contract whose reply names a different conversation than the key", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const result = store.reserve(convKey("c1", "lib"), "a", "b", local("c2"));
		expect(result.kind).toBe("conflict");
		expect(store.has(convKey("c1", "lib"))).toBe(false);
	});

	it("refuses a return route pointing at another session", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const id = convKey("c1", "lib");
		const forged = inbound("c1", convKey("c1", "docs"), "alice");
		expect(store.reserve(id, "a", "b", forged).kind).toBe("conflict");
	});

	it("refuses an id that is not a conversation session key", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		expect(store.reserve("not-a-key", "a", "b", local("c1")).kind).toBe("conflict");
	});

	it("refreshes an equal contract but refuses a different origin for the same session", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const id = convKey("c1", "lib");
		anchor(store, id, local("c1"), { persistent: true });

		const again = store.reserve(id, "a2", "b2", local("c1"), { persistent: true });
		expect(again.kind).toBe("ok");

		const owner = store.reserve(id, "a", "b", { kind: "local", reply: { kind: "owner", ownerId: "c1" } });
		expect(owner.kind).toBe("conflict");
		const remote = store.reserve(id, "a", "b", outbound("c1", "carol"));
		expect(remote.kind).toBe("conflict");
	});

	it("keeps the held contract when a conflicting reserve is refused", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const id = convKey("c1", "lib");
		anchor(store, id, outbound("c1", "alice"), { persistent: true });

		store.reserve(id, "a", "b", outbound("c1", "carol"));

		expect(store.expireByDomain("carol")).toBe(0);
		expect(store.expireByDomain("alice")).toBe(1);
	});

	it("drops an aborted anchor but keeps one another holder still needs", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const solo = convKey("c1", "lib");
		const shared = convKey("c2", "docs");

		const first = store.reserve(solo, "a", "b", local("c1"), { persistent: true });
		if (first.kind !== "ok") throw new Error(first.reason);
		store.abort(first.reservation);
		expect(store.has(solo)).toBe(false);

		const a = store.reserve(shared, "a", "b", local("c2"), { persistent: true });
		const b = store.reserve(shared, "a", "b", local("c2"), { persistent: true });
		if (a.kind !== "ok" || b.kind !== "ok") throw new Error("expected both reservations");
		store.abort(a.reservation);
		expect(store.has(shared)).toBe(true);
		store.commit(b.reservation);
		expect(store.has(shared)).toBe(true);
	});

	it("never discards a reply that landed before the abort", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const id = convKey("c1", "lib");
		const reserved = store.reserve(id, "a", "b", local("c1"), { persistent: true });
		if (reserved.kind !== "ok") throw new Error(reserved.reason);

		expect(store.settle(id, "answered")).not.toBe(false);
		store.abort(reserved.reservation);

		expect(store.poll(id)).toBe("answered");
	});
});

// Domain expiry leaves unrelated jobs untouched.
describe("PendingJobStore.expireByDomain", () => {
	it("notifies only for cross-Domain job lifecycle changes", () => {
		let changes = 0;
		const store = new PendingJobStore<string>(600_000, processAmbient(), () => changes++);
		const localId = convKey("c1", "lib");
		const remote = convKey("c2", "docs");
		const expired = convKey("c3", "app");

		anchor(store, localId, local("c1"), { persistent: true });
		anchor(store, remote, inbound("c2", remote, "alice"), { persistent: true });
		anchor(store, remote, inbound("c2", remote, "alice"), { persistent: true });
		store.remove(remote);

		anchor(store, expired, inbound("c3", expired, "alice"), { persistent: true });
		store.expireByDomain("alice");

		expect(changes).toBe(5);
	});

	it("settles only matching-dstDomainId jobs and returns the count", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const carol1 = convKey("c1", "lib");
		const carol2 = convKey("c2", "docs");
		const dave1 = convKey("c3", "app");
		const local1 = convKey("c4", "tools");
		anchor(store, carol1, outbound("c1", "carol"));
		anchor(store, carol2, outbound("c2", "carol"));
		anchor(store, dave1, outbound("c3", "dave"));
		anchor(store, local1, local("c4"));

		expect(store.expireByDomain("carol")).toBe(2);

		expect(store.has(carol1)).toBe(false);
		expect(store.has(carol2)).toBe(false);
		expect(store.has(dave1)).toBe(true);
		expect(store.has(local1)).toBe(true);
	});

	it("settles the waiting promise with a clear expiry error", async () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const carol = convKey("c1", "lib");
		anchor(store, carol, outbound("c1", "carol"));

		let settled: WaitResult<string> | null = null;
		const waiting = store.waitForResult(carol, 60_000).then((r) => {
			settled = r;
		});

		const count = store.expireByDomain("carol");
		await waiting;

		expect(count).toBe(1);
		expect(settled).toEqual({ delivered: false, error: "cross-domain link unlinked" });
	});

	it("uses a caller-supplied error message when given", async () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const carol = convKey("c1", "lib");
		anchor(store, carol, outbound("c1", "carol"));

		let settled: WaitResult<string> | null = null;
		const waiting = store.waitForResult(carol, 60_000).then((r) => {
			settled = r;
		});

		store.expireByDomain("carol", "Carol unlinked");
		await waiting;

		expect(settled).toEqual({ delivered: false, error: "Carol unlinked" });
	});

	it("leaves a same-Domain job's waiter untouched", async () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const carol = convKey("c1", "lib");
		const dave = convKey("c2", "docs");
		anchor(store, carol, outbound("c1", "carol"));
		anchor(store, dave, outbound("c2", "dave"));

		let daveSettled = false;
		store.waitForResult(dave, 60_000).then(() => {
			daveSettled = true;
		});

		store.expireByDomain("carol");
		await Promise.resolve();

		expect(daveSettled).toBe(false);
		expect(store.has(dave)).toBe(true);
		expect(store.settle(dave, "ok")).not.toBe(false);
	});

	it("returns 0 when no job is bound to the Domain", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const local1 = convKey("c1", "lib");
		const dave = convKey("c2", "docs");
		anchor(store, local1, local("c1"));
		anchor(store, dave, outbound("c2", "dave"));
		expect(store.expireByDomain("carol")).toBe(0);
		expect(store.has(local1)).toBe(true);
		expect(store.has(dave)).toBe(true);
	});

	it("expires a stored (not-yet-polled) cross-Domain job too", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const carolConv = convKey("c1", "lib");
		anchor(store, carolConv, outbound("c1", "carol"), { persistent: true });
		store.settle(carolConv, "hello");
		expect(store.expireByDomain("carol")).toBe(1);
		expect(store.has(carolConv)).toBe(false);
	});
});

// Session expiry matches canonical address and friend Domain.
describe("PendingJobStore.expireBySession", () => {
	function destJob(store: PendingJobStore<string>, conv: string, spawn: string, friendDomain: string): string {
		const id = convKey(conv, spawn);
		anchor(store, id, outbound(conv, friendDomain), { persistent: true, from: "alice.app", to: spawn });
		return id;
	}

	it("expires ONLY the matching (session, friend) jobs; other sessions and friends survive", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const libForAlice = destJob(store, "c1", "lib", "alice");
		const docsForAlice = destJob(store, "c2", "docs", "alice");
		const libForCarol = destJob(store, "c3", "lib", "carol");

		expect(store.expireBySession(sessionTarget("lib"), "alice")).toBe(1);

		expect(store.has(libForAlice)).toBe(false);
		expect(store.has(docsForAlice)).toBe(true);
		expect(store.has(libForCarol)).toBe(true);
	});

	it("settles a waiting reply for the un-shared session with a clear reason", async () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const id = destJob(store, "c1", "lib", "alice");

		let settled: WaitResult<string> | null = null;
		const waiting = store.waitForResult(id, 60_000).then((r) => {
			settled = r;
		});

		const count = store.expireBySession(sessionTarget("lib"), "alice");
		await waiting;

		expect(count).toBe(1);
		expect(settled).toEqual({ delivered: false, error: "cross-domain session unshared" });
	});

	it("does NOT match a job for the same session bound to a DIFFERENT friend Domain", async () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const id = destJob(store, "c1", "lib", "carol");

		let settled = false;
		store.waitForResult(id, 60_000).then(() => {
			settled = true;
		});

		expect(store.expireBySession(sessionTarget("lib"), "alice")).toBe(0);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(store.has(id)).toBe(true);
		expect(store.settle(id, "ok")).not.toBe(false);
	});

	it("ignores a local / same-Domain job for the same session name", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const localId = convKey("c1", "lib");
		anchor(store, localId, local("c1"), { from: "x", to: "lib" });
		expect(store.expireBySession(sessionTarget("lib"), "alice")).toBe(0);
		expect(store.has(localId)).toBe(true);
	});

	it("returns 0 when no job matches", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		destJob(store, "c1", "lib", "alice");
		expect(store.expireBySession(sessionTarget("ghost"), "alice")).toBe(0);
		expect(store.expireBySession(sessionTarget("lib"), "dave")).toBe(0);
	});
});
