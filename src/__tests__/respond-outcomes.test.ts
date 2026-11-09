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
	const relayedJob = (reader?: "phone" | "session"): SettleMeta["contract"] => ({
		kind: "inbound",
		route: { srcGateway: "peer", srcConversationId: "c1", srcSession: "s1" },
		dstDomainId: null,
		...(reader ? { reader } : {}),
	});
	const tierless = (row: unknown) => SPOKEN_FIELDS.every((field) => !Object.hasOwn(row as object, field));

	it("holds a channel_reply read on a phone to every tier before it settles, and lets an unmarked reply land as sent", async () => {
		for (const contract of [ownerJob, relayedJob("phone")]) {
			const settles: unknown[] = [];
			const routes = respondWith({ contract, ownerAppendTakes: true, settles });
			for (const missing of SPOKEN_FIELDS) {
				const { [missing]: _omitted, ...rest } = SPOKEN;
				const refused = routes.respond(REQ, { session_id: "s1", response: "hi", tiered: true, ...rest });
				expect(refused.status).toBe(400);
			}
			expect(settles).toHaveLength(0);
			expect(routes.respond(REQ, { session_id: "s1", response: "a card's caption" }).status).toBe(200);
			expect(routes.respond(REQ, { session_id: "s1", response: "hi", tiered: true, ...SPOKEN }).status).toBe(200);
			expect(settles).toHaveLength(2);
		}
	});

	it("keeps the tiers for a phone and drops them for a session, and passes on those of a reader an older Gateway did not name", async () => {
		const owned: unknown[] = [];
		await answer(respondWith({ contract: ownerJob, ownerAppendTakes: true, owned }));
		expect(owned).toMatchObject([SPOKEN]);

		const settles: unknown[] = [];
		const mirrored: unknown[] = [];
		const local = respondWith({ contract: sessionJob, conversationLive: true, local: true, settles, mirrored });
		expect(await answer(local, { tiered: true } as never)).toMatchObject({ recorded: true, delivered: true });
		expect(await answer(local)).toMatchObject({ recorded: true, delivered: true });
		expect(settles).toHaveLength(2);
		expect(mirrored).toHaveLength(4);
		expect([...settles, ...mirrored].every(tierless)).toBe(true);

		for (const [reader, kept] of [
			["session", false],
			["phone", true],
			[undefined, true],
		] as const) {
			const relayed: unknown[] = [];
			const mirror: unknown[] = [];
			const routes = respondWith({ contract: relayedJob(reader), local: true, relayed, mirrored: mirror });
			expect(routes.respond(REQ, { session_id: "s1", response: "hi", tiered: true, ...SPOKEN }).status).toBe(200);
			expect(relayed).toHaveLength(1);
			expect(tierless(relayed[0])).toBe(!kept);
			expect(mirror.every(tierless)).toBe(true);
		}
		const unnamed = respondWith({ contract: relayedJob() });
		expect(unnamed.respond(REQ, { session_id: "s1", response: "hi", tiered: true }).status).toBe(200);
	});
});
