import { describe, expect, it } from "vitest";
import { createConsoleDispatcher } from "../gateway/console/consoleHandler.js";
import { SendRefusedError } from "../gateway/console/consoleTypes.js";
import type { ConsoleOp } from "../shared/console-protocol.js";
import { generateIdentity } from "../shared/crypto.js";
import type { RowOrigin } from "../shared/schemasInbox.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

/** Over a stub send route. */
function dispatcher(status = 200) {
	const sends: Array<Record<string, unknown>> = [];
	const told: unknown[] = [];
	const dispatch = createConsoleDispatcher({
		registry: {} as never,
		conversationRegistry: {} as never,
		routes: {
			ownerSessionKey: () => "conv-key",
			sendFromOwner: async (body: Record<string, unknown>) => {
				sends.push(body);
				return new Response(JSON.stringify(status === 200 ? { session_id: "conv-key" } : { error: "no" }), {
					status,
				});
			},
			deliverToOwner: (input: unknown) => {
				told.push(input);
				return true;
			},
		} as never,
		localGatewayId: "gateway",
		localDomainId: "domain",
		ambient: fakeAmbient({ now: () => 1_000 }),
	} as never);
	const owner = generateIdentity().sign.pub;
	const send = (opId: string, origin?: RowOrigin["kind"]) =>
		dispatch.handleDelivery(
			{ kind: "send", to: "domain.gateway.spawn.session", body: "hi" } as ConsoleOp,
			"pixel",
			"conversation",
			opId,
			owner,
			origin,
		);
	return { sends, told, send };
}

describe("a Router-fired send through the console handler", () => {
	it("names one delivery per fire and leaves the owner's echo to the Router", async () => {
		const fired = dispatcher();
		await fired.send("op-1", "router");
		await fired.send("op-1", "router");
		await fired.send("op-2", "router");
		const ids = fired.sends.map((body) => body.deliveryId);
		expect(ids[0]).toBe(ids[1]);
		expect(ids[2]).not.toBe(ids[0]);
		expect(fired.told).toEqual([]);

		const ordinary = dispatcher();
		await ordinary.send("op-1");
		expect(ordinary.sends[0]).not.toHaveProperty("deliveryId");
		expect(ordinary.told).toHaveLength(1);
	});

	it("refuses with the route's status, so a caller can tell nothing was accepted", async () => {
		await expect(dispatcher(503).send("op-1", "router")).rejects.toSatisfy(
			(error) => error instanceof SendRefusedError && error.retryable,
		);
		await expect(dispatcher(404).send("op-1", "router")).rejects.toSatisfy(
			(error) => error instanceof SendRefusedError && !error.retryable,
		);
	});
});
