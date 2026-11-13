// The session cut stage.

import { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import { SESSION_COMMANDS } from "../../shared/session-commands.js";
import type { Handler } from "../routines/routineRoutes.js";
import { createSessionCuts, type SessionCuts } from "../sessionCuts.js";
import { ownTerminal } from "../sessionEnd.js";
import { resolveLiveIncarnation } from "../wsTypes.js";
import type { HostStage } from "./composeHost.js";
import type { GatewayRoutes } from "./composeRoutes.js";
import type { SessionsStage } from "./composeSessions.js";

////////////////////////////////
//  Interfaces & Types

export interface SessionCutStageDeps {
	ambient: Ambient;
	sessions: SessionsStage;
	host: HostStage;
	/** Read late: routes compose after. */
	routes: () => Pick<GatewayRoutes, "sendFromOwner" | "tellOwnerOf">;
	launching: (team: string) => boolean;
	closed: (team: string) => void;
	/** The team the caller's token resolves to, or null. */
	resolveCaller: (req: Request) => string | null;
}

export interface SessionCutStage {
	cuts: SessionCuts;
	routes: Map<string, Handler>;
}

////////////////////////////////
//  Constants

const COMMAND = SESSION_COMMANDS.sessionCutSummary;

////////////////////////////////
//  Functions & Helpers

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function composeSessionCut(deps: SessionCutStageDeps): SessionCutStage {
	const { sessions, host } = deps;
	const cuts = createSessionCuts({
		ambient: deps.ambient,
		relayToHost: host.relayToHost,
		record: (team) => sessions.sessionStore.getByTeam(team),
		ownTerminal: (record) => ownTerminal(record, (held) => sessions.sessionStore.teamOf(held)),
		isLive: (team) => Boolean(resolveLiveIncarnation(sessions.registry, sessions.sessionStore, team)),
		busy: (team) => sessions.presence.busyOf(team),
		pluginVersion: (team) => resolveLiveIncarnation(sessions.registry, sessions.sessionStore, team)?.data.version,
		launching: deps.launching,
		holdWakes: (team) => host.wakeService.hold(team),
		ask: async (request) => {
			const res = await deps.routes().sendFromOwner({ ...request, channelOnly: true });
			if (res.ok) return null;
			const answer = (await res.json().catch(() => ({}))) as { error?: string };
			return answer.error ?? `the request to "${request.to}" was not delivered`;
		},
		repoint: (team, conversationId) => {
			if (!sessions.sessionStore.repointConversation(team, conversationId)) return false;
			// A failed write retries on the persist tick.
			sessions.saveSessionsChecked();
			return true;
		},
		wake: (team) => host.wakeService.tryWakeTeam(team, undefined, { retain: true }),
		closed: deps.closed,
		tellOwner: (team, told, identity) => {
			if (!deps.routes().tellOwnerOf(team, told, identity)) {
				console.warn(`[cut] ${team}: its end was not told: ${told.body}`);
			}
		},
	});

	return { cuts, routes: summaryRoutes(cuts, deps.resolveCaller) };
}

function summaryRoutes(cuts: SessionCuts, resolveCaller: (req: Request) => string | null): Map<string, Handler> {
	const summary: Handler = async (req, body) => {
		const parsed = z.object(COMMAND.request).safeParse(body);
		if (!parsed.success) return json({ error: "a cut id and a summary are required" }, 400);
		return json(cuts.submit(resolveCaller(req), parsed.data.cutId, parsed.data.summary), 200);
	};
	return new Map<string, Handler>([[COMMAND.path, summary]]);
}
