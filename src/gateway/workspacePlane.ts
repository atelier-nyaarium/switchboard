// The Gateway's end of the workspace plane: pick one socket for a session, send, await, settle.
//
// A socket is one incarnation, so the socket OBJECT is the generation's natural key. A WeakMap holds
// it rather than a field on `WsData`, since a generation is this plane's business and not the socket's.

import type { ServerWebSocket } from "bun";
import type { Ambient } from "../shared/ambient.js";
import type { SessionStore } from "../shared/session-store.js";
import { boundsOf, WORKSPACE_OP_FRAME, type WorkspaceOp, type WorkspaceOpResult } from "../shared/workspace-op.js";
import { WorkspaceOpCoordinator } from "./workspaceOpCoordinator.js";
import { reached, sendOn } from "./wsSend.js";
import { resolveLiveIncarnation, type TeamRegistry, type WsData } from "./wsTypes.js";

////////////////////////////////
//  Interfaces & Types

export interface WorkspacePlaneDeps {
	registry: TeamRegistry;
	sessionStore?: SessionStore;
	ambient: Pick<Ambient, "setTimer" | "clearTimer" | "newId">;
}

////////////////////////////////
//  Functions & Helpers

export function createWorkspacePlane(deps: WorkspacePlaneDeps) {
	const coordinator = new WorkspaceOpCoordinator(deps.ambient);
	const generations = new WeakMap<ServerWebSocket<WsData>, number>();
	let minted = 0;

	/** Stable for one socket's life, so every request it carries shares a generation. */
	const generationOf = (socket: ServerWebSocket<WsData>): number => {
		const held = generations.get(socket);
		if (held !== undefined) return held;
		minted += 1;
		generations.set(socket, minted);
		return minted;
	};

	const ask = async (team: string, op: WorkspaceOp): Promise<WorkspaceOpResult> => {
		const socket = resolveLiveIncarnation(deps.registry, deps.sessionStore, team);
		if (socket === undefined) {
			return { ok: false, failure: "disconnected", detail: `no live session called ${team}` };
		}

		const generation = generationOf(socket);
		const reqId = deps.ambient.newId().slice(0, 16);
		// The key is the request: a retry of the same ASK mints a new one, which is what lets a retry
		// run while a replayed FRAME does not.
		const key = `${team}:${reqId}`;
		const pending = coordinator.wait(reqId, generation, boundsOf(op).planeWaitMs);

		const frame = JSON.stringify({ type: WORKSPACE_OP_FRAME, reqId, key, op });
		// A dropped write settles at once: waiting out the timeout would say nothing more.
		if (!reached(sendOn(socket, frame, `workspace op to ${team}`))) {
			coordinator.settle(reqId, generation, {
				ok: false,
				failure: "disconnected",
				detail: `the socket for ${team} refused the write`,
			});
		}
		return await pending;
	};

	/** False when nothing was waiting on it, which a caller logs rather than acts on. */
	const settle = (socket: ServerWebSocket<WsData>, reqId: string, result: WorkspaceOpResult): boolean =>
		coordinator.settle(reqId, generationOf(socket), result);

	/** Called when a socket closes, so its waits fail at once instead of each timing out. */
	const dropped = (socket: ServerWebSocket<WsData>): number =>
		coordinator.failGeneration(generationOf(socket), "the session's socket closed");

	return { ask, settle, dropped, stop: () => coordinator.failAll("the gateway is stopping") };
}

export type WorkspacePlane = ReturnType<typeof createWorkspacePlane>;
