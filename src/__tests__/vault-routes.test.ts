import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VaultClient } from "../gateway/router/vaultClient.js";
import { createVaultDecisions } from "../gateway/vault/decisions.js";
import type { HelperTokens } from "../gateway/vault/helperTokens.js";
import { createVaultRequests } from "../gateway/vault/requests.js";
import { createVaultRoutes } from "../gateway/vault/vaultRoutes.js";
import { openDurable } from "../shared/durable-store.js";
import type { VaultRequest } from "../shared/schemasVault.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function bench() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-routes-"));
	roots.push(root);
	const ambient = fakeAmbient({ drive: "real", now: () => 1_000_000 });
	const delivered: VaultRequest[] = [];
	const vault = { refreshFailures: 0, allowed: true, opens: true };
	const stored = { clear: { id: "deploy" } };
	const client = {
		refresh: async () =>
			vault.refreshFailures-- > 0 ? { kind: "error", error: "the Router cannot be reached" } : { kind: "ok" },
		stored: (id: string) => (id === "deploy" ? stored : null),
		view: () => ({ id: "deploy", hasValue: true, publicTitle: "Deploy", publicDescription: null }),
		allowedHere: () => vault.allowed,
		openValue: () => (vault.opens ? "hunter2" : null),
		live: () => [stored],
	} as unknown as VaultClient;
	const decisions = openDurable(root, "vault-decisions", (store) => createVaultDecisions({ store, ambient }));
	const requests = createVaultRequests({
		ambient,
		deliver: (request) => {
			delivered.push(request);
			return true;
		},
		openTyped: () => null,
	});
	const routes = createVaultRoutes({
		client: () => client,
		decisions,
		requests,
		helperTokens: { verify: () => null } as unknown as HelperTokens,
		ambient,
		resolveCaller: () => "host.alice",
		notifyOwner: () => undefined,
	});
	const call = async (route: string, body: Record<string, unknown>) => {
		const handler = routes.get(route);
		if (!handler) throw new Error(`no route ${route}`);
		const response = await handler(new Request(`http://gateway.test${route}`, { method: "POST" }), body);
		return { status: response.status, json: (await response.json()) as Record<string, unknown> };
	};
	const opened = async (seen: number): Promise<VaultRequest> => {
		for (let i = 0; i < 200 && delivered.length <= seen; i += 1) await new Promise((r) => setTimeout(r, 1));
		const request = delivered[seen];
		if (!request) throw new Error("the request did not open");
		return request;
	};
	return { vault, requests, call, opened, delivered };
}

describe("vault routes", () => {
	it("keeps an approval the vault could not serve, and hands it over once it can", async () => {
		const { vault, requests, call, opened } = bench();
		const use = call("/vault/use", { entryId: "deploy", operation: "ssh deploy@prod", waitMs: 10_000 });
		const request = await opened(0);

		vault.refreshFailures = 1;
		expect(requests.answer(request.requestId, "once")).toEqual({ ok: true });
		expect((await use).status).toBe(503);

		// A key that has not arrived keeps it too.
		vault.opens = false;
		expect((await call("/vault/collect", { requestId: request.requestId, waitMs: 1_000 })).status).toBe(503);
		vault.opens = true;
		const collected = await call("/vault/collect", { requestId: request.requestId, waitMs: 1_000 });
		expect(collected.json).toEqual({ outcome: "approved", decision: "once", value: "hunter2" });
		const again = await call("/vault/collect", { requestId: request.requestId, waitMs: 1_000 });
		expect(again.json).toMatchObject({ outcome: "refused" });
	});

	it("reads the entry as the value leaves, so a Gateway shut out while it waited gets a refusal", async () => {
		const { vault, requests, call, opened } = bench();
		const use = call("/vault/use", { entryId: "deploy", operation: "ssh deploy@prod", waitMs: 10_000 });
		const request = await opened(0);

		vault.allowed = false;
		expect(requests.answer(request.requestId, "once")).toEqual({ ok: true });
		expect((await use).json).toMatchObject({ outcome: "refused", reason: "this Gateway may not use the entry" });
		// Void, not kept: the owner approved an entry this Gateway no longer holds.
		const collected = await call("/vault/collect", { requestId: request.requestId, waitMs: 1_000 });
		expect(collected.json).toMatchObject({ outcome: "refused" });
	});
});
