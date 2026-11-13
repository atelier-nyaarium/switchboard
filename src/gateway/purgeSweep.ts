// The one sweep: every thread an agent backend's store holds that no roster record or agent names.

import { createHash } from "node:crypto";
import { AGENT_BACKENDS, type AgentBackendId } from "../shared/agent-backend.js";
import type { AgentExecutionTarget } from "../shared/agent-execution-target.js";
import type { PersistedAgent } from "../shared/agent-persisted.js";
import { type HostOp, type HostOpResult, HostThreadsResultSchema, type ListedThread } from "../shared/host-op.js";
import { HOST_SPAWN } from "../shared/host-spawn.js";
import type { SweepAnswer, SweepOrphanNames, SweepOrphans, SweepPlan, SweepRow } from "../shared/schemasPurgeSweep.js";
import { HARNESS } from "../shared/session-harness.js";
import { isValidSessionName } from "../shared/session-id.js";
import { resumeIdOf, type SessionRecord } from "../shared/session-store.js";
import { type PurgeItem, purgePlaceOf } from "./purgeQueue.js";

////////////////////////////////
//  Interfaces & Types

export interface PurgeSweepDeps {
	relay(op: HostOp): Promise<HostOpResult>;
	/** Undefined while no daemon is connected. */
	places(): { up: AgentExecutionTarget[]; stopped: string[]; unreached: string[] } | undefined;
	sessions(): SessionRecord[];
	/** Thread ids named by records the store holds unread. */
	unreadIds(): string[];
	/** Whether the session's own CLI is connected now. */
	live(record: SessionRecord): boolean;
	agents(owner: SessionRecord): Array<{ backend: AgentBackendId; agent: PersistedAgent }>;
	runRunning(runId: string): boolean;
	/** Ends the named agents' threads; answers how many. */
	endThreads(owner: SessionRecord, backend: AgentBackendId, agentIds: ReadonlySet<string>, at: number): number;
	purges: { add(items: readonly PurgeItem[]): unknown };
	save(): void;
	orphans(): SweepOrphanNames;
	/** Drops exactly the names surveyed. */
	dropOrphans(found: SweepOrphanNames): SweepOrphans;
	now(): number;
}

type Verdict = "kept" | "running" | "unreadable" | "agents" | "unnamed";

interface Sorted {
	row: SweepRow;
	/** Agents to end, by owner. */
	ending: Map<SessionRecord, Set<string>>;
	unnamed: PurgeItem[];
	/** One line per thread an apply deletes. */
	lines: string[];
}

////////////////////////////////
//  Constants

/** A thread no record names is taken as at rest once its store has not touched it this long. */
export const SWEEP_REST_MS = 60 * 60_000;

////////////////////////////////
//  Functions & Helpers

const labelOf = (target: AgentExecutionTarget): string => (target.kind === "host" ? "host" : target.project);

/** The agent backend whose store holds a session CLI's own conversation. */
function ownBackendOf(record: SessionRecord): AgentBackendId | undefined {
	if (!record.harness) return undefined;
	const how = HARNESS[record.harness].conversation;
	return how.delete === "thread" ? how.backend : undefined;
}

const livesAt = (record: SessionRecord, target: AgentExecutionTarget): boolean =>
	target.kind === "host" ? record.spawn === HOST_SPAWN : record.spawn === target.project;

/** A turn runs, an operation is unanswered, or the daemon may still hold it. */
function busy(agent: PersistedAgent): boolean {
	return (
		agent.agentState === "working" ||
		agent.agentState === "recovering" ||
		agent.agentState === "creating" ||
		agent.turns.some((turn) => turn.state === "inProgress") ||
		agent.operations.some((operation) => operation.state === "requested")
	);
}

/** Session names the Gateway's own stores still hold with no record behind them. */
export function orphanedNames(
	claimed: readonly string[],
	jobTargets: readonly string[],
	held: (team: string) => boolean,
): { claims: string[]; teams: string[] } {
	return {
		claims: claimed.filter((team) => isValidSessionName(team) && !held(team)),
		teams: [...new Set(jobTargets)].filter((team) => isValidSessionName(team) && !held(team)),
	};
}

export function createPurgeSweep(
	deps: PurgeSweepDeps,
): (input: { apply?: boolean; expect?: string }) => Promise<SweepAnswer> {
	async function listed(target: AgentExecutionTarget, backend: AgentBackendId): Promise<ListedThread[] | string> {
		let answer: HostOpResult;
		try {
			answer = await deps.relay({ kind: "threads", backend, target });
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		if (!answer.ok) return answer.error ?? answer.errorKind ?? "the daemon refused";
		const parsed = HostThreadsResultSchema.safeParse(answer.result);
		return parsed.success ? parsed.data.threads : "the daemon's answer could not be read";
	}

	function sort(target: AgentExecutionTarget, backend: AgentBackendId, threads: ListedThread[]): Sorted {
		const row: SweepRow = {
			place: labelOf(target),
			backend,
			listed: threads.length,
			kept: 0,
			running: 0,
			unreadable: 0,
			agents: 0,
			unnamed: 0,
		};
		const sessions = deps.sessions();
		const own = sessions.filter((record) => ownBackendOf(record) === backend);
		const mains = new Set([...own.flatMap((record) => resumeIdOf(record) ?? []), ...deps.unreadIds()]);
		const named = new Map<string, { owner: SessionRecord; agent: PersistedAgent }>();
		for (const owner of sessions) {
			for (const held of deps.agents(owner)) {
				if (held.backend === backend && held.agent.sessionId)
					named.set(held.agent.sessionId, { owner, agent: held.agent });
			}
		}
		const byId = new Map(threads.map((thread) => [thread.threadId, thread]));
		/**
		 * A running session CLI can move to another conversation without its record following. A thread
		 * touched since that session last touched its own may be the one it is in, so it is left.
		 */
		const liveSince = own
			.filter((record) => livesAt(record, target) && deps.live(record))
			.map((record) => byId.get(resumeIdOf(record) ?? "")?.updatedAt ?? 0)
			.reduce<number | undefined>((least, at) => (least === undefined ? at : Math.min(least, at)), undefined);
		if (liveSince !== undefined) row.liveSince = liveSince;
		const now = deps.now();
		const alone = (thread: ListedThread): Verdict => {
			if (mains.has(thread.threadId)) return "kept";
			const record = named.get(thread.threadId);
			if (record) {
				const inRun = record.agent.runId !== undefined && deps.runRunning(record.agent.runId);
				return busy(record.agent) || inRun ? "running" : "agents";
			}
			if (thread.updatedAt === null || now - thread.updatedAt < SWEEP_REST_MS) return "unreadable";
			return liveSince !== undefined && thread.updatedAt >= liveSince ? "unreadable" : "unnamed";
		};
		const verdicts = new Map<string, Verdict>();
		/** A thread spawned under one that stays, stays as it does. */
		const verdictOf = (thread: ListedThread, walked = new Set<string>()): Verdict => {
			const held = verdicts.get(thread.threadId);
			if (held) return held;
			let verdict = alone(thread);
			if (thread.parentId && verdict !== "kept" && !walked.has(thread.threadId)) {
				walked.add(thread.threadId);
				const parent = byId.get(thread.parentId);
				// A parent the listing lacks cannot be judged.
				const above = parent ? verdictOf(parent, walked) : "unreadable";
				if (above === "kept") verdict = "kept";
				else if (above !== "agents" && above !== "unnamed" && verdict !== "running") verdict = above;
			}
			verdicts.set(thread.threadId, verdict);
			return verdict;
		};
		const sorted: Sorted = { row, ending: new Map(), unnamed: [], lines: [] };
		for (const thread of threads) {
			const verdict = verdictOf(thread);
			row[verdict] += 1;
			if (verdict === "agents") {
				const record = named.get(thread.threadId);
				if (!record) continue;
				const ids = sorted.ending.get(record.owner) ?? new Set<string>();
				ids.add(record.agent.agentId);
				sorted.ending.set(record.owner, ids);
			} else if (verdict === "unnamed") {
				sorted.unnamed.push({
					place: purgePlaceOf(target),
					what: { kind: "thread", backend, threadId: thread.threadId },
				});
			} else continue;
			sorted.lines.push(`${row.place}\t${backend}\t${thread.threadId}`);
		}
		return sorted;
	}

	async function survey(): Promise<
		{ plan: SweepPlan; sorted: Array<Sorted & { backend: AgentBackendId }>; orphans: SweepOrphanNames } | undefined
	> {
		const places = deps.places();
		if (!places) return undefined;
		const pairs = places.up.flatMap((target) => AGENT_BACKENDS.map(({ id }) => ({ target, backend: id })));
		// Together: each listing may open a CLI's client.
		const answers = await Promise.all(pairs.map((pair) => listed(pair.target, pair.backend)));
		const sorted: Array<Sorted & { backend: AgentBackendId }> = [];
		const rows: SweepRow[] = [];
		for (const [index, pair] of pairs.entries()) {
			const answer = answers[index] as ListedThread[] | string;
			if (typeof answer === "string") {
				rows.push({
					place: labelOf(pair.target),
					backend: pair.backend,
					listed: 0,
					kept: 0,
					running: 0,
					unreadable: 0,
					agents: 0,
					unnamed: 0,
					error: answer.slice(0, 200),
				});
				continue;
			}
			const held = sort(pair.target, pair.backend, answer);
			sorted.push({ ...held, backend: pair.backend });
			rows.push(held.row);
		}
		const orphans = deps.orphans();
		const lines = [
			...sorted.flatMap((held) => held.lines),
			...orphans.claims.map((name) => `claim\t${name}`),
			...orphans.teams.map((team) => `jobs\t${team}`),
		].sort();
		const fingerprint = createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
		return {
			plan: {
				rows,
				stopped: [...places.stopped].sort(),
				unreached: [...places.unreached].sort(),
				orphans: { claims: orphans.claims.length, jobs: orphans.jobs },
				fingerprint,
			},
			sorted,
			orphans,
		};
	}

	return async ({ apply, expect }) => {
		const surveyed = await survey();
		if (!surveyed) return { applied: false, reason: "no_daemon" };
		const { plan, sorted, orphans } = surveyed;
		if (!apply) return { applied: false, reason: "dry_run", plan };
		// A set that moved since its counts were shown is shown again.
		if (expect !== plan.fingerprint) return { applied: false, reason: "changed", plan };
		const now = deps.now();
		let ended = 0;
		let queued = 0;
		for (const held of sorted) {
			for (const [owner, agentIds] of held.ending) ended += deps.endThreads(owner, held.backend, agentIds, now);
			deps.purges.add(held.unnamed);
			queued += held.unnamed.length;
		}
		deps.save();
		return { applied: true, plan, queued, ended, orphans: deps.dropOrphans(orphans) };
	};
}
