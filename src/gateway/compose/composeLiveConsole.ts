import { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import {
	CONSOLE_VALUE_BYTES,
	CONSOLE_VARIABLES_BYTES,
	type ConsoleDescribeResult,
	type ConsoleDescription,
	type ConsoleEvalResult,
	type ConsoleIds,
	type ConsoleResultItem,
	type LiveConsoleAnswer,
} from "../../shared/schemasLiveConsole.js";
import { SESSION_COMMANDS } from "../../shared/session-commands.js";
import { neutralizeMarkup, oneLine } from "../../shared/system-reminder.js";
import { withDoing } from "../liveConsole/doing.js";
import { type ConsoleReaders, consoleEntities, consoleIds } from "../liveConsole/entities.js";
import { type ConsoleVariable, EntityRef, evaluateConsole } from "../liveConsole/evaluate.js";
import { type ConsoleHoles, holesOver } from "../liveConsole/holes.js";
import { type ConsoleAudience, createConsoleRegistry } from "../liveConsole/registry.js";
import {
	CONSOLE_ITEMS_DEFAULT,
	CONSOLE_TEXT_BYTES,
	renderConsoleIssue,
	renderConsoleValue,
} from "../liveConsole/render.js";

const COMMAND = SESSION_COMMANDS.console;

type Handler = (req: Request, body: unknown) => Promise<Response>;

export type ConsoleCaller = ConsoleAudience | "unauthenticated" | "not_served";

export interface LiveConsoleStageDeps {
	ambient: Ambient;
	readers: ConsoleReaders;
	callerOf: (req: Request) => ConsoleCaller;
}

export interface LiveConsoleOwner {
	describe: (script?: boolean) => ConsoleDescribeResult;
	ids: () => ConsoleIds;
	evaluate: (
		expr: string,
		limit?: number,
		variables?: Readonly<Record<string, ConsoleVariable>>,
	) => Promise<ConsoleEvalResult>;
}

export type LiveConsoleHoles = ConsoleHoles;

export interface LiveConsoleStage {
	routes: Map<string, Handler>;
	answer: (audience: ConsoleAudience, expr?: string, limit?: number) => Promise<LiveConsoleAnswer>;
	console: LiveConsoleOwner;
	holes: LiveConsoleHoles;
	scriptVocabulary: () => ConsoleDescription;
}

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");

function fitted(
	value: unknown,
	limit: number,
	budget: number,
): { value: unknown; bytes: number; cut?: { shown: number; total: number } } | null {
	if (!Array.isArray(value)) {
		const bytes = bytesOf(value);
		return bytes <= budget ? { value, bytes } : null;
	}
	const kept: unknown[] = [];
	let used = 2;
	for (const item of value.slice(0, limit)) {
		const size = bytesOf(item) + 1;
		if (used + size > budget) break;
		used += size;
		kept.push(item);
	}
	if (kept.length === 0 && value.length > 0) return null;
	return kept.length === value.length
		? { value: kept, bytes: used }
		: { value: kept, bytes: used, cut: { shown: kept.length, total: value.length } };
}

export function composeLiveConsole(deps: LiveConsoleStageDeps): LiveConsoleStage {
	const registry = createConsoleRegistry(withDoing(consoleEntities(deps.readers)));

	const answer = async (audience: ConsoleAudience, expr?: string, limit?: number): Promise<LiveConsoleAnswer> => {
		const registryHash = registry.hash(audience);
		if (expr === undefined || expr.trim() === "")
			return { kind: "ok", text: registry.describe(audience), registryHash };
		const result = await evaluateConsole(expr, registry, audience);
		if (!result.ok) return { kind: "error", text: renderConsoleIssue(expr, result.issue), issue: result.issue };
		const printed = result.results.filter((item) => item.assigned === undefined);
		if (printed.length === 0) {
			const saved = result.results.map((item) => item.assigned).join(", ");
			return { kind: "ok", text: `saved for this call: ${saved}`, registryHash };
		}
		const render = (value: unknown, maxBytes: number) =>
			renderConsoleValue(value, { now: deps.ambient.now(), maxBytes, ...(limit ? { limit } : {}) });
		const [only] = printed;
		if (only && printed.length === 1) {
			const block = render(only.value, CONSOLE_TEXT_BYTES);
			return { kind: "ok", text: block.text, registryHash, ...(block.cut ? { cut: block.cut } : {}) };
		}
		const headings = printed.map((item) => `> ${neutralizeMarkup(oneLine(expr.slice(item.start, item.end)))}`);
		const overhead = headings.reduce((sum, heading) => sum + Buffer.byteLength(heading, "utf8") + 3, 0);
		const share = Math.floor((CONSOLE_TEXT_BYTES - overhead) / printed.length);
		const text = printed.map((item, at) => `${headings[at]}\n${render(item.value, share).text}`).join("\n\n");
		return { kind: "ok", text, registryHash };
	};

	const owner: LiveConsoleOwner = {
		describe: (script = false) => {
			const audience: ConsoleAudience = script ? "script" : "owner";
			return { description: registry.projection(audience), registryHash: registry.hash(audience) };
		},
		ids: () => consoleIds(deps.readers),
		evaluate: async (expr, limit = CONSOLE_ITEMS_DEFAULT, variables = {}) => {
			const registryHash = registry.hash("owner");
			const tooBig = (message: string): ConsoleEvalResult => ({
				kind: "error",
				issue: { code: "too_big", start: 0, end: expr.length, message },
				registryHash,
			});
			if (bytesOf(variables) > CONSOLE_VARIABLES_BYTES) return tooBig("the saved values sent are too large");
			// No save takes an entity's name.
			const saved = Object.fromEntries(
				Object.entries(variables).filter(([name]) => registry.get(name, "owner") === null),
			);
			const result = await evaluateConsole(expr, registry, "owner", { variables: saved });
			if (!result.ok) return { kind: "error", issue: result.issue, registryHash };
			const results: ConsoleResultItem[] = [];
			let budget = CONSOLE_VALUE_BYTES;
			for (const item of result.results) {
				if (item.value instanceof EntityRef) {
					results.push({ value: null, entity: item.value.entity.name });
					continue;
				}
				// Saved results stay whole.
				const kept = fitted(item.value, item.assigned ? Number.POSITIVE_INFINITY : limit, budget);
				if (!kept || (item.assigned && kept.cut)) {
					return tooBig(
						item.assigned
							? `${item.assigned} is too large to save; narrow it, or take() fewer`
							: `the answer is over ${CONSOLE_VALUE_BYTES} bytes; narrow the expression`,
					);
				}
				budget -= kept.bytes;
				results.push({
					value: kept.value,
					...(item.type ? { type: item.type } : {}),
					...(item.assigned ? { assigned: item.assigned } : {}),
					...(kept.cut ? { cut: kept.cut } : {}),
				});
			}
			return { kind: "ok", results, registryHash };
		},
	};

	const holes = holesOver(registry);

	return {
		routes: consoleRoutes(deps.callerOf, answer),
		answer,
		console: owner,
		holes,
		scriptVocabulary: () => registry.projection("script"),
	};
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
