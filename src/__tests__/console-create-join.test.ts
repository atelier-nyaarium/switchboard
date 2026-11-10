import { describe, expect, it } from "vitest";
import { createSessionLifecycleHandlers } from "../gateway/console/consoleSessionLifecycle.js";
import { createConsoleTargets } from "../gateway/console/consoleTargets.js";
import { processAmbient } from "../shared/ambient.js";
import type { HostOp, HostOpResult } from "../shared/host-op.js";
import { SessionStore } from "../shared/session-store.js";

/** A launch that stays in flight until the test lets it finish. */
function heldLaunch() {
	let finish: (result: HostOpResult) => void = () => undefined;
	const promise = new Promise<HostOpResult>((resolve) => {
		finish = resolve;
	});
	return { promise, finish };
}

function handlers(
	relayToHost: (op: HostOp) => Promise<HostOpResult>,
	over: Partial<Parameters<typeof createSessionLifecycleHandlers>[0]> = {},
) {
	const inflight = new Map<string, Promise<HostOpResult>>();
	return createSessionLifecycleHandlers({
		targets: createConsoleTargets({
			localDomainId: "d1",
			localGatewayId: "gw",
			isTrustedCatalogProject: () => false,
		}),
		createSessionBoundMs: 10_000,
		ambient: processAmbient(),
		...over,
		relayToHost,
		joinCreate: (team, start) => {
			const existing = inflight.get(team);
			if (existing) return { launch: existing, release: null };
			const launch = start();
			inflight.set(team, launch);
			return { launch, release: () => void inflight.delete(team) };
		},
	});
}

describe("two creates for one session", () => {
	it("reaches the host once, and answers both callers", async () => {
		const held = heldLaunch();
		const sent: HostOp[] = [];
		const lifecycle = handlers((op) => {
			sent.push(op);
			return held.promise;
		});
		const op = { kind: "create_session", target: "d1.gw.host", sessionName: "twin" } as const;

		const first = lifecycle.createSession(op, "conv-a", "op-1");
		const second = lifecycle.createSession(op, "conv-b", "op-2");
		await Promise.resolve();
		held.finish({ ok: true });

		const [a, b] = await Promise.all([first, second]);
		expect(sent.filter((each) => each.kind === "createSession")).toHaveLength(1);
		expect(a).toMatchObject({ created: true });
		expect(b).toMatchObject({ created: true });
	});
});

describe("a create left for its launch to pick a CLI", () => {
	it("forgets the blank session it made when the launch fails after the create answered pending", async () => {
		const held = heldLaunch();
		const sessionStore = new SessionStore({ ambient: processAmbient() });
		const lifecycle = handlers(() => held.promise, { createSessionBoundMs: 1, sessionStore });
		const op = { kind: "create_session", target: "d1.gw.host", sessionName: "late" } as const;

		const answered = await lifecycle.createSession(op, "conv-a", "op-1", { unpicked: true });
		const whilePending = sessionStore.getByTeam("host.late");
		held.finish({ ok: false, error: "no CLI", failure: { kind: "cli", refusal: { cause: "none_installed" } } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(answered).toMatchObject({ status: "pending" });
		expect(whilePending).toBeDefined();
		expect(sessionStore.getByTeam("host.late")).toBeUndefined();
	});
});
