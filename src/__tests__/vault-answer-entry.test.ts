import { describe, expect, it } from "vitest";
import type { VaultClient } from "../gateway/router/vaultClient.js";
import { createAnswerEntry } from "../gateway/vault/answerEntry.js";
import { createVaultRequests } from "../gateway/vault/requests.js";
import type { VaultUse } from "../gateway/vault/vaultUse.js";
import { VAULT_REQUEST_DEADLINE_MS } from "../shared/schemasVault.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

describe("answering a typed request from an entry", () => {
	it("gives the claim back when the policy write throws, so the request waits and then lapses", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000_000 });
		const requests = createVaultRequests({ ambient, deliver: () => true, openTyped: () => null });
		const client = {} as VaultClient;
		const use: Pick<VaultUse, "ready" | "usable"> = {
			ready: async () => ({ kind: "ready", client }),
			usable: () => ({ kind: "usable" }) as ReturnType<VaultUse["usable"]>,
		};
		const answer = createAnswerEntry({
			use,
			requests,
			policies: () => ({
				get: () => null,
				put: () => {
					throw new Error("disk gone");
				},
			}),
		});
		const opened = requests.open({ kind: "typed", operation: "sudo apt-mark hold x", sessionTarget: "host.carol" });
		if (opened.kind !== "opened") throw new Error("the request did not open");
		const { requestId } = opened.request;

		await expect(
			answer({ requestId, entryId: "pw", decision: "once", remember: { policyId: "new", name: "New" } }),
		).rejects.toThrow("disk gone");
		expect(requests.typedLive(requestId)).toMatchObject({ kind: "typed", requestId });

		await ambient.advance(VAULT_REQUEST_DEADLINE_MS + 1);
		await expect(opened.answer).resolves.toEqual({ kind: "refused" });
	});
});
