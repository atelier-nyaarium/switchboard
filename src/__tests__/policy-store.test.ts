import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPolicyStore } from "../gateway/policies/store.js";
import {
	createRestoreRepairs,
	type DurableStore,
	DurableStoreInstalledError,
	openDurable,
} from "../shared/durable-store.js";
import {
	type AuthorizationPolicy,
	MAX_POLICIES_PER_GATEWAY,
	MAX_SELECTOR_LEN,
	MAX_SELECTORS_PER_POLICY,
} from "../shared/schemasPolicy.js";
import { REVISION_CEILING } from "../shared/schemasRunbook.js";

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
	openDurable(dataDir, "policies", (store) =>
		createPolicyStore({ store, repairs: createRestoreRepairs(), onChanged: (id) => moved.push(id) }),
	);

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
		expect(clash).toMatchObject({
			stored: false,
			refusal: { code: "taken", key: "sudo apt", policy: "Package administration" },
		});

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
		const moved = { refusal: { code: "moved" } };
		expect(store.put(policy("apt", { name: "Older" }), { base: 1 })).toMatchObject({
			stored: false,
			revision: 2,
			...moved,
		});
		expect(store.setEnabled("apt", false, 1)).toMatchObject({ stored: false, revision: 2, ...moved });
		expect(store.remove("apt", 1)).toMatchObject({ deleted: false, ...moved });
		const gone = { refusal: { code: "gone" } };
		expect(store.setEnabled("nobody", true, 1)).toMatchObject({ stored: false, ...gone });
		expect(store.remove("nobody", 1)).toMatchObject({ deleted: false, ...gone });
		expect(store.get("apt")?.name).toBe("Renamed");
		expect(store.remove("apt", 2)).toEqual({ deleted: true });
	});

	it("keeps a deleted id from a delayed put until a reopen", () => {
		const dataDir = fresh();
		const store = open(dataDir);
		store.put(policy("apt"));
		store.remove("apt", 1);
		expect(store.put(policy("apt"), { base: 1 })).toMatchObject({ stored: false, refusal: { code: "gone" } });
		expect(store.put(policy("apt"))).toMatchObject({ stored: false, refusal: { code: "deleted" } });
		expect(store.list()).toEqual([]);
		expect(open(dataDir).put(policy("apt"))).toMatchObject({ stored: true, revision: 1 });
	});

	it("names the typed command a refused edit is about, and keeps the held record", () => {
		const store = open(fresh());
		store.put(policy("apt", { selectorKeys: ["sudo apt", "sudo apt-get", "sudo install"] }));
		const edit = (selectorKeys: string[]) => store.put(policy("apt", { selectorKeys }), { base: 1 });

		expect(edit(["sudo apt", "sudo apt-get", "sudo install", "sudo apt mark"])).toMatchObject({
			stored: false,
			revision: 1,
			refusal: { code: "same_command", example: "sudo apt mark", key: "sudo apt" },
			// An older phone reads this.
			reason: expect.any(String),
		});
		expect(edit(["sudo apt install", "sudo apt remove"])).toMatchObject({
			refusal: { code: "same_command", example: "sudo apt remove", key: "sudo apt" },
		});
		expect(edit(["sudo apt", "   "])).toMatchObject({ refusal: { code: "no_command", example: "   " } });
		expect(edit([])).toMatchObject({ refusal: { code: "none" } });
		expect(store.get("apt")).toMatchObject({
			revision: 1,
			selectorKeys: ["sudo apt", "sudo apt-get", "sudo install"],
		});
	});

	it("refuses a policy past the Gateway's limit, and one with no revision left", () => {
		const dataDir = fresh();
		const store = open(dataDir);
		for (let n = 0; n < MAX_POLICIES_PER_GATEWAY; n++) store.put(policy(`p${n}`, { selectorKeys: [`sudo p${n}`] }));
		expect(store.put(policy("one-more", { selectorKeys: ["sudo more"] }))).toMatchObject({
			stored: false,
			refusal: { code: "full", max: MAX_POLICIES_PER_GATEWAY },
		});
		const commands = Array.from({ length: MAX_SELECTORS_PER_POLICY + 1 }, (_, n) => `sudo c${n}`);
		expect(store.put(policy("p0", { selectorKeys: commands }), { base: 1 })).toMatchObject({
			stored: false,
			refusal: { code: "too_many_commands", max: MAX_SELECTORS_PER_POLICY },
		});
		const longKey = `sudo -u root ${"x".repeat(MAX_SELECTOR_LEN)}`;
		expect(store.put(policy("p0", { selectorKeys: [longKey] }), { base: 1 })).toMatchObject({
			stored: false,
			refusal: { code: "command_too_long", max: MAX_SELECTOR_LEN },
		});
		expect(store.put(policy("p0", { name: "n".repeat(500) }), { base: 1 })).toMatchObject({
			stored: false,
			refusal: { code: "invalid" },
		});
		expect(open(dataDir).get("p0")).toMatchObject({ revision: 1 });

		fs.writeFileSync(
			path.join(dataDir, "policies.json"),
			JSON.stringify([policy("old", { selectorKeys: ["sudo old"], revision: REVISION_CEILING })]),
		);
		expect(open(dataDir).put(policy("old", { name: "again" }), { base: REVISION_CEILING })).toMatchObject({
			stored: false,
			refusal: { code: "spent" },
		});
	});

	it("starts fresh from a file a put could not have written", () => {
		const dataDir = fresh();
		const file = path.join(dataDir, "policies.json");
		const key = { selectorKeys: ["sudo apt"] };
		const poisoned = [
			[policy("a", key), policy("b", key)],
			[policy("a", key), policy("a", { name: "twice", selectorKeys: ["sudo rm"] })],
			Array.from({ length: 257 }, (_, i) => policy(`p${i}`, { selectorKeys: [`sudo p${i}`] })),
			[
				policy("a", {
					selectorKeys: Array.from({ length: MAX_SELECTORS_PER_POLICY + 1 }, (_, i) => `sudo c${i}`),
				}),
			],
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

	it("drops at restore only a key it cannot hold, never re-keys it, and writes the file back", () => {
		const dataDir = fresh();
		const file = path.join(dataDir, "policies.json");
		const longKey = `sudo -u root ${"x".repeat(MAX_SELECTOR_LEN)}`;
		const clean = policy("b", { selectorKeys: ["sudo rm"], revision: 4 });
		fs.writeFileSync(
			file,
			JSON.stringify([
				policy("a", { selectorKeys: ["sudo apt", "sudo -A apt-get", longKey], revision: 3 }),
				clean,
				policy("c", { selectorKeys: ["sudo apt install foo"] }),
			]),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const store = open(dataDir);

		// A stale save answers `moved`.
		const pruned = policy("a", { selectorKeys: ["sudo apt"], revision: 4 });
		expect(store.list()).toEqual([pruned, clean]);
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([pruned, clean]);
		expect(warn).toHaveBeenCalledTimes(2);
		warn.mockRestore();
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
		const store = createPolicyStore({
			store: durable,
			repairs: createRestoreRepairs(),
			onChanged: (id) => moved.push(id),
		});

		expect(store.put(policy("apt"))).toMatchObject({ stored: false, revision: 0, refusal: { code: "unwritten" } });
		expect(store.list()).toEqual([]);
		expect(moved).toEqual([]);

		fail = new DurableStoreInstalledError("installed");
		expect(store.put(policy("apt"))).toMatchObject({ stored: true, revision: 1 });
		expect(moved).toEqual(["apt"]);
	});

	it("keeps a landed write, and buries a landed delete, when the vault hook throws", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const dataDir = fresh();
		const hook = vi.fn(() => {
			throw new Error("vault gone");
		});
		const store = openDurable(dataDir, "policies", (durable) =>
			createPolicyStore({ store: durable, repairs: createRestoreRepairs(), onChanged: hook }),
		);

		expect(store.put(policy("apt"))).toMatchObject({ stored: true, revision: 1 });
		expect(store.get("apt")).toMatchObject({ revision: 1 });
		expect(store.remove("apt", 1)).toEqual({ deleted: true });
		expect(store.put(policy("apt"))).toMatchObject({ stored: false });
		expect(open(dataDir).list()).toEqual([]);
		expect(hook).toHaveBeenCalledTimes(2);
	});
});
