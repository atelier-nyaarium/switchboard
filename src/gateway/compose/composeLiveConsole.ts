import { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import type { LiveConsoleAnswer } from "../../shared/schemasLiveConsole.js";
import { SESSION_COMMANDS } from "../../shared/session-commands.js";
import { type ConsoleReaders, consoleEntities } from "../liveConsole/entities.js";
import { evaluateConsole } from "../liveConsole/evaluate.js";
import { type ConsoleAudience, createConsoleRegistry } from "../liveConsole/registry.js";
import { renderConsoleIssue, renderConsoleValue } from "../liveConsole/render.js";

const COMMAND = SESSION_COMMANDS.console;

type Handler = (req: Request, body: unknown) => Promise<Response>;

export type ConsoleCaller = ConsoleAudience | "unauthenticated" | "not_served";

export interface LiveConsoleStageDeps {
	ambient: Ambient;
	readers: ConsoleReaders;
	callerOf: (req: Request) => ConsoleCaller;
}

export interface LiveConsoleStage {
	routes: Map<string, Handler>;
	answer: (audience: ConsoleAudience, expr?: string, limit?: number) => Promise<LiveConsoleAnswer>;
}

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function composeLiveConsole(deps: LiveConsoleStageDeps): LiveConsoleStage {
	const registry = createConsoleRegistry(consoleEntities(deps.readers));

	const answer = async (audience: ConsoleAudience, expr?: string, limit?: number): Promise<LiveConsoleAnswer> => {
		const registryHash = registry.hash(audience);
		if (expr === undefined || expr.trim() === "")
			return { kind: "ok", text: registry.describe(audience), registryHash };
		const result = await evaluateConsole(expr, registry, audience);
		if (!result.ok) return { kind: "error", text: renderConsoleIssue(expr, result.issue), issue: result.issue };
		const rendered = renderConsoleValue(result.value, { now: deps.ambient.now(), ...(limit ? { limit } : {}) });
		return { kind: "ok", text: rendered.text, registryHash, ...(rendered.cut ? { cut: rendered.cut } : {}) };
	};

	return { routes: consoleRoutes(deps.callerOf, answer), answer };
}

function consoleRoutes(
	callerOf: LiveConsoleStageDeps["callerOf"],
	answer: LiveConsoleStage["answer"],
): Map<string, Handler> {
	const evaluate: Handler = async (req, body) => {
		const parsed = z.object(COMMAND.request).safeParse(body);
		if (!parsed.success) return json({ error: "expr must be text and limit a whole number" }, 400);
		const caller = callerOf(req);
		if (caller === "unauthenticated" || caller === "not_served") return json({ kind: caller }, 200);
		return json(await answer(caller, parsed.data.expr, parsed.data.limit), 200);
	};

	return new Map([[COMMAND.path, evaluate]]);
}
