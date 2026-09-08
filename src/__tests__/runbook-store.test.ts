import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunbookStore } from "../gateway/runbooks/store.js";
import { openDurable } from "../shared/durable-store.js";
import type { Runbook } from "../shared/schemasRunbook.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fresh = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "runbook-store-"));
	roots.push(root);
	return root;
};
const open = (dataDir: string) => openDurable(dataDir, "runbooks", (store) => createRunbookStore({ store }));

const book = (id: string, over: Partial<Runbook> = {}): Runbook => ({
	id,
	name: id,
	body: "release {{level}}",
	parameters: [{ name: "level", label: "Level", kind: "text" }],
	revision: 1,
	...over,
});

describe("runbook store", () => {
	it("holds what the phone pushed and gives it back across a reopen", () => {
		const dataDir = fresh();
		const store = open(dataDir);
		expect(store.put(book("deploy"))).toMatchObject({ stored: true, revision: 1 });
		expect(store.get("deploy")?.body).toBe("release {{level}}");
		expect(
			open(dataDir)
				.list()
				.map((r) => r.id),
		).toEqual(["deploy"]);
	});

	it("orders by name, then by id so a shared name still gives one order", () => {
		const store = open(fresh());
		store.put(book("b", { name: "Zebra" }));
		store.put(book("a", { name: "Apple" }));
		store.put(book("c", { name: "Apple" }));
		expect(store.list().map((r) => r.id)).toEqual(["a", "c", "b"]);
	});

	it("names the revision itself, whatever the caller sent", () => {
		const store = open(fresh());
		// A first write lands at 1, not at the number the caller happened to carry.
		expect(store.put(book("deploy", { revision: 97 }))).toMatchObject({ stored: true, revision: 1 });
		expect(store.get("deploy")?.revision).toBe(1);

		expect(store.put(book("deploy", { revision: 97, body: "two {{level}}" }), { base: 1 })).toMatchObject({
			stored: true,
			revision: 2,
		});
		expect(store.get("deploy")?.body).toBe("two {{level}}");
	});

	it("takes a put only from the revision it holds", () => {
		const store = open(fresh());
		store.put(book("deploy", { body: "one {{level}}" }));
		store.put(book("deploy", { body: "two {{level}}" }), { base: 1 });

		// Editing a revision that has moved on cannot land, whichever way it moved.
		expect(store.put(book("deploy", { body: "other {{level}}" }), { base: 1 })).toMatchObject({
			stored: false,
			revision: 2,
		});
		expect(store.put(book("deploy", { body: "other {{level}}" }), { base: 7 })).toMatchObject({
			stored: false,
			revision: 2,
		});
		// Claiming there is nothing stored cannot land either.
		expect(store.put(book("deploy", { body: "other {{level}}" })).stored).toBe(false);
		expect(store.get("deploy")?.body).toBe("two {{level}}");
	});

	it("takes a repeat of what it holds as a lost answer, whenever the answer was lost", () => {
		const store = open(fresh());
		store.put(book("deploy", { body: "one {{level}}" }));
		// Lost before the write landed: the caller retries against the same base.
		expect(store.put(book("deploy", { body: "one {{level}}" }), { base: 1 })).toMatchObject({
			stored: true,
			revision: 1,
		});

		store.put(book("deploy", { body: "two {{level}}" }), { base: 1 });
		// Lost after it landed: the caller still names the base it read, now one behind.
		expect(store.put(book("deploy", { body: "two {{level}}" }), { base: 1 })).toMatchObject({
			stored: true,
			revision: 2,
		});
		// The same base with different content is a real conflict, not a retry.
		expect(store.put(book("deploy", { body: "three {{level}}" }), { base: 1 })).toMatchObject({
			stored: false,
			revision: 2,
		});
	});

	it("refuses a base for an id it has never seen", () => {
		const store = open(fresh());
		expect(store.put(book("ghost"), { base: 3 })).toMatchObject({ stored: false, revision: 0 });
		expect(store.list()).toEqual([]);
	});

	it("lets the owner overwrite a copy it cannot prove the incoming one descends from", () => {
		const store = open(fresh());
		store.put(book("deploy", { body: "one {{level}}" }));
		expect(store.put(book("deploy", { body: "four {{level}}" }), { base: 9 }).stored).toBe(false);

		// An overwrite still moves forward, so it can never mint a revision already used.
		expect(store.put(book("deploy", { body: "four {{level}}" }), { overwrite: true })).toMatchObject({
			stored: true,
			revision: 2,
		});
		expect(store.get("deploy")?.body).toBe("four {{level}}");
	});

	it("refuses a record its own rules reject, overwrite or not", () => {
		const store = open(fresh());
		store.put(book("deploy"));
		const refused = store.put(book("deploy", { revision: 2, body: "no placeholders here" }), { overwrite: true });
		expect(refused.stored).toBe(false);
		expect(store.get("deploy")?.body).toBe("release {{level}}");
	});

	it("refuses a record whose body and parameters disagree, leaving the held one alone", () => {
		const store = open(fresh());
		store.put(book("deploy"));
		const refused = store.put(book("deploy", { revision: 2, body: "no placeholders here" }));
		expect(refused.stored).toBe(false);
		expect(refused.reason).toBeTruthy();
		expect(store.get("deploy")?.revision).toBe(1);
	});

	it("holds as many as the owner pushes", () => {
		const store = open(fresh());
		for (let i = 0; i < 200; i++) expect(store.put(book(`r${i}`)).stored).toBe(true);
		expect(store.list()).toHaveLength(200);
	});

	it("deletes once, and says so only the first time", () => {
		const dataDir = fresh();
		const store = open(dataDir);
		store.put(book("deploy"));
		expect(store.remove("deploy")).toEqual({ deleted: true });
		expect(store.remove("deploy")).toEqual({ deleted: false });
		expect(open(dataDir).list()).toEqual([]);
	});

	it("refuses to hand a caller the record it holds to edit", () => {
		const store = open(fresh());
		store.put(book("deploy"));
		const listed = store.list()[0] as Runbook;
		expect(() => {
			(listed as { body: string }).body = "tampered";
		}).toThrow();
		expect(store.get("deploy")?.body).toBe("release {{level}}");
	});

	it("keeps a held record a later rule would refuse, rather than erasing the owner's work", () => {
		const dataDir = fresh();
		const stale = { ...book("stale"), body: "no placeholders here" };
		fs.writeFileSync(path.join(dataDir, "runbooks.json"), JSON.stringify([stale, book("good")]));
		const store = open(dataDir);
		expect(store.list().map((r) => r.id)).toEqual(["good", "stale"]);

		// A write of its neighbour must not take it off disk.
		store.put(book("good", { revision: 2 }));
		expect(
			open(dataDir)
				.list()
				.map((r) => r.id),
		).toEqual(["good", "stale"]);
	});

	it("starts fresh when the file on disk no longer validates, and heals on the next write", () => {
		const dataDir = fresh();
		fs.writeFileSync(path.join(dataDir, "runbooks.json"), JSON.stringify([{ id: "deploy" }]));
		const store = open(dataDir);
		expect(store.list()).toEqual([]);
		expect(store.put(book("deploy")).stored).toBe(true);
		expect(
			open(dataDir)
				.list()
				.map((r) => r.id),
		).toEqual(["deploy"]);
	});
});
