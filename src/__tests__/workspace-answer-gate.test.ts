import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session } from "@nyaa-lexicon/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { gatedAnswerFields } from "../mcp/workspace/answerGate.js";
import { answerWorkspaceOp } from "../mcp/workspace/handlers.js";
import { WorkspaceOpAnswerSchema } from "../shared/schemasWorkspace.js";
import type { WorkspaceOp, WorkspaceOpResult } from "../shared/workspace-op.js";
import { answerForConsole } from "../shared/workspace-op.js";

////////////////////////////////
//  Functions & Helpers

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SERVED_ID = "lexicon typescript src/app.ts f().";
const WITHHELD = ".env";
const SECRET = "TOKEN=secret";
const SPAN = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };

function workspace(): string {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wsgate-")));
	roots.push(root);
	fs.mkdirSync(path.join(root, "src"));
	fs.writeFileSync(path.join(root, "src", "app.ts"), "export const f = 1;\n");
	fs.writeFileSync(path.join(root, WITHHELD), `${SECRET}\n`);
	return root;
}

/** Unlisted reads throw (proves the road taken). */
function sessionOf(methods: Record<string, () => unknown>): () => Promise<Session> {
	const names = [
		"declarationOf",
		"describe",
		"indexFile",
		"recallAnswer",
		"refactorReplaceSpan",
		"symbolSource",
		"typeHierarchy",
	];
	return async () =>
		Object.fromEntries(
			names.map((name) => [
				name,
				async () => {
					const method = methods[name];
					if (method === undefined) throw new Error(`${name} was asked`);
					return method();
				},
			]),
		) as unknown as Session;
}

function ask(op: WorkspaceOp, methods: Record<string, () => unknown>, root = workspace()): Promise<WorkspaceOpResult> {
	return answerWorkspaceOp({ root: () => root, session: sessionOf(methods) }, op);
}

const sourceIn = (module: string) => () => ({
	found: true,
	module,
	name: "f",
	text: module === WITHHELD ? SECRET : "export const f = 1;",
	range: SPAN,
	spanHash: "h",
});

const describedIn = (module: string) => () => ({
	symbol: { symbolId: SERVED_ID, name: "f", kind: "constant", module },
	members: [],
	referenceCount: 0,
	graph: { symbolId: SERVED_ID, fanIn: 0, fanOut: 0 },
	hierarchy: { symbolId: SERVED_ID, supertypes: [], ancestors: [], unboundSupertypes: [], subtypes: [] },
});

const declaredIn = (module: string) => () => ({
	symbolId: SERVED_ID,
	kind: "constant",
	name: "f",
	module,
	range: SPAN,
	visibility: "public",
});

const emptyHierarchy = () => ({
	symbolId: SERVED_ID,
	supertypes: [],
	ancestors: [],
	unboundSupertypes: [],
	subtypes: [],
});

const saved = (issueModule?: string) => ({
	replaced: true,
	transaction: "own",
	issues:
		issueModule === undefined
			? []
			: [{ kind: "UnboundReference", detail: "g no longer binds", module: issueModule }],
});

const save = { kind: "saveSpan", symbolId: SERVED_ID, expectedSpanHash: "seen", text: "after" } as const;

/** Every schema string field, walked apart from the gate. */
function declaredStringFields(): string[] {
	const json = z.toJSONSchema(WorkspaceOpAnswerSchema, { io: "output" }) as Record<string, unknown>;
	const names = new Set<string>();
	const walk = (node: unknown): void => {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		const record = node as Record<string, unknown>;
		const properties = (record.properties ?? {}) as Record<string, Record<string, unknown>>;
		for (const [name, child] of Object.entries(properties)) if (child.type === "string") names.add(name);
		for (const key of Object.keys(record)) walk(record[key]);
	};
	walk(json);
	return [...names].sort();
}

////////////////////////////////
//  Tests

describe("what a built answer may name", () => {
	it("answers a source, knowledge and hierarchy whose names are all served", async () => {
		const source = await ask(
			{ kind: "symbolSource", symbolId: SERVED_ID },
			{ symbolSource: sourceIn("src/app.ts") },
		);
		const knowledge = await ask(
			{ kind: "symbolKnowledge", symbolId: SERVED_ID },
			{ describe: describedIn("src/app.ts"), recallAnswer: () => [] },
		);
		const hierarchy = await ask(
			{ kind: "symbolFacet", symbolId: SERVED_ID, facet: { kind: "hierarchy" } },
			{ declarationOf: declaredIn("src/app.ts"), typeHierarchy: emptyHierarchy },
		);

		expect(source).toMatchObject({ ok: true, answer: { kind: "symbolSource" } });
		expect(knowledge).toMatchObject({ ok: true, answer: { kind: "symbolKnowledge" } });
		expect(hierarchy).toMatchObject({ ok: true, answer: { kind: "symbolFacet" } });
	});

	// Id served; daemon answered elsewhere.
	it("refuses a source naming a withheld module, and carries neither the name nor its text", async () => {
		const result = await ask({ kind: "symbolSource", symbolId: SERVED_ID }, { symbolSource: sourceIn(WITHHELD) });

		expect(result).toMatchObject({ ok: false, failure: "refused" });
		expect(JSON.stringify(result)).not.toContain(SECRET);
		expect(JSON.stringify(result)).not.toContain(WITHHELD);
	});

	it("refuses knowledge naming a withheld module", async () => {
		const result = await ask(
			{ kind: "symbolKnowledge", symbolId: SERVED_ID },
			{ describe: describedIn(WITHHELD), recallAnswer: () => [] },
		);

		expect(result).toMatchObject({ ok: false, failure: "refused" });
		expect(JSON.stringify(result)).not.toContain(WITHHELD);
	});

	it("refuses a hierarchy whose subject names a withheld module", async () => {
		const result = await ask(
			{ kind: "symbolFacet", symbolId: SERVED_ID, facet: { kind: "hierarchy" } },
			{ declarationOf: declaredIn(WITHHELD), typeHierarchy: emptyHierarchy },
		);

		expect(result).toMatchObject({ ok: false, failure: "refused" });
		expect(JSON.stringify(result)).not.toContain(WITHHELD);
	});

	it("leaves a save whose read-back or whose issue names a withheld module unknown, never refused", async () => {
		const readBack = await ask(save, {
			indexFile: () => ({ action: "current" }),
			refactorReplaceSpan: () => saved(),
			symbolSource: sourceIn(WITHHELD),
		});
		const issue = await ask(save, {
			indexFile: () => ({ action: "current" }),
			refactorReplaceSpan: () => saved(WITHHELD),
			symbolSource: sourceIn("src/app.ts"),
		});

		// Might have landed, so the phone rereads.
		expect(readBack).toMatchObject({ ok: false, failure: "failed" });
		expect(issue).toMatchObject({ ok: false, failure: "failed" });
		expect(answerForConsole(save, readBack)).toMatchObject({ kind: "saveSpan", outcome: "unknown" });
		expect(JSON.stringify([readBack, issue])).not.toContain(SECRET);
	});

	it("answers a save whose read-back and issue are served", async () => {
		const result = await ask(save, {
			indexFile: () => ({ action: "current" }),
			refactorReplaceSpan: () => saved("src/other.ts"),
			symbolSource: sourceIn("src/app.ts"),
		});

		expect(result).toMatchObject({ ok: true, answer: { kind: "saveSpan", outcome: "saved" } });
	});
});

describe("the fields the gate reads off the schemas", () => {
	// New fields sort automatically, gated or plain.
	it("sorts every string field an answer declares into gated and plain", () => {
		const gated = gatedAnswerFields();

		expect([...gated.keys()].sort()).toEqual(["containerId", "module", "path", "symbolId"]);
		expect(declaredStringFields().filter((name) => !gated.has(name))).toEqual([
			"author",
			"container",
			"detail",
			"documentation",
			"form",
			"hash",
			"identity",
			"kind",
			"language",
			"name",
			"outcome",
			"prose",
			"question",
			"readOnly",
			"reason",
			"role",
			"root",
			"signature",
			"spanHash",
			"state",
			"status",
			"subject",
			"symbolKind",
			"text",
			"textHash",
		]);
	});

	it("reaches a nested field, and both names a shared schema is used under", () => {
		const shared = z.string();
		const grown = z.object({
			kind: z.literal("grown"),
			symbolId: shared,
			containerId: shared,
			note: shared,
			rows: z.array(z.object({ sourceModule: z.string().optional() })),
		});

		expect([...gatedAnswerFields(grown)].sort()).toEqual([
			["containerId", "id"],
			["sourceModule", "module"],
			["symbolId", "id"],
		]);
	});
});
