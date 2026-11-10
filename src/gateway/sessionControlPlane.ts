// Gateway end of the session control plane.
//
// Like the workspace plane, but the caller names the key, so a retried op replays the first answer.

import type { ServerWebSocket } from "bun";
import type { Ambient } from "../shared/ambient.js";
import {
	SESSION_CONTROL_FRAME,
	SESSION_CONTROL_WAIT_MS,
	type SessionControlOp,
	type SessionControlResult,
} from "../shared/session-control.js";
import type { SessionStore } from "../shared/session-store.js";
import { PlaneCoordinator } from "./workspaceOpCoordinator.js";
import { reached, sendOn } from "./wsSend.js";
import { resolveLiveIncarnation, type TeamRegistry, type WsData } from "./wsTypes.js";

////////////////////////////////
//  Interfaces & Types

export interface SessionControlPlaneDeps {
	registry: TeamRegistry;
	sessionStore?: SessionStore;
	ambient: Pick<Ambient, "setTimer" | "clearTimer" | "newId">;
}

////////////////////////////////
//  Functions & Helpers

export function createSessionControlPlane(deps: SessionControlPlaneDeps) {
	const coordinator = new PlaneCoordinator<SessionControlResult>(deps.ambient, (failure, detail) => ({
		ok: false,
		failure,
		detail,
	}));
	const generations = new WeakMap<ServerWebSocket<WsData>, number>();
	let minted = 0;

	const generationOf = (socket: ServerWebSocket<WsData>): number => {
		const held = generations.get(socket);
		if (held !== undefined) return held;
		minted += 1;
		generations.set(socket, minted);
		return minted;
	};

	const ask = async (team: string, op: SessionControlOp, key: string): Promise<SessionControlResult> => {
		const socket = resolveLiveIncarnation(deps.registry, deps.sessionStore, team);
		if (socket === undefined) {
			return { ok: false, failure: "disconnected", detail: `no live session called ${team}` };
		}
		const generation = generationOf(socket);
		const reqId = deps.ambient.newId().slice(0, 16);
		const pending = coordinator.wait(reqId, generation, SESSION_CONTROL_WAIT_MS);
		const frame = JSON.stringify({ type: SESSION_CONTROL_FRAME, reqId, key: `${team}:${key}`, op });
		if (!reached(sendOn(socket, frame, `session control to ${team}`))) {
			coordinator.settle(reqId, generation, {
				ok: false,
				failure: "disconnected",
				detail: `the socket for ${team} refused the write`,
			});
		}
		return await pending;
	};

	const settle = (socket: ServerWebSocket<WsData>, reqId: string, result: SessionControlResult): boolean =>
		coordinator.settle(reqId, generationOf(socket), result);

	const dropped = (socket: ServerWebSocket<WsData>): number =>
		coordinator.failGeneration(generationOf(socket), "the session's socket closed");

	return { ask, settle, dropped, stop: () => coordinator.failAll("the gateway is stopping") };
}

export type SessionControlPlane = ReturnType<typeof createSessionControlPlane>;
