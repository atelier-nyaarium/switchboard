import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTION_WAIT_MS } from "../gateway/assistant/actionDispatch.js";
import { LIST_WAIT_MS } from "../gateway/compose/composeAssistant.js";
import { GATEWAY_IDLE_TIMEOUT_S } from "../gateway/serveLimits.js";
import { VAULT_ROUTE_WAIT_CAP_MS } from "../shared/schemasVault.js";

// Pin Bun's idle timeout.
describe("the Gateway's Bun server", () => {
	it("holds a request longer than an action, a listing or a vault approval waits, and is told so", () => {
		const longest = Math.max(VAULT_ROUTE_WAIT_CAP_MS, ACTION_WAIT_MS, LIST_WAIT_MS);
		const adapter = fs.readFileSync("src/gateway/index.ts", "utf8");

		expect(GATEWAY_IDLE_TIMEOUT_S * 1000).toBeGreaterThan(longest);
		expect(adapter).toMatch(/idleTimeout: GATEWAY_IDLE_TIMEOUT_S/);
	});
});
