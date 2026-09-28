import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	orphanedParents,
	promoteOrphans,
	prunableSubtrees,
	restoreBrings,
	trashTakes,
} from "../shared/board-structure.js";
import type { BoardEntry } from "../shared/console-protocol.js";

function entry(id: string, parent?: string): BoardEntry {
	return { id, title: id, state: "open", rank: id, ...(parent ? { parent } : {}) };
}

type TrashCase = {
	name: string;
	entries: Array<{ id: string; parent?: string; trashedAt?: number }>;
	op: "trash" | "restore";
	id: string;
	expected: string[];
};

/** Also read by the phone's BoardTrashVectorsTest. */
const trashCases = (
	JSON.parse(
		fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/board-trash/vectors.json"), "utf8"),
	) as { cases: TrashCase[] }
).cases;

describe("trash and restore across a subtree", () => {
	for (const c of trashCases) {
		it(c.name, () => {
			const entries = new Map(
				c.entries.map((e) => [
					e.id,
					{ ...entry(e.id, e.parent), ...(e.trashedAt === undefined ? {} : { trashedAt: e.trashedAt }) },
				]),
			);
			const taken = c.op === "trash" ? trashTakes(entries, c.id) : restoreBrings(entries, c.id);
			expect([...taken].sort()).toEqual(c.expected);
		});
	}
});

describe("board structure", () => {
	it("finds prunable subtrees", () => {
		const entries = new Map([
			["root", entry("root")],
			["done", entry("done", "root")],
			["open", entry("open", "root")],
		]);

		expect(prunableSubtrees(entries, (candidate) => candidate.id !== "open")).toEqual(new Set(["done"]));
	});

	it("promotes entries with missing parents", () => {
		const child = entry("child", "missing");
		const entries = new Map([[child.id, child]]);

		expect(promoteOrphans(entries)).toBe(1);
		expect(child.parent).toBeUndefined();
	});

	it("finds parents that lost touched children", () => {
		const before = entry("child", "parent");
		const prev = { revision: 1, entries: new Map([[before.id, before]]) };
		const next = { revision: 2, entries: new Map<string, BoardEntry>() };

		expect(orphanedParents(prev, next, new Set(["child"]))).toEqual(["parent"]);
	});
});
