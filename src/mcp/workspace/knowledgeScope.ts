// What an Ask covers: each declaration in a scope with every question's state, members first.

import type { KnowledgeScopeTarget, ScopeSymbol, WorkspaceOpResult } from "../../shared/workspace-op.js";
import { confine } from "./confine.js";
import { byDeadline, confinedModule, type OpContext, refused, rootLabel, servedGate } from "./handlerKit.js";

////////////////////////////////
//  Functions & Helpers

export async function knowledgeScopeOf(
	context: OpContext,
	target: KnowledgeScopeTarget,
	includeLocals: boolean,
): Promise<WorkspaceOpResult> {
	const { deps, root, deadline } = context;
	let module: string;
	let request:
		| { symbolId: string; members: boolean; includeLocals: boolean }
		| { module: string; includeLocals: boolean };
	if (target.kind === "file") {
		const place = confine(root, target.path);
		if (!place.ok) return refused(place.refusal.detail);
		if (place.relative === "") return refused("a module path is required");
		module = place.relative;
		request = { module, includeLocals };
	} else {
		const confined = confinedModule(root, target.symbolId);
		if (confined === null) return refused("that symbol's module is not served");
		module = confined;
		request = { symbolId: target.symbolId, members: target.kind === "members", includeLocals };
	}

	const session = await byDeadline(deadline, deps.session);
	const scope = await byDeadline(deadline, () => session.knowledgeScope(request));
	if (scope === null) return refused("no symbol with that id is indexed");

	// Every id is gated, not only the op's subject.
	const gate = servedGate(root);
	const symbols = scope.symbols
		.filter(({ symbol }) => gate.module(symbol.module) !== null && gate.id(symbol.symbolId))
		.map(
			({ symbol, depth, questions }): ScopeSymbol => ({
				symbolId: symbol.symbolId,
				name: symbol.name,
				symbolKind: symbol.kind,
				depth,
				// Lexicon counts lines from zero.
				...(symbol.lines === undefined ? {} : { startLine: symbol.lines.start + 1 }),
				...(symbol.containerId === undefined || !gate.id(symbol.containerId)
					? {}
					: { containerId: symbol.containerId }),
				questions: questions.map((entry) => ({
					question: entry.question,
					askCount: entry.askCount,
					...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
					...(entry.thin === undefined ? {} : { thin: entry.thin }),
					...(entry.stale === undefined ? {} : { stale: entry.stale }),
					...(entry.shaky === undefined ? {} : { shaky: entry.shaky }),
					...(entry.doubted === undefined ? {} : { doubted: entry.doubted }),
				})),
			}),
		);
	return {
		ok: true,
		answer: {
			kind: "knowledgeScope",
			root: rootLabel(root),
			module,
			symbols,
			localsExcluded: scope.localsExcluded,
		},
	};
}
