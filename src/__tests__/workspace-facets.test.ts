import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session } from "@nyaa-lexicon/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerWorkspaceOp } from "../mcp/workspace/handlers.js";
import { CODE_TOKENS } from "../shared/schemasWorkspace.js";
import {
	type FacetAnswer,
	MAX_WORKSPACE_OP_BYTES,
	type SymbolFacet,
	type WorkspaceOpResult,
} from "../shared/workspace-op.js";

////////////////////////////////
//  Functions & Helpers

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const PORT = "lexicon typescript src/lib.ts Port#";
const PORT_OPEN = "lexicon typescript src/lib.ts Port#open().";
const HANDLER = "lexicon typescript src/use.ts Handler#";
const HANDLER_START = "lexicon typescript src/use.ts Handler#start().";
const LONG = "lexicon typescript src/long.ts Long#";
const SECRET = "lexicon typescript .env Secret#";
/** Withheld id; summary claims served. */
const CLOAKED = "lexicon typescript .env Cloaked#";

const LONG_LINE = `${"x".repeat(1_500)}Port${"y".repeat(500)}`;

function workspace(): string {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wsfacets-")));
	roots.push(root);
	fs.mkdirSync(path.join(root, "src"));
	fs.writeFileSync(path.join(root, "src", "lib.ts"), "export interface Port {\n\topen(): void;\n}\n");
	fs.writeFileSync(
		path.join(root, "src", "use.ts"),
		"export class Handler {\r\n\tstart(port: Port) {}\r\n}\r\n\r\n\r\nconst top: Port = null;\r\n",
	);
	fs.writeFileSync(path.join(root, "src", "long.ts"), `${LONG_LINE}\n`);
	fs.writeFileSync(path.join(root, ".env"), "Port=1\n");
	return root;
}

function summary(symbolId: string, name: string, kind: string, module: string, start = 0) {
	return { symbolId, name, kind, module, visibility: "public", lines: { start, end: start + 2 } };
}

function reference(over: Record<string, unknown>) {
	return {
		factId: "f",
		module: "src/use.ts",
		name: "Port",
		role: "typeUse",
		targetId: PORT,
		fromId: null,
		provenance: "bound",
		startLine: 0,
		startCharacter: 0,
		endLine: over.startLine ?? 0,
		endCharacter: 4,
		...over,
	};
}

const usesOfPort = [
	reference({
		startLine: 1,
		startCharacter: 13,
		endCharacter: 17,
		fromId: HANDLER_START,
		topLevel: summary(HANDLER, "Handler", "class", "src/use.ts"),
		language: "typescript",
	}),
	reference({ startLine: 5, startCharacter: 11, endCharacter: 15 }),
	reference({
		module: "src/long.ts",
		startCharacter: 1_500,
		endCharacter: 1_504,
		fromId: LONG,
		topLevel: summary(LONG, "Long", "class", "src/long.ts"),
	}),
	reference({ module: ".env", fromId: SECRET, topLevel: summary(SECRET, "Secret", "class", ".env") }),
];

type Methods = Record<string, (params: Record<string, unknown>) => unknown>;

/** Unlisted reads throw. */
function sessionOf(methods: Methods, asked: string[] = []): () => Promise<Session> {
	const names = [
		"declarationOf",
		"describe",
		"findReferences",
		"usesFrom",
		"typeHierarchy",
		"findComments",
		"resolveFacts",
		"knowledgeScope",
		"outlineModule",
		"recallAnswer",
	];
	const session = Object.fromEntries(
		names.map((name) => [
			name,
			async (params: Record<string, unknown>) => {
				asked.push(`${name} ${String(params.module ?? params.symbolId ?? "")}`);
				const method = methods[name];
				if (method === undefined) throw new Error(`${name} was asked`);
				return method(params);
			},
		]),
	);
	return async () => session as unknown as Session;
}

const declared = {
	declarationOf: () => ({
		symbolId: PORT,
		kind: "interface",
		name: "Port",
		module: "src/lib.ts",
		range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
		visibility: "public",
		signature: "interface Port",
	}),
};

/** Token painting a column. */
function tokenAt(spans: readonly number[] | undefined, column: number): string | undefined {
	for (let index = 0; spans !== undefined && index + 2 < spans.length; index += 3) {
		const start = spans[index] as number;
		if (column >= start && column < start + (spans[index + 1] as number))
			return CODE_TOKENS[spans[index + 2] as number];
	}
	return undefined;
}

async function facetOf(
	root: string,
	facet: SymbolFacet,
	methods: Methods,
	symbolId = PORT,
): Promise<{ result: WorkspaceOpResult; facet: FacetAnswer | undefined }> {
	const result = await answerWorkspaceOp(
		{ root: () => root, session: sessionOf({ ...declared, ...methods }) },
		{ kind: "symbolFacet", symbolId, facet },
	);
	return { result, facet: result.ok && result.answer.kind === "symbolFacet" ? result.answer.facet : undefined };
}

////////////////////////////////
//  Tests

describe("every use of a symbol", () => {
	it("lists each served use with its line, holder and top level, and counts nothing withheld", async () => {
		const asked: string[] = [];
		const root = workspace();
		const result = await answerWorkspaceOp(
			{
				root: () => root,
				session: sessionOf(
					{
						...declared,
						findReferences: () => ({ references: usesOfPort, total: 4, truncated: false }),
						outlineModule: () => [
							summary(HANDLER, "Handler", "class", "src/use.ts"),
							summary(HANDLER_START, "start", "method", "src/use.ts", 1),
						],
					},
					asked,
				),
			},
			{ kind: "symbolFacet", symbolId: PORT, facet: { kind: "uses" } },
		);

		const facet = result.ok && result.answer.kind === "symbolFacet" ? result.answer.facet : undefined;
		expect(facet).toEqual({
			kind: "uses",
			uses: 3,
			plain: 0,
			rows: [
				{
					module: "src/use.ts",
					line: 2,
					startColumn: 13,
					endColumn: 17,
					name: "Port",
					role: "typeUse",
					holder: {
						symbolId: HANDLER_START,
						name: "start",
						symbolKind: "method",
						module: "src/use.ts",
						startLine: 2,
						endLine: 4,
					},
					topLevel: {
						symbolId: HANDLER,
						name: "Handler",
						symbolKind: "class",
						module: "src/use.ts",
						startLine: 1,
						endLine: 3,
					},
					language: "typescript",
					text: "\tstart(port: Port) {}",
					spans: expect.any(Array),
				},
				{
					module: "src/use.ts",
					line: 6,
					startColumn: 11,
					endColumn: 15,
					name: "Port",
					role: "typeUse",
					text: "const top: Port = null;",
					spans: expect.any(Array),
				},
				expect.objectContaining({
					module: "src/long.ts",
					holder: expect.objectContaining({ symbolId: LONG }),
					text: LONG_LINE.slice(1_372, 1_884),
					textStart: 1_372,
				}),
			],
		});
		// Outlined only where needed.
		expect(asked.filter((call) => call.startsWith("outlineModule"))).toEqual(["outlineModule src/use.ts"]);
		const first = facet?.kind === "uses" ? facet.rows[0] : undefined;
		expect(tokenAt(first?.spans, 13)).toBe("type");
	});

	it("highlights each file whole and slices it per row, window included", async () => {
		const root = workspace();
		fs.writeFileSync(
			path.join(root, "src", "lit.ts"),
			`/* opens\nPort */\nconst s = "${"a".repeat(1_500)}" + Port;\n`,
		);
		const lit = (startLine: number, startCharacter: number) =>
			reference({
				module: "src/lit.ts",
				startLine,
				startCharacter,
				endCharacter: startCharacter + 4,
				language: "typescript",
			});
		const { facet } = await facetOf(
			root,
			{ kind: "uses" },
			{ findReferences: () => ({ references: [lit(1, 0), lit(2, 1_515)], total: 2, truncated: false }) },
		);
		const [inComment, windowed] = facet?.kind === "uses" ? facet.rows : [];

		expect(tokenAt(inComment?.spans, 0)).toBe("comment");
		expect(windowed?.textStart).toBeGreaterThan(0);
		expect(tokenAt(windowed?.spans, 0)).toBe("string");
		expect(tokenAt(windowed?.spans, 1_515 - (windowed?.textStart ?? 0))).not.toBe("string");
		expect(facet).toMatchObject({ plain: 0 });
	});

	it("leaves rows plain once the deadline has passed, and counts them", async () => {
		const real = Date.now;
		let late = 0;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + late);
		const inHandler = reference({
			startLine: 1,
			startCharacter: 13,
			endCharacter: 17,
			fromId: HANDLER,
			topLevel: summary(HANDLER, "Handler", "class", "src/use.ts"),
			language: "typescript",
		});
		try {
			const { facet } = await facetOf(
				workspace(),
				{ kind: "uses" },
				{
					findReferences: () => {
						late = 60_000;
						return { references: [inHandler, usesOfPort[2]], total: 2, truncated: false };
					},
				},
			);

			// No language, no count.
			expect(facet).toMatchObject({ plain: 1 });
			expect(facet?.kind === "uses" && facet.rows.map((row) => [row.text !== undefined, row.spans])).toEqual([
				[true, undefined],
				[true, undefined],
			]);
		} finally {
			clock.mockRestore();
		}
	});

	it("drops a row whose file is gone and one whose line is past the end, counting neither", async () => {
		const { facet } = await facetOf(
			workspace(),
			{ kind: "uses" },
			{
				findReferences: () => ({
					references: [
						reference({ module: "src/deleted.ts", startLine: 0, endCharacter: 4 }),
						reference({ startLine: 99, endCharacter: 4 }),
						reference({ startLine: 5, startCharacter: 11, endCharacter: 15 }),
					],
					total: 3,
					truncated: false,
				}),
			},
		);

		expect(facet).toMatchObject({ kind: "uses", uses: 1 });
		expect(facet?.kind === "uses" && facet.rows.map((row) => [row.module, row.line])).toEqual([["src/use.ts", 6]]);
	});

	it("carries no holder or top level whose id names a withheld module", async () => {
		const { facet } = await facetOf(
			workspace(),
			{ kind: "uses" },
			{
				findReferences: () => ({
					references: [
						reference({
							startLine: 1,
							startCharacter: 13,
							endCharacter: 17,
							fromId: CLOAKED,
							topLevel: summary(HANDLER, "Handler", "class", "src/use.ts"),
						}),
						reference({
							startLine: 5,
							startCharacter: 11,
							endCharacter: 15,
							fromId: CLOAKED,
							topLevel: summary(CLOAKED, "Cloaked", "class", "src/use.ts"),
						}),
					],
					total: 2,
					truncated: false,
				}),
				outlineModule: () => [summary(CLOAKED, "Cloaked", "class", "src/use.ts")],
			},
		);
		const rows = facet?.kind === "uses" ? facet.rows : [];

		expect(rows.map((row) => [row.line, row.holder?.symbolId, row.topLevel?.symbolId])).toEqual([
			[2, undefined, HANDLER],
			[6, undefined, undefined],
		]);
	});

	it("refuses an answer over the cap with its row count and size", async () => {
		const many = Array.from({ length: 8_000 }, () => usesOfPort[2]);
		const { result } = await facetOf(
			workspace(),
			{ kind: "uses" },
			{ findReferences: () => ({ references: many, total: many.length, truncated: false }) },
		);

		expect(result).toMatchObject({ ok: false, failure: "too_large", rows: 8_000 });
		expect(!result.ok && result.bytes).toBeGreaterThan(MAX_WORKSPACE_OP_BYTES);
	});

	it("refuses rows Lexicon did not list whole, without a size it never measured", async () => {
		const { result } = await facetOf(
			workspace(),
			{ kind: "uses" },
			{ findReferences: () => ({ references: usesOfPort, total: 400_000, truncated: true }) },
		);

		expect(result).toMatchObject({ ok: false, failure: "too_large", rows: 3 });
		expect(!result.ok && result.bytes).toBeUndefined();
	});

	it("refuses a withheld symbol, and one the index does not hold, before any facet read", async () => {
		const reads = { findReferences: () => ({ references: [], total: 0, truncated: false }) };

		expect((await facetOf(workspace(), { kind: "uses" }, reads, SECRET)).result).toMatchObject({
			failure: "refused",
		});
		expect(
			(await facetOf(workspace(), { kind: "uses" }, { ...reads, declarationOf: () => null })).result,
		).toMatchObject({ failure: "refused" });
	});

	it("spends one deadline, failing rather than hanging", async () => {
		const started = Date.now();
		const result = await answerWorkspaceOp(
			{
				root: () => workspace(),
				session: sessionOf({ ...declared, findReferences: () => new Promise(() => {}) }),
				budgetMs: 50,
			},
			{ kind: "symbolFacet", symbolId: PORT, facet: { kind: "uses" } },
		);

		expect(result).toMatchObject({ ok: false, failure: "failed" });
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});

describe("what a symbol uses", () => {
	it("groups bound uses by target and unresolved names by spelling, a withheld target unresolved", async () => {
		const inHandler = { fromId: HANDLER_START, topLevel: summary(HANDLER, "Handler", "class", "src/use.ts") };
		const { facet } = await facetOf(
			workspace(),
			{ kind: "usesFrom" },
			{
				usesFrom: () => ({
					references: [
						reference({
							...inHandler,
							startLine: 1,
							status: "bound",
							target: summary(PORT, "Port", "interface", "src/lib.ts"),
						}),
						reference({
							...inHandler,
							startLine: 1,
							name: "Promise",
							targetId: null,
							status: "unbound",
							reason: "NotIndexed",
						}),
						reference({
							...inHandler,
							startLine: 5,
							status: "bound",
							target: summary(PORT, "Port", "interface", "src/lib.ts"),
						}),
						reference({
							...inHandler,
							startLine: 5,
							name: "Secret",
							targetId: SECRET,
							status: "bound",
							target: summary(SECRET, "Secret", "class", ".env"),
						}),
					],
					total: 4,
					truncated: false,
				}),
				outlineModule: () => [summary(HANDLER_START, "start", "method", "src/use.ts", 1)],
			},
			HANDLER,
		);

		expect(facet).toMatchObject({ kind: "usesFrom", targetCount: 3, references: 4 });
		const targets = facet?.kind === "usesFrom" ? facet.targets : [];
		expect(
			targets.map((group) => [
				group.name,
				group.status,
				group.target?.symbolId,
				group.uses.map((use) => use.line),
			]),
		).toEqual([
			["Port", "bound", PORT, [2, 6]],
			["Promise", "unbound", undefined, [2]],
			["Secret", "unbound", undefined, [6]],
		]);
		expect(targets[1]).toMatchObject({ reason: "NotIndexed" });
	});

	it("keeps a use whose target's id names a withheld module, however served the summary claims to be", async () => {
		const inHandler = { fromId: HANDLER_START, topLevel: summary(HANDLER, "Handler", "class", "src/use.ts") };
		const { facet } = await facetOf(
			workspace(),
			{ kind: "usesFrom" },
			{
				usesFrom: () => ({
					references: [
						reference({
							...inHandler,
							startLine: 1,
							name: "Secret",
							targetId: SECRET,
							status: "bound",
							// Id names `.env`; summary claims `src/lib.ts`.
							target: summary(SECRET, "Secret", "class", "src/lib.ts"),
						}),
					],
					total: 1,
					truncated: false,
				}),
				outlineModule: () => [summary(HANDLER_START, "start", "method", "src/use.ts", 1)],
			},
			HANDLER,
		);

		expect(facet).toMatchObject({ kind: "usesFrom", targetCount: 1, references: 1 });
		const targets = facet?.kind === "usesFrom" ? facet.targets : [];
		expect(targets[0]).toMatchObject({ name: "Secret", status: "unbound" });
		expect(targets[0]?.target).toBeUndefined();
	});
});

describe("declared members", () => {
	it("lists what describe declares, and refuses a symbol describe does not hold", async () => {
		const { facet } = await facetOf(
			workspace(),
			{ kind: "members" },
			{
				describe: () => ({
					members: [{ ...summary(PORT_OPEN, "open", "method", "src/lib.ts", 1), signature: "open(): void" }],
				}),
			},
		);

		expect(facet).toEqual({
			kind: "members",
			plain: 0,
			members: [
				{
					symbolId: PORT_OPEN,
					name: "open",
					symbolKind: "method",
					module: "src/lib.ts",
					startLine: 2,
					endLine: 4,
					signature: "open(): void",
					signatureSpans: [expect.any(Array)],
				},
			],
		});
		const member = facet?.kind === "members" ? facet.members[0] : undefined;
		expect(tokenAt(member?.signatureSpans?.[0], 0)).toBe("function");
		expect((await facetOf(workspace(), { kind: "members" }, { describe: () => null })).result).toMatchObject({
			failure: "refused",
		});
	});

	it("drops a member whose id names a withheld module", async () => {
		const { facet } = await facetOf(
			workspace(),
			{ kind: "members" },
			{
				describe: () => ({
					members: [
						summary(CLOAKED, "Cloaked", "method", "src/lib.ts", 1),
						summary(PORT_OPEN, "open", "method", "src/lib.ts", 1),
					],
				}),
			},
		);

		expect(facet?.kind === "members" && facet.members.map((member) => member.symbolId)).toEqual([PORT_OPEN]);
	});
});

describe("the type hierarchy", () => {
	it("lists supertypes to the roots and subtypes below, each with how it is related", async () => {
		const base = summary("lexicon typescript src/lib.ts Base#", "Base", "interface", "src/lib.ts");
		const root = summary("lexicon typescript src/lib.ts Root#", "Root", "interface", "src/lib.ts");
		const impl = summary(HANDLER, "Handler", "class", "src/use.ts");
		const { facet } = await facetOf(
			workspace(),
			{ kind: "hierarchy" },
			{
				typeHierarchy: () => ({
					symbolId: PORT,
					supertypes: [base],
					ancestors: [base, root, summary(SECRET, "Secret", "class", ".env")],
					unboundSupertypes: ["Error", "Error"],
					subtypes: [impl, summary(SECRET, "Secret", "class", ".env")],
				}),
				usesFrom: () => ({
					references: [
						reference({ fromId: PORT, role: "extends", targetId: base.symbolId }),
						reference({ fromId: PORT, role: "extends", name: "Error", targetId: null }),
						reference({ fromId: PORT_OPEN, role: "typeUse", targetId: root.symbolId }),
					],
					total: 3,
					truncated: false,
				}),
				findReferences: () => ({
					references: [
						reference({ fromId: HANDLER, role: "implements" }),
						reference({ fromId: HANDLER_START }),
					],
					total: 2,
					truncated: false,
				}),
			},
		);

		expect(facet).toMatchObject({
			kind: "hierarchy",
			subject: {
				symbolId: PORT,
				name: "Port",
				symbolKind: "interface",
				module: "src/lib.ts",
				startLine: 1,
				endLine: 3,
				signature: "interface Port",
			},
			supertypes: [{ symbol: { symbolId: base.symbolId }, role: "extends" }],
			ancestors: [{ symbolId: root.symbolId }],
			unbound: [{ name: "Error", role: "extends" }],
			subtypes: [{ symbol: { symbolId: HANDLER }, role: "implements" }],
			supertypeCount: 3,
			subtypeCount: 1,
		});
	});

	it("drops a supertype and a subtype whose id names a withheld module, and counts neither", async () => {
		const base = summary("lexicon typescript src/lib.ts Base#", "Base", "interface", "src/lib.ts");
		const { facet } = await facetOf(
			workspace(),
			{ kind: "hierarchy" },
			{
				typeHierarchy: () => ({
					symbolId: PORT,
					supertypes: [base, summary(CLOAKED, "Cloaked", "interface", "src/lib.ts")],
					ancestors: [summary(CLOAKED, "Cloaked", "interface", "src/lib.ts")],
					unboundSupertypes: [],
					subtypes: [summary(CLOAKED, "Cloaked", "class", "src/use.ts")],
				}),
				usesFrom: () => ({ references: [], total: 0, truncated: false }),
				findReferences: () => ({ references: [], total: 0, truncated: false }),
			},
		);

		expect(facet).toMatchObject({
			kind: "hierarchy",
			supertypes: [{ symbol: { symbolId: base.symbolId } }],
			ancestors: [],
			subtypes: [],
			supertypeCount: 1,
			subtypeCount: 0,
		});
	});
});

describe("comments inside a symbol", () => {
	it("lists its members' and locals' comments on the nearest declaration a window opens, without its own documentation", async () => {
		const local = "lexicon typescript src/lib.ts local0";
		const found = (factId: string, anchorId: string | null, form: string, line: number) => ({
			factId,
			module: "src/lib.ts",
			range: { start: { line, character: 0 }, end: { line, character: 9 } },
			form,
			placement: "above",
			raw: `// ${factId}`,
			anchor: anchorId === null ? null : { symbolId: anchorId, name: "n", kind: "method", line },
		});
		const { facet } = await facetOf(
			workspace(),
			{ kind: "comments" },
			{
				findComments: () => ({
					comments: [
						found("doc", PORT, "leading", 0),
						found("member", PORT_OPEN, "leading", 1),
						found("inner", local, "inline", 2),
					],
					total: 3,
					truncated: true,
				}),
				resolveFacts: () => ({
					resolved: [
						{ fact: "comment", factId: "member", normalized: "Opens it." },
						{ fact: "comment", factId: "inner", normalized: "Held briefly." },
					],
					missing: [],
				}),
				knowledgeScope: () => ({
					symbols: [
						{ symbol: summary(PORT_OPEN, "open", "method", "src/lib.ts", 1), depth: 1, questions: [] },
						{ symbol: summary(PORT, "Port", "interface", "src/lib.ts"), depth: 0, questions: [] },
					],
					localsExcluded: 1,
				}),
				outlineModule: () => [
					summary(PORT, "Port", "interface", "src/lib.ts"),
					{ ...summary(PORT_OPEN, "open", "method", "src/lib.ts", 1), containerId: PORT },
					{ ...summary(local, "held", "variable", "src/lib.ts", 2), containerId: PORT_OPEN },
				],
			},
		);

		expect(facet).toMatchObject({
			kind: "comments",
			truncated: true,
			total: 2,
			comments: [
				{ text: "Opens it.", form: "leading", line: 2, holder: { symbolId: PORT_OPEN } },
				{ text: "Held briefly.", form: "inline", line: 3, holder: { symbolId: PORT_OPEN } },
			],
		});
	});

	it("lists its own page and says there are more, whatever Lexicon hands back", async () => {
		const many = Array.from({ length: 250 }, (_, index) => ({
			factId: `c${index}`,
			module: "src/lib.ts",
			range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
			form: "inline",
			placement: "body",
			raw: `// ${index}`,
			anchor: null,
		}));
		const { facet } = await facetOf(
			workspace(),
			{ kind: "comments" },
			{
				findComments: () => ({ comments: many, total: 250, truncated: false }),
				resolveFacts: () => ({ resolved: [], missing: [] }),
				knowledgeScope: () => ({ symbols: [], localsExcluded: 0 }),
				outlineModule: () => [],
			},
		);

		expect(facet).toMatchObject({ kind: "comments", total: 250, truncated: true });
		expect(facet?.kind === "comments" && facet.comments.length).toBe(200);
	});

	it("names no holder whose id is withheld, and counts at least what it listed", async () => {
		const { facet } = await facetOf(
			workspace(),
			{ kind: "comments" },
			{
				findComments: () => ({
					comments: [
						{
							factId: "c",
							module: "src/lib.ts",
							range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
							form: "inline",
							placement: "body",
							raw: "// note",
							anchor: { symbolId: CLOAKED, name: "Cloaked", kind: "method", line: 1 },
						},
					],
					total: 0,
					truncated: false,
				}),
				resolveFacts: () => ({ resolved: [], missing: [] }),
				knowledgeScope: () => ({
					symbols: [
						{ symbol: summary(CLOAKED, "Cloaked", "method", "src/lib.ts", 1), depth: 1, questions: [] },
					],
					localsExcluded: 0,
				}),
				outlineModule: () => [summary(CLOAKED, "Cloaked", "method", "src/lib.ts", 1)],
			},
		);

		expect(facet).toMatchObject({ kind: "comments", total: 1 });
		expect(facet?.kind === "comments" && facet.comments[0]?.holder).toBeUndefined();
	});
});

describe("the knowledge answer's counts", () => {
	it("counts each drill-in from its own read, withheld uses excluded", async () => {
		const result = await answerWorkspaceOp(
			{
				root: () => workspace(),
				session: sessionOf({
					describe: () => ({
						symbol: summary(PORT, "Port", "interface", "src/lib.ts"),
						members: [summary(PORT_OPEN, "open", "method", "src/lib.ts", 1)],
						referenceCount: 4,
						graph: { symbolId: PORT, fanIn: 3, fanOut: 0 },
						hierarchy: {
							symbolId: PORT,
							supertypes: [],
							ancestors: [],
							unboundSupertypes: ["Error"],
							subtypes: [summary(SECRET, "Secret", "class", ".env")],
						},
					}),
					recallAnswer: () => [],
					findReferences: () => ({ references: usesOfPort, total: 4, truncated: false }),
					usesFrom: () => ({
						references: [
							reference({ status: "unbound", name: "Error", targetId: null }),
							reference({ status: "unbound", name: "Error", targetId: null }),
							reference({
								status: "bound",
								name: "Port",
								targetId: PORT,
								target: summary(PORT, "Port", "interface", "src/lib.ts"),
							}),
						],
						total: 3,
						truncated: false,
					}),
					findComments: () => ({ comments: [], total: 5, truncated: true }),
				}),
			},
			{ kind: "symbolKnowledge", symbolId: PORT },
		);

		expect(result.ok && result.answer.kind === "symbolKnowledge" && result.answer.facts?.counts).toEqual({
			uses: 3,
			useFiles: 2,
			dependents: 2,
			dependentFiles: 1,
			targets: 2,
			boundTargets: 1,
			references: 3,
			members: 1,
			supertypes: 1,
			subtypes: 0,
			comments: 5,
		});
	});

	// Truncated reads open no file to validate.
	it("answers without counts when the use read is truncated", async () => {
		const result = await answerWorkspaceOp(
			{
				root: () => workspace(),
				session: sessionOf({
					describe: () => ({
						symbol: summary(PORT, "Port", "interface", "src/lib.ts"),
						members: [],
						referenceCount: 4,
						graph: { symbolId: PORT, fanIn: 3, fanOut: 0 },
						hierarchy: {
							symbolId: PORT,
							supertypes: [],
							ancestors: [],
							unboundSupertypes: [],
							subtypes: [],
						},
					}),
					recallAnswer: () => [],
					findReferences: () => ({ references: usesOfPort, total: 4, truncated: true }),
					usesFrom: () => ({ references: [], total: 0, truncated: false }),
					findComments: () => ({ comments: [], total: 0, truncated: false }),
				}),
			},
			{ kind: "symbolKnowledge", symbolId: PORT },
		);

		expect(result).toMatchObject({ ok: true, answer: { kind: "symbolKnowledge", facts: { references: 4 } } });
		expect(result.ok && result.answer.kind === "symbolKnowledge" && result.answer.facts?.counts).toBeUndefined();
	});

	it("answers without counts when a use read outlasts the handler deadline", async () => {
		const result = await answerWorkspaceOp(
			{
				root: () => workspace(),
				session: sessionOf({
					describe: () => ({
						symbol: summary(PORT, "Port", "interface", "src/lib.ts"),
						members: [],
						referenceCount: 0,
						graph: { symbolId: PORT, fanIn: 0, fanOut: 0 },
						hierarchy: {
							symbolId: PORT,
							supertypes: [],
							ancestors: [],
							unboundSupertypes: [],
							subtypes: [],
						},
					}),
					recallAnswer: () => [],
					findReferences: () => new Promise(() => {}),
				}),
				budgetMs: 50,
			},
			{ kind: "symbolKnowledge", symbolId: PORT },
		);

		expect(result).toMatchObject({ ok: true, answer: { kind: "symbolKnowledge", facts: { members: 0 } } });
		expect(result.ok && result.answer.kind === "symbolKnowledge" && result.answer.facts?.counts).toBeUndefined();
	});

	it("answers the rest without counts from a Lexicon that lacks the facet reads", async () => {
		const { DaemonError } = await import("@nyaa-lexicon/client");
		const result = await answerWorkspaceOp(
			{
				root: () => workspace(),
				session: sessionOf({
					describe: () => ({
						symbol: summary(PORT, "Port", "interface", "src/lib.ts"),
						members: [],
						referenceCount: 0,
						graph: { symbolId: PORT, fanIn: 0, fanOut: 0 },
						hierarchy: {
							symbolId: PORT,
							supertypes: [],
							ancestors: [],
							unboundSupertypes: [],
							subtypes: [],
						},
					}),
					recallAnswer: () => [],
					findReferences: () => ({ references: [], total: 0, truncated: false }),
					usesFrom: () => {
						throw new DaemonError("unknown method: usesFrom", "unknownMethod");
					},
				}),
			},
			{ kind: "symbolKnowledge", symbolId: PORT },
		);

		expect(result).toMatchObject({ ok: true, answer: { kind: "symbolKnowledge", facts: { members: 0 } } });
		expect(result.ok && result.answer.kind === "symbolKnowledge" && result.answer.facts?.counts).toBeUndefined();
	});
});

describe("the scope an Ask covers", () => {
	it("answers each declaration's questions with the root label, and refuses a withheld file", async () => {
		const root = workspace();
		const scope = {
			symbols: [
				{
					symbol: { ...summary(PORT_OPEN, "open", "method", "src/lib.ts", 1), containerId: PORT },
					depth: 1,
					questions: [
						{ question: "describe", askCount: 0, createdAt: 9, thin: true },
						{ question: "why", askCount: 2 },
					],
				},
				{ symbol: summary(PORT, "Port", "interface", "src/lib.ts"), depth: 0, questions: [] },
			],
			localsExcluded: 4,
		};
		const asked: Record<string, unknown>[] = [];
		const result = await answerWorkspaceOp(
			{
				root: () => root,
				session: sessionOf({
					knowledgeScope: (params) => {
						asked.push(params);
						return scope;
					},
				}),
			},
			{ kind: "knowledgeScope", scope: { kind: "members", symbolId: PORT }, includeLocals: false },
		);

		expect(asked).toEqual([{ symbolId: PORT, members: true, includeLocals: false }]);
		expect(result.ok && result.answer).toMatchObject({
			kind: "knowledgeScope",
			module: "src/lib.ts",
			localsExcluded: 4,
			symbols: [
				{
					symbolId: PORT_OPEN,
					name: "open",
					symbolKind: "method",
					depth: 1,
					startLine: 2,
					containerId: PORT,
					questions: [
						{ question: "describe", askCount: 0, createdAt: 9, thin: true },
						{ question: "why", askCount: 2 },
					],
				},
				{ symbolId: PORT, depth: 0, questions: [] },
			],
		});
		expect(result.ok && result.answer.kind === "knowledgeScope" && result.answer.root).toBeTruthy();

		const withheld = await answerWorkspaceOp(
			{ root: () => root, session: sessionOf({ knowledgeScope: () => scope }) },
			{ kind: "knowledgeScope", scope: { kind: "file", path: ".env" }, includeLocals: true },
		);
		expect(withheld).toMatchObject({ ok: false, failure: "refused" });
	});

	it("drops a symbol whose id names a withheld module, and a container it may not name", async () => {
		const root = workspace();
		const result = await answerWorkspaceOp(
			{
				root: () => root,
				session: sessionOf({
					knowledgeScope: () => ({
						symbols: [
							{
								symbol: summary(CLOAKED, "Cloaked", "method", "src/lib.ts", 1),
								depth: 1,
								questions: [],
							},
							{
								symbol: {
									...summary(PORT_OPEN, "open", "method", "src/lib.ts", 1),
									containerId: CLOAKED,
								},
								depth: 1,
								questions: [],
							},
						],
						localsExcluded: 0,
					}),
				}),
			},
			{ kind: "knowledgeScope", scope: { kind: "members", symbolId: PORT }, includeLocals: false },
		);
		const symbols = result.ok && result.answer.kind === "knowledgeScope" ? result.answer.symbols : [];

		expect(symbols.map((symbol) => symbol.symbolId)).toEqual([PORT_OPEN]);
		expect(symbols[0]?.containerId).toBeUndefined();
	});
});
