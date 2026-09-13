import { describe, expect, it } from "vitest";
import { retireGateway } from "../gateway/compose/composeListener.js";
import { generateIdentity } from "../shared/crypto.js";

const ambient = { now: () => 1000, randomBytes: () => Buffer.from("nonce") };

describe("gateway retirement", () => {
	it("maps Router outcomes", async () => {
		const identity = generateIdentity();
		const call = async () => ({ result: { ok: true } });
		expect(
			await retireGateway({
				ambient,
				gatewayId: "gateway",
				identity,
				routerClient: { isConnected: () => true, callInboxTool: call },
			}),
		).toEqual({ outcome: "retired" });
		expect(
			await retireGateway({
				ambient,
				gatewayId: "gateway",
				identity,
				routerClient: {
					isConnected: () => true,
					callInboxTool: async () => ({ result: { ok: false, error: "denied" } }),
				},
			}),
		).toEqual({ outcome: "refused", error: "denied" });
		expect(
			await retireGateway({
				ambient,
				gatewayId: "gateway",
				identity,
				routerClient: {
					isConnected: () => true,
					callInboxTool: async () => {
						throw new Error("unsupported gateway action: gateway_retire");
					},
				},
			}),
		).toEqual({ outcome: "unsupported" });
		expect(
			await retireGateway({
				ambient,
				gatewayId: "gateway",
				identity,
				routerClient: { isConnected: () => false, callInboxTool: call },
			}),
		).toEqual({ outcome: "unreachable" });
	});
});
