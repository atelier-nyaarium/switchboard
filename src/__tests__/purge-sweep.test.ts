import { describe, expect, it } from "vitest";
import type { PurgeItem } from "../gateway/purgeQueue.js";
import { createPurgeSweep, orphanedNames, SWEEP_REST_MS } from "../gateway/purgeSweep.js";
import type { AgentBackendId } from "../shared/agent-backend.js";
import type { AgentExecutionTarget } from "../shared/agent-execution-target.js";
import type { PersistedAgent } from "../shared/agent-persisted.js";
import type { HostOp, ListedThread } from "../shared/host-op.js";
import type { SweepOrphanNames, SweepPlan } from "../shared/schemasPurgeSweep.js";
import type { SessionRecord } from "../shared/session-store.js";

const NOW = 10 * 24 * 60 * 60_000;
const OLD = NOW - 4 * SWEEP_REST_MS;
/** When the roster's OpenCode session last touched its own conversation. */
const SINCE = NOW - 3 * SWEEP_REST_MS;
const HOST: AgentExecutionTarget = { kind: "host", workdirHint: "~" };
const BOX: AgentExecutionTarget = { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/p/recipe-app" };

const thread = (threadId: string, updatedAt: number | null = OLD, parentId: string | null = null): ListedThread => ({
	threadId,
	updatedAt,
	parentId,
});

function agent(agentId: string, sessionId: string, over: Partial<PersistedAgent> = {}): PersistedAgent {
	return { agentId, sessionId, agentState: "idle", turns: [], operations: [], ...over } as unknown as PersistedAgent;
}

function rig(
	options: {
		stores?: Partial<Record<string, ListedThread[] | Error>>;
		sessions?: SessionRecord[];
		agents?: Array<{ owner: SessionRecord; backend: AgentBackendId; agent: PersistedAgent }>;
		running?: string[];
		daemon?: boolean;
		orphans?: SweepOrphanNames;
		unread?: string[];
		asleep?: string[];
	} = {},
) {
	const stores = options.stores ?? {};
	const asked: string[] = [];
	const ended: Array<[string, AgentBackendId, string[]]> = [];
	const queued: PurgeItem[] = [];
	let saves = 0;
	const orphans = options.orphans ?? { claims: ["host.gone", "recipe-app.gone"], teams: ["host.gone"], jobs: 3 };
	const dropped: SweepOrphanNames[] = [];
	const sweep = createPurgeSweep({
		relay: async (op: HostOp) => {
			if (op.kind !== "threads") throw new Error("not a listing");
			const key = `${op.target.kind === "host" ? "host" : op.target.project}/${op.backend}`;
			asked.push(key);
			const held = stores[key] ?? [];
			return held instanceof Error ? { ok: false, error: held.message } : { ok: true, result: { threads: held } };
		},
		places: () =>
			options.daemon === false ? undefined : { up: [HOST, BOX], stopped: ["godot-game"], unreached: ["windows"] },
		sessions: () => options.sessions ?? [],
		unreadIds: () => options.unread ?? [],
		live: (record) => !(options.asleep ?? []).includes(record.id),
		agents: (owner) => (options.agents ?? []).filter((held) => held.owner === owner),
		runRunning: (runId) => (options.running ?? []).includes(runId),
		endThreads: (owner, backend, agentIds) => {
			ended.push([owner.id, backend, [...agentIds].sort()]);
			return agentIds.size;
		},
		purges: { add: (items) => void queued.push(...items) },
		save: () => {
			saves += 1;
		},
		orphans: () => ({ ...orphans, claims: [...orphans.claims], teams: [...orphans.teams] }),
		dropOrphans: (found) => {
			dropped.push(found);
			return { claims: found.claims.length, jobs: found.jobs };
		},
		now: () => NOW,
	});
	const row = (plan: SweepPlan | undefined, place: string, backend: AgentBackendId) =>
		plan?.rows.find((held) => held.place === place && held.backend === backend);
	return { sweep, asked, ended, queued, row, orphans, dropped, saves: () => saves };
}

const session = (id: string, over: Partial<SessionRecord> = {}): SessionRecord =>
	({ id, spawn: "host", sessionLabel: id, lastSeen: 0, harness: "claude", ...over }) as SessionRecord;

describe("the one sweep", () => {
	it("keeps a roster session's own conversation and what it spawned, and sorts the rest", async () => {
		const main = session("oc", { harness: "opencode", mintedSessionId: "ses_main" });
		// Asleep, so its missing conversation holds nothing back.
		const dormant = session("oc-old", { harness: "opencode", mintedSessionId: "ses_never_listed" });
		const owner = session("work");
		const r = rig({
			sessions: [main, dormant, owner],
			asleep: ["oc-old"],
			unread: ["ses_unread"],
			agents: [
				{ owner, backend: "opencode", agent: agent("a-idle", "ses_idle") },
				{ owner, backend: "opencode", agent: agent("a-busy", "ses_busy", { agentState: "working" }) },
				{ owner, backend: "opencode", agent: agent("a-run", "ses_run", { runId: "run-1" }) },
				{ owner, backend: "opencode", agent: agent("a-done", "ses_done", { runId: "run-0" }) },
			],
			running: ["run-1"],
			stores: {
				"host/opencode": [
					thread("ses_main", SINCE),
					thread("ses_child", OLD, "ses_main"),
					thread("ses_grandchild", OLD, "ses_child"),
					thread("ses_unread"),
					thread("ses_idle", NOW),
					thread("ses_busy"),
					thread("ses_under_busy", OLD, "ses_busy"),
					thread("ses_run"),
					thread("ses_done"),
					thread("ses_old"),
					thread("ses_recent", NOW - 1_000),
					thread("ses_untimed", null),
					// The session's own CLI may have moved to it.
					thread("ses_moved", SINCE + 1),
					thread("ses_orphan", OLD, "ses_unlisted"),
				],
			},
		});

		const answer = await r.sweep({});

		expect(answer).toMatchObject({ applied: false, reason: "dry_run" });
		expect(r.row(answer.plan, "host", "opencode")).toEqual({
			place: "host",
			backend: "opencode",
			listed: 14,
			kept: 4,
			running: 3,
			unreadable: 4,
			agents: 2,
			unnamed: 1,
			liveSince: SINCE,
		});
		expect(answer.plan).toMatchObject({
			stopped: ["godot-game"],
			unreached: ["windows"],
			orphans: { claims: 2, jobs: 3 },
		});
		// A dry run asks every store at every place that is up, and changes nothing.
		expect(r.asked.sort()).toEqual(
			["codex", "copilot", "opencode"].flatMap((backend) => [`host/${backend}`, `recipe-app/${backend}`]).sort(),
		);
		expect([r.ended, r.queued, r.saves(), r.dropped]).toEqual([[], [], 0, []]);
	});

	it("deletes exactly the set its fingerprint named, and shows a set that moved again", async () => {
		const owner = session("work");
		const stores = { "host/codex": [thread("t-agent"), thread("t-old")], "recipe-app/codex": [thread("t-box")] };
		const r = rig({
			sessions: [owner],
			agents: [{ owner, backend: "codex", agent: agent("a-1", "t-agent") }],
			stores,
		});
		const shown = (await r.sweep({})).plan as SweepPlan;

		expect(await r.sweep({ apply: true })).toMatchObject({ applied: false, reason: "changed" });
		stores["host/codex"].push(thread("t-new"));
		const moved = await r.sweep({ apply: true, expect: shown.fingerprint });
		expect(moved).toMatchObject({ applied: false, reason: "changed" });
		expect(moved.plan?.fingerprint).not.toBe(shown.fingerprint);
		// A name earlier forgets left is part of the set.
		r.orphans.claims.push("host.late");
		const grown = await r.sweep({ apply: true, expect: moved.plan?.fingerprint });
		expect(grown).toMatchObject({ applied: false, reason: "changed", plan: { orphans: { claims: 3 } } });
		expect([r.ended, r.queued, r.saves(), r.dropped]).toEqual([[], [], 0, []]);

		const done = await r.sweep({ apply: true, expect: grown.plan?.fingerprint });

		expect(done).toMatchObject({ applied: true, ended: 1, queued: 3, orphans: { claims: 3, jobs: 3 } });
		expect(r.ended).toEqual([["work", "codex", ["a-1"]]]);
		expect(r.queued).toEqual([
			{ place: HOST, what: { kind: "thread", backend: "codex", threadId: "t-old" } },
			{ place: HOST, what: { kind: "thread", backend: "codex", threadId: "t-new" } },
			{
				place: { kind: "devcontainer", project: "recipe-app" },
				what: { kind: "thread", backend: "codex", threadId: "t-box" },
			},
		]);
		expect(r.saves()).toBe(1);
		expect(r.dropped).toEqual([
			{ claims: ["host.gone", "recipe-app.gone", "host.late"], teams: ["host.gone"], jobs: 3 },
		]);
	});

	it("sweeps nothing at a store it could not list, and says so", async () => {
		const r = rig({
			stores: { "host/codex": new Error("codex is not installed"), "host/copilot": [thread("c-old")] },
		});

		const answer = await r.sweep({});

		expect(r.row(answer.plan, "host", "codex")).toMatchObject({
			listed: 0,
			unnamed: 0,
			error: "codex is not installed",
		});
		expect(r.row(answer.plan, "host", "copilot")).toMatchObject({ listed: 1, unnamed: 1 });
		expect(await rig({ daemon: false }).sweep({ apply: true, expect: "x" })).toEqual({
			applied: false,
			reason: "no_daemon",
		});
	});

	it("names what earlier forgets left: a session name with no record behind it", () => {
		const held = (team: string) => team === "host.live";

		expect(
			orphanedNames(
				["host.live", "host.gone", "recipe-app.gone"],
				["host.gone", "host.gone", "host.live", "host", "owner", "dom.gw.host.far"],
				held,
			),
		).toEqual({ claims: ["host.gone", "recipe-app.gone"], teams: ["host.gone"] });
	});
});
