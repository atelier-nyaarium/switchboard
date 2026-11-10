import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { createSessionLifecycleHandlers } from "../gateway/console/consoleSessionLifecycle.js";
import { createConsoleTargets } from "../gateway/console/consoleTargets.js";
import { CreateSessionAmbiguousError } from "../gateway/console/consoleTypes.js";
import { WakeCoordinator } from "../gateway/wake.js";
import { WakeService } from "../gateway/wakeService.js";
import type { TeamRegistry, WsData } from "../gateway/wsTypes.js";
import { processAmbient } from "../shared/ambient.js";
import { SessionStore } from "../shared/session-store.js";

/** Creates over a real wake service. */
function rig(hostUp = true) {
	const sessionStore = new SessionStore({ ambient: processAmbient() });
	const wakeCoordinator = new WakeCoordinator(processAmbient());
	const frames: Array<{ type: string; team: string; launchId?: string; door?: string }> = [];
	const watched: string[] = [];
	const hostWs = {
		readyState: 1,
		send: (text: string) => void frames.push(JSON.parse(text)),
		data: { launchIds: true },
	};
	let launches = 0;
	const service = new WakeService({
		registry: new Map() as TeamRegistry,
		sessionStore,
		presence: {
			wakeStart: () => {},
			wakeEnd: () => {},
			mintOrReattach: (opts) => sessionStore.mintOrReattach(opts),
			forget: (team) => sessionStore.forget(team),
		},
		wakeCoordinator,
		isAvailableProject: () => false,
		knownTeamPaths: new Map(),
		offlineCatalog: new Map(),
		liveHostSocket: () => (hostUp ? (hostWs as unknown as ServerWebSocket<WsData>) : undefined),
		wakeTimeoutMs: 10_000,
		newLaunchId: () => `launch-${String(++launches).padStart(4, "0")}`,
	});
	const lifecycle = createSessionLifecycleHandlers({
		targets: createConsoleTargets({
			localDomainId: "d1",
			localGatewayId: "gw",
			isTrustedCatalogProject: () => false,
		}),
		createSessionBoundMs: 10_000,
		ambient: processAmbient(),
		beginLaunch: (team, opts) => service.beginWake(team, undefined, opts),
		watchOwnerLaunch: (team, launchId) => watched.push(`${team} ${launchId}`),
		sessionStore,
	});
	return { sessionStore, wakeCoordinator, frames, watched, lifecycle };
}

const createOp = { kind: "create_session", target: "d1.gw.host", sessionName: "twin", harness: "claude" } as const;

describe("a console create", () => {
	it("answers pending at dispatch, and joins a second create of the session to the one launch", async () => {
		const r = rig();

		const answers = await Promise.all([
			r.lifecycle.createSession(createOp, "conv-a", "op-1"),
			r.lifecycle.createSession(createOp, "conv-b", "op-2"),
		]);

		expect(answers).toEqual([
			expect.objectContaining({ created: true, id: "twin", status: "pending" }),
			expect.objectContaining({ created: true, id: "twin", status: "pending" }),
		]);
		expect(r.frames).toEqual([expect.objectContaining({ type: "wake", team: "host.twin", door: "create" })]);
		expect(r.watched).toEqual([`host.twin ${r.frames[0].launchId}`, `host.twin ${r.frames[0].launchId}`]);
	});

	it("forgets the blank session it left for the launch when that launch fails after answering", async () => {
		const r = rig();
		const op = { kind: "create_session", target: "d1.gw.host", sessionName: "late" } as const;

		const answered = await r.lifecycle.createSession(op, "conv-a", "op-1", { unpicked: true });
		const whilePending = r.sessionStore.getByTeam("host.late");
		const failure = { kind: "cli", refusal: { cause: "none_installed" } } as const;
		r.wakeCoordinator.fail("host.late", { failure }, r.frames[0].launchId);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(answered).toMatchObject({ status: "pending" });
		expect(whilePending).toBeDefined();
		expect(r.sessionStore.getByTeam("host.late")).toBeUndefined();
	});

	it("refuses as ambiguous a create it could not dispatch, with no host to reach", async () => {
		const r = rig(false);

		await expect(r.lifecycle.createSession(createOp, "conv-a", "op-1")).rejects.toBeInstanceOf(
			CreateSessionAmbiguousError,
		);
		expect(r.frames).toEqual([]);
	});
});
