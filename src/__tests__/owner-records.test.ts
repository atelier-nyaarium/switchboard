import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createOwnerRecords } from "../gateway/ownerRecords.js";
import { openDurable } from "../shared/durable-store.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fresh = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-records-"));
	roots.push(root);
	return root;
};

const NoteSchema = z.strictObject({ text: z.string().min(1) });
type Note = z.infer<typeof NoteSchema>;

let n = 0;
const open = (
	dataDir: string,
	changed: string[] = [],
	max = 3,
	kinds: Record<string, z.ZodType<Note>> = { note: NoteSchema },
	maxByKind?: Record<string, number>,
) =>
	openDurable(dataDir, "records", (store) =>
		createOwnerRecords<Note>({
			store,
			kinds,
			max,
			...(maxByKind ? { maxByKind } : {}),
			newIncarnation: () => `inc${++n}`,
			refusal: (candidate) => (candidate.body.text === "refused" ? "refused here" : null),
			onChanged: (id) => changed.push(id),
			label: "records",
		}),
	);

describe("owner records", () => {
	it("creates, edits at the held revision, takes a repeat as a lost answer, and refuses a stale edit", () => {
		const changed: string[] = [];
		const records = open(fresh(), changed);

		const created = records.put("note", "a", { text: "one" }, 0);
		const edited = records.put("note", "a", { text: "two" }, 1);
		const repeat = records.put("note", "a", { text: "two" }, 1);
		const stale = records.put("note", "a", { text: "three" }, 1);

		expect(created).toMatchObject({ stored: true, record: { revision: 1, incarnation: "inc1" } });
		expect(edited).toMatchObject({
			stored: true,
			record: { revision: 2, incarnation: "inc1", body: { text: "two" } },
		});
		expect(repeat).toMatchObject({ stored: true, record: { revision: 2 } });
		expect(stale).toMatchObject({ stored: false, record: { revision: 2 } });
		expect(records.put("note", "__proto__", { text: "one" }, 0)).toMatchObject({ stored: false });
		expect(records.put("note", "b", { text: "refused" }, 0)).toMatchObject({
			stored: false,
			reason: "refused here",
		});
		expect(changed).toEqual(["a", "a"]);
	});

	it("keeps a removed id buried, and a re-create after a restart takes a new incarnation", () => {
		const dir = fresh();
		const records = open(dir);
		records.put("note", "a", { text: "one" }, 0);

		expect(records.remove("a", 1)).toEqual({ removed: true });
		expect(records.remove("a", 1)).toEqual({ removed: true });
		expect(records.put("note", "a", { text: "late" }, 0)).toMatchObject({ stored: false, reason: "removed" });
		const reopened = open(dir);
		expect(reopened.list()).toEqual([]);
		const again = reopened.put("note", "a", { text: "again" }, 0);
		expect(again).toMatchObject({ stored: true, record: { revision: 1 } });
		expect(again.stored && again.record.incarnation).not.toBe(records.get("a")?.incarnation ?? "gone");
	});

	it("lands a batch whole or not at all, counting its removals toward the cap and reviving an id it removed", () => {
		const dir = fresh();
		const changed: string[] = [];
		const records = open(dir, changed, 3);
		records.put("note", "a", { text: "one" }, 0);
		records.put("note", "b", { text: "two" }, 0);
		changed.length = 0;

		const refused = records.batch([
			{ op: "remove", id: "a", base: 1 },
			{ op: "put", kind: "note", id: "c", body: { text: "refused" }, base: 0 },
		]);
		const untouched = records.list().map((record) => record.id);
		const heard = [...changed];
		const landed = records.batch([
			{ op: "remove", id: "a", base: 1 },
			{ op: "remove", id: "b", base: 1 },
			{ op: "put", kind: "note", id: "c", body: { text: "three" }, base: 0 },
			{ op: "put", kind: "note", id: "d", body: { text: "four" }, base: 0 },
			{ op: "put", kind: "note", id: "a", body: { text: "again" }, base: 0, revive: true },
		]);

		expect(refused).toMatchObject({ stored: false, at: 1 });
		expect([untouched, heard]).toEqual([["a", "b"], []]);
		expect(landed.stored).toBe(true);
		expect(
			open(dir)
				.list()
				.map(({ id, revision }) => [id, revision]),
		).toEqual([
			["c", 1],
			["d", 1],
			["a", 2],
		]);
		expect(changed.sort()).toEqual(["a", "b", "c", "d"]);
	});

	it("caps a kind inside the total, its unread rows counted, and the total across every kind", () => {
		const dir = fresh();
		const unread = { id: "u", revision: 1, incarnation: "x", kind: "pin", body: { text: "" } };
		fs.writeFileSync(path.join(dir, "records.json"), JSON.stringify([unread]));
		const records = open(dir, [], 4, { note: NoteSchema, pin: NoteSchema }, { pin: 2 });

		const pins = ["p1", "p2"].map((id) => records.put("pin", id, { text: id }, 0).stored);
		const notes = ["a", "b", "c"].map((id) => records.put("note", id, { text: id }, 0).stored);

		expect(pins).toEqual([true, false]);
		expect(notes).toEqual([true, true, false]);
		expect(records.put("note", "c", { text: "c" }, 0)).toMatchObject({ stored: false, full: true });
	});

	it("holds a row this build cannot read, writes it back on every commit, and reserves its id and its place in the cap", () => {
		const dir = fresh();
		const future = { id: "f", revision: 4, incarnation: "x", kind: "note", body: { text: "hi", added: 1 } };
		const later = { id: "g", revision: 1, incarnation: "y", kind: "later_kind", body: {} };
		fs.writeFileSync(path.join(dir, "records.json"), JSON.stringify([future, later]));
		const records = open(dir, [], 3);

		expect(records.list()).toEqual([]);

		expect(records.put("note", "f", { text: "over" }, 4)).toMatchObject({ stored: false });
		expect(records.remove("g", 1)).toMatchObject({ removed: false });
		expect(records.put("note", "a", { text: "one" }, 0)).toMatchObject({ stored: true });
		expect(records.put("note", "b", { text: "two" }, 0)).toMatchObject({ stored: false });
		const LooseNote = z.object({ text: z.string() }).passthrough() as unknown as z.ZodType<Note>;
		const newer = open(dir, [], 3, {
			note: LooseNote,
			later_kind: z.object({}).passthrough() as unknown as z.ZodType<Note>,
		});
		expect(
			newer
				.list()
				.map((record) => record.id)
				.sort(),
		).toEqual(["a", "f", "g"]);
	});
});
