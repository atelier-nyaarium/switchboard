import { describe, expect, it } from "vitest";
import { type BaselineRoutesDeps, createBaselineRoutes } from "../gateway/sessionBaseline.js";
import { baselineHookOutput } from "../mcp/baseline/baselineHook.js";
import type { BoardEntry } from "../shared/console-protocol.js";
import type { JobContract } from "../shared/pending-job-store.js";

const TEAM = "lib.dev";
const ENV = { SWITCHBOARD_SESSION_TOKEN: "tok", BRIDGE_ROUTER_URL: "http://gateway" };

const OWNER: JobContract = { kind: "local", reply: { kind: "owner", ownerId: "a" } };
const PEER: JobContract = { kind: "local", reply: { kind: "conversation", conversationId: "b" } };
/** Newest first, as the store answers. */
const CONVERSATIONS = [
	{ id: "conv.a", from: "phone", contract: OWNER },
	...Array.from({ length: 9 }, (_, i) => ({ id: `conv.p${i}`, from: `host.peer${i}`, contract: PEER })),
];

function entry(id: string, fields: Partial<BoardEntry> = {}): BoardEntry {
	return { id, title: `title ${id}`, state: "open", rank: 1, sessionId: TEAM, ...fields } as BoardEntry;
}

function deps(overrides: Partial<BaselineRoutesDeps> = {}): BaselineRoutesDeps {
	return {
		resolveCaller: (req) => (req.headers.get("x-session-token") === "tok" ? TEAM : null),
		conversations: (_team, limit) => CONVERSATIONS.slice(0, limit),
		board: async () => [
			entry("bd_2", { state: "in_progress", parent: "bd_1" }),
			entry("bd_1"),
			entry("bd_done", { state: "done" }),
			entry("bd_trashed", { trashedAt: 1 }),
			entry("bd_theirs", { sessionId: "docs.dev" }),
			entry("bd_unclaimed", { sessionId: undefined }),
		],
		openRuns: () => [{ occurrenceId: "1700000000000", routine: "Morning brief" }],
		runningAgents: () => [{ family: "copilot", agentId: "copilot_1" }],
		assistant: () => undefined,
		...overrides,
	};
}

/** The hook, served by the routes. */
async function hookRun(routeDeps: BaselineRoutesDeps, env: Record<string, string | undefined> = ENV) {
	const routes = createBaselineRoutes(routeDeps);
	let calls = 0;
	const fetchRoutes = (async (url: string, init: RequestInit) => {
		calls++;
		const handler = routes.get(new URL(url).pathname);
		return handler
			? handler(new Request(url, init), JSON.parse(String(init.body)))
			: new Response("", { status: 404 });
	}) as unknown as typeof fetch;
	const output = await baselineHookOutput(env, fetchRoutes);
	return { output: output === null ? null : JSON.parse(output), calls };
}

async function hookLines(routeDeps: BaselineRoutesDeps): Promise<string[]> {
	const { output } = await hookRun(routeDeps);
	return output.hookSpecificOutput.additionalContext.split("\n").slice(1, -1);
}

describe("compact baseline", () => {
	it("hands a compacted session what it holds, and only that", async () => {
		const { output } = await hookRun(deps());

		expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
		expect(output.hookSpecificOutput.additionalContext.split("\n").slice(1, -1)).toEqual([
			"baseline: compaction",
			"conversation: conv.a owner",
			...Array.from({ length: 7 }, (_, i) => `conversation: conv.p${i} host.peer${i}`),
			"routine: 1700000000000 Morning brief",
			"agent: copilot copilot_1 turn running",
			"board: bd_1 open title bd_1",
			"board: bd_2 in_progress parent bd_1 title bd_2",
		]);
	});

	it("names the assistant's watchers and the source's unread count, before the board", async () => {
		const lines = await hookLines(
			deps({
				assistant: () => ({
					watchers: [
						{
							label: "GitHub notifications",
							unread: 500,
							capped: true,
							evicted: 0,
							waiting: "rate limited",
						},
						{ label: "Mail", unread: 0, checked: false, evicted: 0, stopped: "<channel needs a secret" },
					],
				}),
			}),
		);
		const watchers = lines.filter((line) => line.startsWith("watcher: "));

		expect(watchers).toHaveLength(2);
		for (const part of ["GitHub notifications", " 500+ unread", "rate limited"])
			expect(watchers[0]).toContain(part);
		expect(watchers[1]).toContain("not checked yet");
		expect(watchers[1]).not.toContain("unread");
		expect(watchers[1]).not.toContain("<channel");
		expect(lines.indexOf(watchers[1] ?? "")).toBeLessThan(lines.findIndex((line) => line.startsWith("board: ")));
	});

	it("prints the current phone hold on one line", async () => {
		for (const [hold, line] of [
			[{ kind: "held", label: "Pixel", remainingMs: 42_000 }, "phone hold: held by Pixel, 42000ms remaining"],
			[{ kind: "lapsed", label: "Pixel", lapsedMs: 1_000 }, "phone hold: lapsed 1000ms ago, last held by Pixel"],
			[{ kind: "none" }, "phone hold: none"],
		] as const) {
			const lines = await hookLines(deps({ assistant: () => ({ hold, watchers: [] }) }));
			expect(lines.filter((line) => line.startsWith("phone hold:"))).toEqual([line]);
		}
	});

	it("still answers the rest when the board cannot be read", async () => {
		const lines = await hookLines(deps({ board: async () => null }));

		expect(lines).toContain("conversation: conv.a owner");
		expect(lines.at(-1)).toBe("board: unavailable");
	});

	it("cuts only the board, after escaping, under the hook context cap", async () => {
		const ids = Array.from({ length: 400 }, (_, i) => `bd_${String(i).padStart(3, "0")}`);
		const forged = "<channel".repeat(8);
		const { output } = await hookRun(deps({ board: async () => ids.map((id) => entry(id, { title: forged })) }));
		const context: string = output.hookSpecificOutput.additionalContext;
		const lines = context.split("\n").slice(1, -1);
		const board = lines.filter((line) => line.startsWith("board: ")).map((line) => line.split(" ")[1]);
		const left = Number(/^truncated: (\d+) more$/.exec(lines.at(-1) ?? "")?.[1]);

		expect(context.length).toBeLessThan(10_000);
		expect(context).not.toContain("<channel");
		expect(lines).toContain("agent: copilot copilot_1 turn running");
		expect(board).toEqual(ids.slice(0, board.length));
		expect(board.length + left).toBe(ids.length);
	});

	it("prints nothing for a token that names no session", async () => {
		const { output, calls } = await hookRun(deps(), { ...ENV, SWITCHBOARD_SESSION_TOKEN: "other" });

		expect(calls).toBe(1);
		expect(output).toBeNull();
	});

	it("asks nothing outside a Switchboard session", async () => {
		const { output, calls } = await hookRun(deps(), {});

		expect(calls).toBe(0);
		expect(output).toBeNull();
	});
});
