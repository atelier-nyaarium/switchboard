import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { endRank, placeAt, renumber, reorderMoves, restoreAtEnd, siblingsInOrder } from "../shared/board-order.js";
import type { BoardEntry } from "../shared/console-protocol.js";

type Row = { id: string; rank: number; parent?: string; trashedAt?: number };
type Case = {
	name: string;
	entries: Row[];
	op: { kind: "place" | "end" | "renumber" | "restore"; id?: string; parent?: string; index?: number };
	expected?: Row[];
	rank?: number;
	moved?: string[];
	brought?: string[];
};

/** Also read by the phone's BoardOrderVectorsTest. */
const cases = (
	JSON.parse(
		fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/board-order/vectors.json"), "utf8"),
	) as { cases: Case[] }
).cases;

const rows = (entries: Map<string, BoardEntry>): Row[] =>
	[...entries.values()].map(({ id, rank, parent, trashedAt }) => ({
		id,
		rank,
		...(parent === undefined ? {} : { parent }),
		...(trashedAt === undefined ? {} : { trashedAt }),
	}));

describe("board order", () => {
	for (const c of cases) {
		it(c.name, () => {
			const entries = new Map(c.entries.map((e) => [e.id, { ...e, title: e.id, state: "open" } as BoardEntry]));
			if (c.op.kind === "end") {
				expect(endRank(entries.values(), c.op.parent)).toBe(c.rank);
				return;
			}
			if (c.op.kind === "place") placeAt(entries, c.op.id as string, c.op.parent, c.op.index);
			if (c.op.kind === "renumber") expect([...renumber(entries)].sort()).toEqual(c.moved);
			if (c.op.kind === "restore") expect(restoreAtEnd(entries, c.op.id as string)).toEqual(c.brought);
			expect(rows(entries)).toEqual(c.expected);
		});
	}
});

describe("reorder", () => {
	const board = (ids: string[], hidden: string[] = []) =>
		ids.map(
			(id, i) =>
				({
					id,
					rank: i + 1,
					title: id,
					state: "open",
					...(hidden.includes(id) ? { sessionId: "other" } : {}),
				}) as BoardEntry,
		);
	/** Applies the moves as the Router does and answers the order. */
	const applied = (entries: BoardEntry[], moves: ReturnType<typeof reorderMoves>) => {
		const held = new Map(entries.map((e) => [e.id, { ...e }]));
		for (const move of moves) placeAt(held, move.id, move.parent, move.index);
		return siblingsInOrder(held.values(), undefined).map((e) => e.id);
	};
	const sees = (e: BoardEntry) => e.sessionId === undefined;

	it("puts sparse ids together after the index-th sibling, in the order given", () => {
		const entries = board(["X", "A", "B", "C", "D"]);

		expect(applied(entries, reorderMoves(entries, ["D", "X", "B"], undefined, 1, sees))).toEqual([
			"A",
			"D",
			"X",
			"B",
			"C",
		]);
		expect(applied(entries, reorderMoves(entries, ["C", "A"], undefined, 0, sees))).toEqual([
			"C",
			"A",
			"X",
			"B",
			"D",
		]);
		expect(applied(entries, reorderMoves(entries, ["A", "X"], undefined, undefined, sees))).toEqual([
			"B",
			"C",
			"D",
			"A",
			"X",
		]);
	});

	it("counts only the siblings the reader sees", () => {
		const entries = board(["A", "H", "B", "C"], ["H"]);

		expect(applied(entries, reorderMoves(entries, ["C"], undefined, 1, sees))).toEqual(["A", "C", "H", "B"]);
		expect(applied(entries, reorderMoves(entries, ["A"], undefined, 9, sees))).toEqual(["H", "B", "C", "A"]);
	});
});
