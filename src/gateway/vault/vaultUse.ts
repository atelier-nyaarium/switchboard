// The one road a vault value leaves by. The entry and this Gateway's allowance are read again at
// release, never from a snapshot taken when it was asked for.

import type { Ambient } from "../../shared/ambient.js";
import type { VaultClient, VaultEntryView } from "../router/vaultClient.js";
import type { VaultDecisions } from "./decisions.js";

export type VaultUnready = { kind: "unready"; reason: string };
export type VaultUnusable = { kind: "unusable"; reason: string; status: 403 | 404 | 409 };

export type VaultRelease =
	| { kind: "released"; value: string }
	| VaultUnready
	| VaultUnusable
	/** A key that has not arrived is as transient as a Router that has not. */
	| { kind: "unopened" };

export interface VaultUseDeps {
	client: () => VaultClient | null;
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

	/** `granted` is read after the refresh, so a grant gone during the wait releases nothing. */
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

	/** Standing grant only; a watcher never opens a request. */
	function readForWatcher(watcherId: string, entryId: string): Promise<VaultRelease> {
		return release(entryId, () =>
			deps.decisions.covers({ watcherId, entryId }, deps.ambient.now())
				? null
				: { kind: "unusable", reason: "no grant covers this watcher", status: 403 },
		);
	}

	return { ready, usable, release, readForWatcher };
}

export type VaultUse = ReturnType<typeof createVaultUse>;
