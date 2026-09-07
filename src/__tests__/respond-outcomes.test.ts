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
			settle: (): SettleMeta => settled,
			targetOf: () => undefined,
			has: () => true,
			poll: () => undefined,
		} as never,
		ownerId: () => OWNER,
		tryLocalAddress: () => null,
		relayWithRetry: async () => ({ ok: true }),
		mirrorPeer: (() => undefined) as never,
		deliverToOwner: (() => options.ownerAppendTakes === true) as never,
		refuseForeignReply: () => null,
		refuseForeignPoll: () => null,
		provedLocalSession: () => false,
	});
}

const ownerJob: SettleMeta["contract"] = { kind: "local", reply: { kind: "owner", ownerId: OWNER } };
const sessionJob: SettleMeta["contract"] = { kind: "local", reply: { kind: "conversation", conversationId: "c1" } };

async function answer(routes: ReturnType<typeof createRespondRoutes>) {
	return (await routes.respond(REQ, { session_id: "s1", response: "hi" }).json()) as Record<string, unknown>;
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
