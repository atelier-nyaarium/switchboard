import { describe, expect, it } from "vitest";
import {
	createGatewayRelayHandler,
	createGatewayRelayPump,
	type FederationRoutes,
} from "../gateway/federation/gatewayRelay.js";
import type { Sealer } from "../gateway/federation/sealer.js";
import { createRespondRoutes } from "../gateway/routes/routesRespond.js";
import { type LaunchFailure, type LaunchNotice, launchNoticeText } from "../shared/launch-notice.js";
import type { GatewayConfig } from "../shared/types.js";

function makeHandler(respond: FederationRoutes["respond"]) {
	const routes: FederationRoutes = {
		acceptGatewaySend: async () => new Response(JSON.stringify({ session_id: "s", status: "running" })),
		respond,
		acceptLaunchNotice: () => {},
		teams: () => new Response(JSON.stringify([])),
	};
	return createGatewayRelayHandler({
		routes,
		tryWakeTeam: async () => ({ ok: false }),
		localGatewayId: "test-host",
		localDomainId: "alice",
	});
}

describe("gatewayRelay response_push", () => {
	it("forwards title, summary, replyAsJson, question, and reason to routes.respond", async () => {
		let received: [Request, Record<string, unknown>] | undefined;
		const { handleOp } = makeHandler((req, body) => {
			received = [req, body];
			return new Response(JSON.stringify({ ok: true }));
		});

		await handleOp(
			{
				kind: "response_push",
				session_id: "conv.owner-1.alice.test-host.coolapp.dev",
				status: "completed",
				response: "ship it",
				title: "Ready to ship",
				summary: "The build is green and ready to deploy.",
				replyAsJson: { ok: true, count: 3 },
				question: "which env?",
				reason: "waiting on approval",
			},
			"friend-gw",
			null,
		);

		expect(received?.[1]).toMatchObject({
			session_id: "conv.owner-1.alice.test-host.coolapp.dev",
			status: "completed",
			response: "ship it",
			title: "Ready to ship",
			summary: "The build is green and ready to deploy.",
			replyAsJson: { ok: true, count: 3 },
			question: "which env?",
			reason: "waiting on approval",
		});
	});
});

describe("a launch notice another Gateway pushes", () => {
	const JOB = "conv.c1.bob.desk.app.far";
	const TARGET = "bob.desk.app.far";
	const ASKER = "alice.laptop.app.asker";

	function receiver() {
		const banked: Array<[string, LaunchNotice]> = [];
		const responses = createRespondRoutes({
			config: { localGatewayId: "laptop" } as GatewayConfig,
			localDomain: "alice",
			ambient: { newId: () => "id" },
			store: {
				askerOf: (id: string) => (id === JOB ? ASKER : undefined),
				targetOf: (id: string) => (id === JOB ? TARGET : undefined),
			},
			bankLaunch: (sessionKey: string, notice: LaunchNotice) => banked.push([sessionKey, notice]),
		} as unknown as Parameters<typeof createRespondRoutes>[0]);
		const { handleOp } = createGatewayRelayHandler({
			routes: {
				acceptGatewaySend: async () => new Response("{}"),
				respond: responses.respond,
				acceptLaunchNotice: responses.acceptLaunchNotice,
				teams: () => new Response("[]"),
			},
			tryWakeTeam: async () => ({ ok: false }),
			localGatewayId: "laptop",
			localDomainId: "alice",
			crossDomainBinding: () => ({ dstDomainId: "bob", keyGateway: "desk", returnGateway: "desk" }),
		});
		const push = (launch: LaunchNotice, srcDomainId: string | null) =>
			handleOp({ kind: "response_push", session_id: JOB, launch }, "desk", srcDomainId);
		return { banked, push };
	}

	it("rebuilds another Domain's notice around the job's own target, trusting none of its framing", async () => {
		const r = receiver();
		const forged = (failure: LaunchFailure): LaunchNotice => ({
			kind: "failed",
			address: "alice.laptop.app.victim",
			failure,
			created: true,
			foreign: false,
		});

		await r.push(
			forged({ kind: "cli", refusal: { cause: "refused", reason: "first\nsession: elsewhere" } }),
			"bob",
		);
		await r.push(forged({ kind: "container", spawn: "app", projectPath: "/home/bob/app" }), "bob");

		expect(r.banked.map(([sessionKey]) => sessionKey)).toEqual([ASKER, ASKER]);
		for (const [, notice] of r.banked) {
			expect(notice).toMatchObject({ kind: "failed", address: TARGET, created: false, foreign: true });
			expect(launchNoticeText(notice).split("\n")).toHaveLength(2);
		}
		expect(JSON.stringify(r.banked)).not.toContain("/home/bob/app");
	});

	it("banks a notice from this Domain's own Gateway as it was sent", async () => {
		const r = receiver();
		const sent: LaunchNotice = {
			kind: "failed",
			address: TARGET,
			failure: { kind: "container", spawn: "app", projectPath: "/home/me/app" },
			created: true,
			foreign: false,
		};

		await r.push(sent, null);

		expect(r.banked).toEqual([[ASKER, sent]]);
	});
});

////////////////////////////////
//  Pump error surfaces

function frame() {
	return {
		type: "gateway_relay",
		v: 1,
		relayId: "r-1",
		srcGateway: "friend-gw",
		dstGateway: "test-host",
		payload: { sealed: { ephemeralPub: "ZQ==", nonce: "bg==", ciphertext: "Yw==", signature: "cw==" } },
	};
}

function pumpWith(open: Sealer["openWithSource"]) {
	const replies: Array<{ ok: boolean; error?: string }> = [];
	const sealer = { seal: () => ({}), open: () => ({}), openWithSource: open } as unknown as Sealer;
	const pump = createGatewayRelayPump({
		handleOp: async () => ({ ok: true }),
		sealer,
		sendReply: async (r) => {
			replies.push(r);
			return {};
		},
	});
	pump(frame());
	return replies;
}

describe("gatewayRelay pump error surfaces", () => {
	it("blames the seal when the seal is what failed", async () => {
		const replies = pumpWith(() => {
			throw new Error("not admitted");
		});
		await new Promise((r) => setTimeout(r, 0));

		expect(replies[0]?.ok).toBe(false);
		expect(replies[0]?.error).toContain("unseal failed");
	});

	it("blames the op, not the seal, when a verified peer sends a shape this build rejects", async () => {
		// A peer on an older wire shape verifies its signature perfectly and still fails the inner
		// parse. Reporting that as an unseal failure sends whoever debugs it after the crypto instead
		// of the version skew, which is the whole reason the two are reported apart.
		const replies = pumpWith(() => ({
			body: { kind: "console_push", entry: { files: [{ filename: "a.txt" }] } },
			srcDomainId: null,
		}));
		await new Promise((r) => setTimeout(r, 0));

		expect(replies[0]?.ok).toBe(false);
		expect(replies[0]?.error).toContain("op rejected");
		expect(replies[0]?.error).not.toContain("unseal");
	});
});
