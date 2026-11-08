import { describe, expect, it } from "vitest";
import { createRespondRoutes } from "../gateway/routes/routesRespond.js";
import type { SettleMeta } from "../shared/pending-job-store.js";
import type { GatewayConfig } from "../shared/types.js";

const OWNER = "owner-key";
const REQ = new Request("http://gateway/respond");

function respondWith(options: {
	contract: SettleMeta["contract"];
	ownerAppendTakes?: boolean;
	conversationLive?: boolean;
	/** Proves a local session. */
	local?: boolean;
	settles?: unknown[];
	mirrored?: unknown[];
	relayed?: unknown[];
	owned?: unknown[];
}) {
	const settled: SettleMeta = {
		recorded: true,
		from: "asker",
		to: "responder",
		contract: options.contract,
		persistent: true,
	};
	const live = { readyState: 1, send: () => 12, data: {} } as never;
	return createRespondRoutes({
		config: { localGatewayId: "gw" } as GatewayConfig,
		localDomain: "dom",
		ambient: { newId: () => "id" },
		conversationRegistry: {
			get: () => (options.conversationLive ? live : undefined),
		} as never,
		store: {
			settle: (_id: string, result: unknown): SettleMeta => {
				options.settles?.push(result);
				return settled;
			},
			targetOf: () => undefined,
			contractOf: () => options.contract,
			has: () => true,
			poll: () => undefined,
		} as never,
		ownerId: () => OWNER,
		tryLocalAddress: () => (options.local ? ({ canonical: "dom.gw.proj.sess" } as never) : null),
		relayWithRetry: async (_gateway: string, op: unknown) => {
			options.relayed?.push(op);
			return { ok: true };
		},
		mirrorPeer: ((_thread: unknown, _from: string, _to: string, payload: unknown) => {
			options.mirrored?.push(payload);
		}) as never,
		deliverToOwner: ((delivery: { entry: unknown }) => {
			options.owned?.push(delivery.entry);
			return options.ownerAppendTakes === true;
		}) as never,
		refuseForeignReply: () => null,
		refuseForeignPoll: () => null,
		provedLocalSession: () => options.local === true,
		onReplyPushed: () => undefined,
	});
}

const ownerJob: SettleMeta["contract"] = { kind: "local", reply: { kind: "owner", ownerId: OWNER } };
const sessionJob: SettleMeta["contract"] = { kind: "local", reply: { kind: "conversation", conversationId: "c1" } };

const SPOKEN: Record<string, string> = { title: "T", summary: "S", fullSpoken: "F" };
const SPOKEN_FIELDS = Object.keys(SPOKEN);

async function answer(routes: ReturnType<typeof createRespondRoutes>, spoken: Record<string, string> = SPOKEN) {
	return (await routes.respond(REQ, { session_id: "s1", response: "hi", ...spoken }).json()) as Record<
		string,
		unknown
	>;
}

describe("respond outcomes", () => {
	it("separates recording the answer from telling anyone about it", async () => {
		const told = await answer(respondWith({ contract: ownerJob, ownerAppendTakes: true }));
		expect(told).toMatchObject({ recorded: true, notified: true, delivered: true });
	});

	it("reports a refused owner append as undelivered, since an inbox has no second road", async () => {
		const refused = await answer(respondWith({ contract: ownerJob, ownerAppendTakes: false }));
		expect(refused).toMatchObject({ recorded: true, notified: false, delivered: false });
	});

	it("keeps an offline session's answer delivered, because it can still be polled", async () => {
		const offline = await answer(respondWith({ contract: sessionJob, conversationLive: false }));
		expect(offline).toMatchObject({ recorded: true, notified: false, delivered: true });
	});

	it("claims no delivery for a reply the relay is still retrying", async () => {
		const relaying = await answer(
			respondWith({
				contract: {
					kind: "inbound",
					route: { srcGateway: "peer", srcConversationId: "c1", srcSession: "s1" },
					dstDomainId: null,
				},
			}),
		);
		expect(relaying).toMatchObject({ recorded: true, federated: true, relaying: true });
		expect(relaying.delivered).toBeUndefined();
	});
});

describe("spoken tiers on a reply", () => {
	it("refuses an owner reply missing any one tier before it settles, so a corrected one still lands", async () => {
		const settles: unknown[] = [];
		const routes = respondWith({ contract: ownerJob, ownerAppendTakes: true, settles });
		for (const missing of SPOKEN_FIELDS) {
			const { [missing]: _omitted, ...rest } = SPOKEN;
			expect(routes.respond(REQ, { session_id: "s1", response: "hi", ...rest }).status).toBe(400);
		}
		expect(settles).toHaveLength(0);
		expect(await answer(routes)).toMatchObject({ recorded: true, notified: true });
		expect(settles).toHaveLength(1);
	});

	it("judges a relayed reply by its own job: the owner's keeps tiers and is never refused, a session's drops them", async () => {
		const owned: unknown[] = [];
		const ownerSide = respondWith({ contract: ownerJob, ownerAppendTakes: true, owned });
		const push = (routes: ReturnType<typeof createRespondRoutes>, body: Record<string, unknown>) =>
			routes.respond(REQ, { session_id: "s1", response: "hi", ...body }, { trustedInbound: true });
		expect(push(ownerSide, SPOKEN).status).toBe(200);
		expect(push(ownerSide, {}).status).toBe(200);
		expect(owned).toMatchObject([SPOKEN, {}]);
		expect(owned[1]).not.toHaveProperty("title");

		const settles: unknown[] = [];
		const sessionSide = respondWith({ contract: sessionJob, conversationLive: true, settles });
		expect(push(sessionSide, SPOKEN).status).toBe(200);
		for (const field of SPOKEN_FIELDS) expect(settles[0]).not.toHaveProperty(field);
	});

	it("hands the owner every tier it was sent", async () => {
		const owned: unknown[] = [];
		await answer(respondWith({ contract: ownerJob, ownerAppendTakes: true, owned }));
		expect(owned).toMatchObject([SPOKEN]);
	});

	it("takes a session reply with no tiers, and drops any it carries from the store and both mirrors", async () => {
		const settles: unknown[] = [];
		const mirrored: unknown[] = [];
		const routes = respondWith({ contract: sessionJob, conversationLive: true, local: true, settles, mirrored });
		expect(await answer(routes, {})).toMatchObject({ recorded: true, delivered: true });
		expect(await answer(routes, SPOKEN)).toMatchObject({ recorded: true, delivered: true });
		expect(mirrored).toHaveLength(4);
		expect(settles).toHaveLength(2);
		for (const row of [...mirrored, ...settles]) {
			for (const field of SPOKEN_FIELDS) expect(row).not.toHaveProperty(field);
		}
	});

	it("relays a remote asker's reply with its tiers for the source Gateway to judge, and mirrors none", async () => {
		const relayed: unknown[] = [];
		const mirrored: unknown[] = [];
		const routes = respondWith({
			contract: {
				kind: "inbound",
				route: { srcGateway: "peer", srcConversationId: "c1", srcSession: "s1" },
				dstDomainId: null,
			},
			local: true,
			relayed,
			mirrored,
		});
		await answer(routes);
		expect(relayed).toMatchObject([SPOKEN]);
		expect(mirrored).toHaveLength(1);
		for (const field of SPOKEN_FIELDS) expect(mirrored[0]).not.toHaveProperty(field);
	});
});
