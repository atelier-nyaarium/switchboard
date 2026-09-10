import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VAULT_PUBLIC_TITLE_KIND, VAULT_VALUE_KIND, vaultAadKind } from "../shared/content-envelope.js";
import type { AuthorizationPolicy } from "../shared/schemasPolicy.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

describe("federation harness: authorization policies", () => {
	let h: FederationHarness;
	const entryId = "deploy-key";
	const policy = (revision: number, over: Partial<AuthorizationPolicy> = {}): AuthorizationPolicy => ({
		id: "apt",
		name: "Package administration",
		binding: { kind: "entry", entryId },
		selectorKeys: ["ssh deploy@prod"],
		enabled: true,
		revision,
		...over,
	});
	const grantsFile = () => path.join(path.dirname(h.federationDir), "vault-decisions.json");
	const qualified = (grantId: string, policyRevision: number) => ({
		grantId,
		tier: "window",
		entryId,
		displayShape: "ssh deploy@prod",
		coveredShapes: ["ssh deploy@prod"],
		holder: { kind: "session", sessionTarget: "host.alice" },
		sessionTarget: "host.alice",
		expiresAt: h.now() + 60_000,
		policyId: "apt",
		policyRevision,
	});
	const listed = async (): Promise<string[]> => {
		const { result } = await h.phone.value({ kind: "vault_grants" });
		return (result as { grants: Array<{ grantId: string }> }).grants.map((grant) => grant.grantId).sort();
	};
	const onDisk = (): string[] =>
		(JSON.parse(fs.readFileSync(grantsFile(), "utf8")) as Array<{ grantId: string }>).map((g) => g.grantId).sort();

	beforeAll(async () => {
		h = await startFederationHarness();
		const written = await h.phone.send({
			kind: "vault_put",
			put: {
				id: entryId,
				expectedRevision: 0,
				sealed: {
					publicTitle: h.phone.seal("Deploy key", vaultAadKind(VAULT_PUBLIC_TITLE_KIND, entryId)),
					value: h.phone.seal("hunter2", vaultAadKind(VAULT_VALUE_KIND, entryId)),
				},
			},
		});
		expect(written).toMatchObject({ outcome: "applied" });
	}, 30_000);
	afterAll(async () => {
		if (h) await h.close();
	});

	it("names each revision itself, and a restart takes only the grants a move left behind", async () => {
		const first = await h.phone.value({ kind: "policy_put", policy: policy(7) });
		expect(first.result).toMatchObject({ stored: true, revision: 1 });
		const stale = await h.phone.value({ kind: "policy_put", policy: policy(1, { name: "Renamed" }) });
		expect(stale.result).toMatchObject({ stored: false, revision: 1 });
		const second = await h.phone.value({
			kind: "policy_put",
			policy: policy(1, { name: "Renamed" }),
			baseRevision: 1,
		});
		expect(second.result).toMatchObject({ stored: true, revision: 2 });

		// A crash before the prune.
		fs.writeFileSync(grantsFile(), JSON.stringify([qualified("stale", 1), qualified("current", 2)]));
		await h.restartGateway();
		expect(await listed()).toEqual(["current"]);
		expect(onDisk()).toEqual(["current"]);

		// A disabled policy vouches for nothing.
		const disabled = await h.phone.value({
			kind: "policy_enable",
			policyId: "apt",
			enabled: false,
			baseRevision: 2,
		});
		expect(disabled.result).toMatchObject({ stored: true, revision: 3 });
		expect(await listed()).toEqual([]);
		fs.writeFileSync(grantsFile(), JSON.stringify([qualified("third", 3)]));
		await h.restartGateway();
		expect(await listed()).toEqual([]);
		expect(onDisk()).toEqual([]);
	});
});
