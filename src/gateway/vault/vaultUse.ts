// Recheck the entry and grant at release.

import type { Ambient } from "../../shared/ambient.js";
import type { VaultClient, VaultEntryView } from "../router/vaultClient.js";
import type { VaultDecisions } from "./decisions.js";

export type VaultUnready = { kind: "unready"; reason: string };
export type VaultUnusable = { kind: "unusable"; reason: string; status: 403 | 404 | 409 };

export type VaultRelease =
	| { kind: "released"; value: string }
	| VaultUnready
	| VaultUnusable
	/** A missing key may arrive after refresh. */
	| { kind: "unopened" };

export interface VaultUseDeps {
	client: () => VaultClient | null;
	/** Router takes reads. */
	registered?: () => boolean;
	decisions: Pick<VaultDecisions, "covers">;
	ambient: Pick<Ambient, "now">;
}

export function createVaultUse(deps: VaultUseDeps) {
	async function ready(): Promise<{ kind: "ready"; client: VaultClient } | VaultUnready> {
		const client = deps.client();
		if (!client) return { kind: "unready", reason: "this Gateway is not enrolled" };
		const refreshed = await client.refresh();
		if (refreshed.kind !== "ok") return { kind: "unready", reason: refreshed.error };
		return { kind: "ready", client };
	}

	function usable(
		client: VaultClient,
		entryId: string,
	): { kind: "usable"; entry: VaultEntryView; value: () => string | null } | VaultUnusable {
		const stored = client.stored(entryId);
		if (!stored) return { kind: "unusable", reason: "no such entry", status: 404 };
		const entry = client.view(stored);
		if (!entry.hasValue) return { kind: "unusable", reason: "the entry holds no value", status: 409 };
		if (!client.allowedHere(entry))
			return { kind: "unusable", reason: "this Gateway may not use the entry", status: 403 };
		return { kind: "usable", entry, value: () => client.openValue(stored) };
	}

	/** Recheck grants after refresh. */
	async function release(entryId: string, granted: () => VaultUnusable | null = () => null): Promise<VaultRelease> {
		const answer = await ready();
		if (answer.kind !== "ready") return answer;
		const refused = granted();
		if (refused) return refused;
		const found = usable(answer.client, entryId);
		if (found.kind !== "usable") return found;
		const value = found.value();
		return value === null ? { kind: "unopened" } : { kind: "released", value };
	}

	/** Services use standing grants only. */
	function readForService(serviceId: string, entryId: string): Promise<VaultRelease> {
		return release(entryId, () =>
			deps.decisions.covers({ serviceId, entryId }, deps.ambient.now())
				? null
				: { kind: "unusable", reason: "no grant covers this service", status: 403 },
		);
	}

	/** Read answerable now. */
	const canRead = (): boolean => deps.client() !== null && (deps.registered?.() ?? true);

	return { ready, usable, release, readForService, canRead };
}

export type VaultUse = ReturnType<typeof createVaultUse>;
