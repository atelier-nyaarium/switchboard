import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPolicyStore } from "../gateway/policies/store.js";
import { type DurableStore, DurableStoreInstalledError, openDurable } from "../shared/durable-store.js";
import type { AuthorizationPolicy } from "../shared/schemasPolicy.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fresh = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "policy-store-"));
	roots.push(root);
	return root;
};
const open = (dataDir: string, moved: string[] = []) =>
	openDurable(dataDir, "policies", (store) => createPolicyStore({ store, onChanged: (id) => moved.push(id) }));

const policy = (id: string, over: Partial<AuthorizationPolicy> = {}): AuthorizationPolicy => ({
	id,
	name: id,
	binding: { kind: "entry", entryId: "sudo-pw" },
	selectorKeys: ["sudo apt install foo"],
	enabled: true,
	revision: 1,
	...over,
});

describe("policy store", () => {
	it("stores keys, assigns the revision, echoes a repeat, and survives a reopen", () => {
		const dataDir = fresh();
		const moved: string[] = [];
		const store = open(dataDir, moved);
		const first = store.put(policy("apt", { revision: 97 }));
		expect(first).toMatchObject({ stored: true, revision: 1 });
		expect(first.policy?.selectorKeys).toEqual(["sudo apt"]);
		expect(store.put(policy("apt"))).toMatchObject({ stored: true, revision: 1 });

		expect(store.put(policy("apt", { name: "Renamed" }), { base: 1 })).toMatchObject({ stored: true, revision: 2 });
		expect(store.put(policy("apt", { name: "Renamed" }), { base: 1 })).toMatchObject({ stored: true, revision: 2 });
		expect(moved).toEqual(["apt", "apt"]);

		const reopened = open(dataDir);
		expect(reopened.byKey("sudo apt")?.name).toBe("Renamed");
		expect(reopened.byKey("sudo apt install foo")).toBeNull();
		expect(reopened.byKey("sudo")).toBeNull();
		expect(reopened.byKey("apt")).toBeNull();
		expect(reopened.byKey("Sudo apt")).toBeNull();
	});

	it("orders by name then id, and answers a no-op enable and an unknown id", () => {
		const store = open(fresh());
		store.put(policy("b", { name: "Zebra", selectorKeys: ["sudo b"] }));
		store.put(policy("a", { name: "Apple", selectorKeys: ["sudo a"] }));
		expect(store.list().map((row) => row.id)).toEqual(["a", "b"]);
		expect(store.setEnabled("a", true, 1)).toMatchObject({ stored: true, revision: 1 });
		expect(store.setEnabled("nobody", true, 1)).toMatchObject({ stored: false, revision: 0 });
		expect(Object.isFrozen(store.get("a")?.selectorKeys)).toBe(true);
	});

	it("refuses a second enabled holder of a key, and a disabled one frees it", () => {
		const store = open(fresh());
		store.put(policy("apt", { name: "Package administration" }));
		const clash = store.put(policy("other", { selectorKeys: ["sudo apt remove"] }));
		expect(clash.stored).toBe(false);
		expect(clash.reason).toContain("Package administration");

		expect(store.put(policy("other", { selectorKeys: ["sudo apt remove"], enabled: false }))).toMatchObject({
			stored: true,
		});
		expect(store.setEnabled("other", true, 1)).toMatchObject({ stored: false, revision: 1 });
		expect(store.setEnabled("apt", false, 1)).toMatchObject({ stored: true, revision: 2 });
		expect(store.setEnabled("other", true, 1)).toMatchObject({ stored: true, revision: 2 });
		expect(store.setEnabled("apt", true, 2)).toMatchObject({ stored: false, revision: 2 });
		expect(store.byKey("sudo apt")?.id).toBe("other");
	});

	it("refuses a stale base on put, enable and delete", () => {
		const store = open(fresh());
		store.put(policy("apt"));
		store.put(policy("apt", { name: "Renamed" }), { base: 1 });
		expect(store.put(policy("apt", { name: "Older" }), { base: 1 })).toMatchObject({ stored: false, revision: 2 });
		expect(store.setEnabled("apt", false, 1)).toMatchObject({ stored: false, revision: 2 });
		expect(store.remove("apt", 1)).toMatchObject({ deleted: false });
		expect(store.get("apt")?.name).toBe("Renamed");
		expect(store.remove("apt", 2)).toEqual({ deleted: true });
	});

	it("keeps a deleted id from a delayed put until a reopen", () => {
		const dataDir = fresh();
		const store = open(dataDir);
		store.put(policy("apt"));
		store.remove("apt", 1);
		expect(store.put(policy("apt"), { base: 1 })).toMatchObject({ stored: false });
		expect(store.put(policy("apt"))).toMatchObject({ stored: false });
		expect(store.list()).toEqual([]);
		expect(open(dataDir).put(policy("apt"))).toMatchObject({ stored: true, revision: 1 });
	});

	it("refuses an invalid edit and keeps the held record", () => {
		const store = open(fresh());
		store.put(policy("apt"));
		expect(store.put(policy("apt", { selectorKeys: ["   "] }), { base: 1 })).toMatchObject({ stored: false });
		expect(
			store.put(policy("apt", { selectorKeys: ["sudo apt install", "sudo apt remove"] }), { base: 1 }),
		).toMatchObject({ stored: false });
		expect(store.get("apt")).toMatchObject({ revision: 1, selectorKeys: ["sudo apt"] });
	});

	it("starts fresh from a file a put could not have written", () => {
		const dataDir = fresh();
		const file = path.join(dataDir, "policies.json");
		const key = { selectorKeys: ["sudo apt"] };
		const poisoned = [
			[policy("a", key), policy("b", key)],
			[policy("a", key), policy("a", { name: "twice", selectorKeys: ["sudo rm"] })],
			[policy("a")],
			Array.from({ length: 257 }, (_, i) => policy(`p${i}`, { selectorKeys: [`sudo p${i}`] })),
		];
		for (const records of poisoned) {
			fs.writeFileSync(file, JSON.stringify(records));
			const store = open(dataDir);
			expect(store.list()).toEqual([]);
			expect(store.put(policy("kept"))).toMatchObject({ stored: true, revision: 1 });
			const healed = open(dataDir).list();
			expect(healed.map((row) => row.id)).toEqual(["kept"]);
		}
	});

	it("reports a refused disk write and accepts an installed snapshot", () => {
		const moved: string[] = [];
		let fail: Error | null = new Error("disk full");
		const durable = {
			load: () => null,
			saveChecked: () => {
				if (fail) throw fail;
			},
		} as unknown as DurableStore;
		const store = createPolicyStore({ store: durable, onChanged: (id) => moved.push(id) });

		expect(store.put(policy("apt"))).toMatchObject({ stored: false, revision: 0 });
		expect(store.list()).toEqual([]);
		expect(moved).toEqual([]);

		fail = new DurableStoreInstalledError("installed");
		expect(store.put(policy("apt"))).toMatchObject({ stored: true, revision: 1 });
		expect(moved).toEqual(["apt"]);
	});
});
