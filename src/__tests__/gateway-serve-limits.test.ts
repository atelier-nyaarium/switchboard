import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ASSISTANT_WAITS } from "../gateway/assistant/waits.js";
import { GATEWAY_IDLE_TIMEOUT_S } from "../gateway/serveLimits.js";
import { VAULT_ROUTE_WAIT_CAP_MS } from "../shared/schemasVault.js";
import { CONSOLE_ANSWER_WAIT_MS, WORKSPACE_HOP_MARGIN_MS } from "../shared/workspace-op.js";

// Vitest runs under Node, so no request here meets Bun's idle cut; this pins the order instead.
describe("the waits a caller is promised", () => {
	it("sit inside what holds them: Bun for a route, the phone for a console op, the action for a request", () => {
		const longestRoute = Math.max(VAULT_ROUTE_WAIT_CAP_MS, ASSISTANT_WAITS.action, ASSISTANT_WAITS.list);
		const adapter = fs.readFileSync("src/gateway/index.ts", "utf8");

		expect(GATEWAY_IDLE_TIMEOUT_S * 1000).toBeGreaterThan(longestRoute);
		expect(adapter).toMatch(/idleTimeout: GATEWAY_IDLE_TIMEOUT_S/);
		expect(ASSISTANT_WAITS.preview + WORKSPACE_HOP_MARGIN_MS).toBeLessThanOrEqual(CONSOLE_ANSWER_WAIT_MS);
		expect(ASSISTANT_WAITS.request).toBeLessThan(ASSISTANT_WAITS.action);
	});
});
