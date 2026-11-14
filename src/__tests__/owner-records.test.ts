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
) =>
	openDurable(dataDir, "records", (store) =>
		createOwnerRecords<Note>({
			store,
			kinds,
			max,
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
