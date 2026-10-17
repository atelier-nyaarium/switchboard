// The loopback door a session's compact hook reads its baseline through.

import type { BoardEntry } from "../shared/console-protocol.js";
import type { JobContract } from "../shared/pending-job-store.js";
import { SESSION_BASELINE_PATH, type SessionBaseline } from "../shared/session-baseline.js";

////////////////////////////////
//  Interfaces & Types

export type Handler = (req: Request, body: unknown) => Promise<Response>;

export interface BaselineRoutesDeps {
	/** The team the caller's token resolves to, or null when it resolves to nothing. */
	resolveCaller: (req: Request) => string | null;
	conversations: (team: string, limit: number) => Array<{ id: string; from: string; contract: JobContract }>;
	/** Null when the board cannot be read. */
	board: () => Promise<readonly BoardEntry[] | null>;
	openRuns: (team: string) => SessionBaseline["routines"];
	runningAgents: (team: string) => SessionBaseline["agents"];
}

////////////////////////////////
//  Constants

const CONVERSATION_LIMIT = 8;

const UNFINISHED = new Set<BoardEntry["state"]>(["open", "in_progress", "paused"]);

////////////////////////////////
//  Functions & Helpers

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function peerOf(from: string, contract: JobContract): SessionBaseline["conversations"][number]["peer"] {
	return contract.kind === "local" && contract.reply.kind === "owner"
		? { kind: "owner" }
		: { kind: "session", name: from };
}

function heldBy(team: string, entries: readonly BoardEntry[]): NonNullable<SessionBaseline["board"]> {
	return entries
		.filter((e) => e.sessionId === team && e.trashedAt === undefined && UNFINISHED.has(e.state))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((e) => ({
			id: e.id,
			title: e.title,
			state: e.state,
			...(e.parent === undefined ? {} : { parent: e.parent }),
		}));
}

export function createBaselineRoutes(deps: BaselineRoutesDeps): Map<string, Handler> {
	const baseline: Handler = async (req) => {
		const team = deps.resolveCaller(req);
		if (!team) return json({ error: "this token names no session" }, 401);
		const entries = await deps.board();
		const answer: SessionBaseline = {
			conversations: deps
				.conversations(team, CONVERSATION_LIMIT)
				.map(({ id, from, contract }) => ({ sessionId: id, peer: peerOf(from, contract) })),
			board: entries === null ? null : heldBy(team, entries),
			routines: deps.openRuns(team),
			agents: deps.runningAgents(team),
		};
		return json(answer, 200);
	};

	return new Map<string, Handler>([[SESSION_BASELINE_PATH, baseline]]);
}
