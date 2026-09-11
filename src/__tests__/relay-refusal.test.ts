import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrossDomainPeers } from "../gateway/federation/crossDomainPeers.js";
import { createRelay } from "../gateway/routes/relay.js";
import { processAmbient } from "../shared/ambient.js";
import type { GatewayConfig } from "../shared/types.js";
import { linkedPeer } from "./helpers/cross-domain-link.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function relayWith(rows: Array<[string, string]>) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-refusal-"));
	dirs.push(dir);
	const crossDomainPeers = new CrossDomainPeers(dir);
	for (const [domainId, gatewayId] of rows) crossDomainPeers.add(linkedPeer(domainId, gatewayId));
	return createRelay({
		config: { localGatewayId: "sakura", localDomainId: "d1" } as GatewayConfig,
		localDomain: "d1",
		routerClient: { isConnected: () => true } as never,
		sealer: {
			seal: () => {
				throw new Error("sealed a target the relay should have refused");
			},
		} as never,
		crossDomainPeers,
		resolvesLocalGateway: (id) => id === "sakura",
		ambient: processAmbient(),
	});
}

describe("relay target refusal", () => {
	it("refuses a Gateway nothing resolves, with the reason and without sealing", async () => {
		const relay = relayWith([["aria", "desktop"]]);
		expect(relay.targetDomainId("nobody")).toBeNull();
		await expect(relay.relayToGateway("nobody", { kind: "list_teams" })).resolves.toEqual({
			ok: false,
			error: expect.stringContaining("nobody"),
		});
	});

	it("refuses a bare id two linked Domains share, and takes it once the Domain is named", async () => {
		const relay = relayWith([
			["aria", "desktop"],
			["briar", "desktop"],
		]);
		expect(relay.targetDomainId("desktop")).toBeNull();
		expect(relay.targetDomainId("desktop", "briar")).toBe("briar");
		await expect(relay.relayToGateway("desktop", { kind: "list_teams" })).resolves.toEqual({
			ok: false,
			error: expect.stringContaining("ambiguous"),
		});
	});
});
