import { describe, expect, it } from "vitest";
import type { VaultClient } from "../gateway/router/vaultClient.js";
import { createVaultReconcile } from "../gateway/vault/reconcile.js";
import { createVaultRequests } from "../gateway/vault/requests.js";
import type { VaultUse } from "../gateway/vault/vaultUse.js";
import type { AuthorizationPolicy } from "../shared/schemasPolicy.js";
import type { VaultRequest } from "../shared/schemasVault.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const client = {} as VaultClient;

const policy = (key: string, over: Partial<AuthorizationPolicy> = {}): AuthorizationPolicy => ({
	id: "sudo",
	name: "Sudo",
	binding: { kind: "entry", entryId: "pw" },
	selectorKeys: [key],
	enabled: true,
	revision: 1,
	...over,
});

function bench() {
	const ambient = fakeAmbient({ drive: "manual", now: () => 1_000_000 });
	const delivered: VaultRequest[] = [];
	const requests = createVaultRequests({
		ambient,
		deliver: (request) => Boolean(delivered.push(request)),
		openTyped: () => null,
	});
	let policies: AuthorizationPolicy[] = [];
	const unusable = new Set<string>();
	let reads = 0;
	let ready = true;
	let held: VaultClient | null = client;
	let gate: Promise<void> = Promise.resolve();
	const use: Pick<VaultUse, "ready" | "usable"> = {
		ready: async () => {
			reads += 1;
			await gate;
			return ready ? { kind: "ready", client } : { kind: "unready", reason: "the Router cannot be reached" };
		},
		usable: (_client, entryId) =>
			unusable.has(entryId)
				? { kind: "unusable", code: "not_allowed", reason: "not here", status: 403 }
				: ({ kind: "usable" } as ReturnType<VaultUse["usable"]>),
	};
	const reconciler = createVaultReconcile({
		requests,
		policies: () => ({
			get: (id) => policies.find((held) => held.id === id) ?? null,
			byKey: (key) => policies.find((held) => held.enabled && held.selectorKeys.includes(key)) ?? null,
		}),
		use,
		heldClient: () => held,
		covers: () => null,
	});
	const typed = (operation: string) => {
		const opened = requests.open({ kind: "typed", operation, sessionTarget: "host.carol" });
		if (opened.kind !== "opened") throw new Error("the request did not open");
		return opened;
	};
	return {
		requests,
		reconciler,
		delivered,
		typed,
		unusable,
		reads: () => reads,
		setPolicies: (next: AuthorizationPolicy[]) => {
			policies = next;
		},
		setReady: (next: boolean) => {
			ready = next;
		},
		setHeld: (next: VaultClient | null) => {
			held = next;
		},
		hold: () => {
			let release: () => void = () => undefined;
			gate = new Promise((resolve) => {
				release = resolve;
			});
			return () => {
				release();
				gate = Promise.resolve();
			};
		},
	};
}

describe("vault reconcile", () => {
	it("reads the vault only when a waiting key has a policy, and tries a kept takeover again", async () => {
		const { reconciler, typed, reads, setPolicies, setReady, delivered } = bench();
		const waiting = typed("sudo foo x");
		for (let tick = 0; tick < 3; tick++) reconciler.reconcile();
		await reconciler.settled();
		expect(reads()).toBe(0);

		setPolicies([policy("sudo foo")]);
		setReady(false);
		reconciler.reconcile();
		await reconciler.settled();
		expect(reads()).toBe(1);
		expect(delivered).toHaveLength(1);

		setReady(true);
		reconciler.reconcile();
		await reconciler.settled();
		await expect(waiting.answer).resolves.toMatchObject({ kind: "moved" });
		expect(delivered.at(-1)).toMatchObject({ kind: "entry", replaces: waiting.request.requestId });
	});

	it("reads nothing for a request whose entry the held copy calls unusable, until a read lands", async () => {
		const { reconciler, typed, reads, setPolicies, unusable } = bench();
		const waiting = typed("sudo foo x");
		setPolicies([policy("sudo foo")]);
		unusable.add("pw");
		for (let tick = 0; tick < 3; tick++) reconciler.reconcile();
		await reconciler.settled();
		expect(reads()).toBe(0);

		unusable.clear();
		reconciler.landed();
		await reconciler.settled();
		expect(reads()).toBe(1);
		await expect(waiting.answer).resolves.toMatchObject({ kind: "moved" });
	});

	it("restates an entry request a policy still selects, and refuses one only on a reading", async () => {
		const { requests, reconciler, unusable, setPolicies, setHeld } = bench();
		const open = (operation: string) => {
			const opened = requests.open({
				kind: "entry",
				entryId: "pw",
				operation,
				sessionTarget: "host.carol",
				policy: { policyId: "sudo", policyRevision: 1 },
			});
			if (opened.kind !== "opened") throw new Error("the request did not open");
			return opened;
		};
		const kept = open("sudo foo x");
		setPolicies([policy("sudo foo", { revision: 2 })]);
		setHeld(null);
		reconciler.reconcile();
		const revised = {
			kind: "entry" as const,
			entryId: "pw",
			operation: "sudo foo x",
			sessionTarget: "host.carol",
			policy: { policyId: "sudo", policyRevision: 2 },
		};
		expect(requests.find(revised)?.request.requestId).toBe(kept.request.requestId);

		setHeld(client);
		unusable.add("pw");
		setPolicies([policy("sudo foo", { revision: 3 })]);
		reconciler.reconcile();
		await expect(kept.answer).resolves.toMatchObject({ kind: "refused" });

		unusable.clear();
		const dropped = open("sudo foo y");
		setPolicies([policy("sudo bar", { revision: 4 })]);
		reconciler.reconcile();
		await expect(dropped.answer).resolves.toMatchObject({ kind: "refused" });
	});

	it("takes nothing over once stopped, even a pass already reading", async () => {
		const { requests, reconciler, typed, setPolicies, hold, delivered } = bench();
		const waiting = typed("sudo foo x");
		setPolicies([policy("sudo foo")]);
		const release = hold();
		reconciler.reconcile();
		reconciler.stop();
		release();
		await reconciler.settled();
		expect(delivered).toHaveLength(1);
		reconciler.reconcile();
		await reconciler.settled();
		expect(delivered).toHaveLength(1);
		expect(requests.typedLive(waiting.request.requestId)).toMatchObject({ kind: "typed" });
	});
});
