import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GATEWAY_RELAY_TIMEOUT_MS } from "../federation-server/relayTimeouts.js";
import {
	answerForConsole,
	boundsOf,
	CONSOLE_ANSWER_WAIT_MS,
	WORKSPACE_BOUNDS,
	WORKSPACE_HOP_MARGIN_MS,
	type WorkspaceOp,
} from "../shared/workspace-op.js";

const CONSOLE_HTTP = path.join(
	__dirname,
	"../../android/app/src/main/java/com/atelier_nyaarium/switchboard/ConsoleHttp.kt",
);

// Each side giving up before the one inside it answers is a blind timeout: the owner is told nothing
// happened while the work lands.
describe("the bounds on one workspace op, outermost first", () => {
	it("starts from the phone's own read timeout, which no gate here runs", () => {
		const kotlin = fs.readFileSync(CONSOLE_HTTP, "utf8");
		const declared = kotlin.match(/PINNED_READ_TIMEOUT_MS\s*=\s*([\d_]+)L/);

		expect(declared, "ConsoleHttp.PINNED_READ_TIMEOUT_MS is no longer declared as a literal").not.toBeNull();
		expect(Number((declared?.[1] ?? "").replaceAll("_", ""))).toBe(CONSOLE_ANSWER_WAIT_MS);
	});

	it.each(
		Object.entries(WORKSPACE_BOUNDS),
	)("nests the %s bounds inside the phone and the Router", (_name, bounds) => {
		expect(bounds.handlerBudgetMs).toBeLessThan(bounds.planeWaitMs);
		expect(bounds.planeWaitMs + WORKSPACE_HOP_MARGIN_MS).toBeLessThanOrEqual(CONSOLE_ANSWER_WAIT_MS);
		expect(GATEWAY_RELAY_TIMEOUT_MS).toBeGreaterThanOrEqual(CONSOLE_ANSWER_WAIT_MS);
	});

	it("gives a write the save bounds and every read the read bounds", () => {
		const reads: WorkspaceOp[] = [
			{ kind: "tree", path: "" },
			{ kind: "read", path: "a" },
			{ kind: "outline", path: "a" },
			{ kind: "symbolSource", symbolId: "s" },
			{ kind: "symbolKnowledge", symbolId: "s" },
			{ kind: "fileState", path: "a" },
		];
		for (const op of reads) expect(boundsOf(op)).toBe(WORKSPACE_BOUNDS.read);
		expect(boundsOf({ kind: "saveSpan", symbolId: "s", expectedSpanHash: "h", text: "" })).toBe(
			WORKSPACE_BOUNDS.save,
		);
		for (const op of mutations) expect(boundsOf(op)).toBe(WORKSPACE_BOUNDS.save);
	});
});

const DESTINATION = { kind: "absent" } as const;

const mutations: WorkspaceOp[] = [
	{ kind: "write", path: "src/a.ts", expectedHash: "h", text: "x" },
	{ kind: "create", path: "src/a.ts", text: "" },
	{ kind: "delete", path: "src/a.ts", expectedHash: "h", expectedIdentity: "i" },
	{ kind: "move", path: "src/a.ts", expectedHash: "h", expectedIdentity: "i", to: "b.ts", destination: DESTINATION },
	{ kind: "copy", path: "src/a.ts", expectedHash: "h", to: "b.ts", destination: DESTINATION },
].map((mutation) => ({ kind: "mutateFile", mutation }) as WorkspaceOp);

const write = mutations[0];

describe("what the phone is told when the plane fails", () => {
	const save: WorkspaceOp = { kind: "saveSpan", symbolId: "s", expectedSpanHash: "h", text: "x" };
	const read: WorkspaceOp = { kind: "symbolSource", symbolId: "s" };

	// Only refusal proves no write; other failures may land, so reread.
	it.each([
		"timeout",
		"disconnected",
		"failed",
		"too_large",
	] as const)("answers a write that %s as unknown", (failure) => {
		expect(answerForConsole(save, { ok: false, failure, detail: "d" })).toMatchObject({
			kind: "saveSpan",
			outcome: "unknown",
		});
		for (const mutation of mutations) {
			expect(answerForConsole(mutation, { ok: false, failure, detail: "d" })).toMatchObject({
				kind: "mutateFile",
				path: "src/a.ts",
				outcome: "unknown",
			});
		}
	});

	it("keeps a refused write and every failed read as the error the phone shows", () => {
		expect(() => answerForConsole(save, { ok: false, failure: "refused", detail: "withheld" })).toThrow("withheld");
		expect(() => answerForConsole(write, { ok: false, failure: "refused", detail: "withheld" })).toThrow(
			"withheld",
		);
		expect(() => answerForConsole(read, { ok: false, failure: "timeout", detail: "slow" })).toThrow(
			"timeout: slow",
		);
	});
});
