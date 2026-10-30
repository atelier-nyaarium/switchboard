import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { endRank, placeAt, renumber, restoreAtEnd } from "../shared/board-order.js";
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
