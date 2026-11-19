// The policy a typed answer's remember writes.

import type { AuthorizationPolicy, PolicyRefusal } from "../../shared/schemasPolicy.js";
import type { VaultAnswerRefusal, VaultRemember } from "../../shared/schemasVault.js";

export type Remembered =
	| { kind: "write"; policy: AuthorizationPolicy; base?: number }
	/** Already names the key. */
	| { kind: "held"; policy: AuthorizationPolicy }
	| { kind: "refused"; refusal: VaultAnswerRefusal }
	| { kind: "policy_refused"; refusal: PolicyRefusal };

/** Never enables, rebinds, or touches another entry's policy. An add appends at the held revision. */
export function rememberedPolicy(
	held: AuthorizationPolicy | null,
	key: string,
	entryId: string,
	remember: VaultRemember,
): Remembered {
	const retried = held?.enabled && held.binding.entryId === entryId && held.selectorKeys.includes(key);
	if (remember.name !== undefined) {
		if (retried) return { kind: "held", policy: held };
		const policy: AuthorizationPolicy = {
			id: remember.policyId,
			name: remember.name,
			binding: { kind: "entry", entryId },
			selectorKeys: [key],
			enabled: true,
			revision: 1,
		};
		// A held id answers `moved` from the store.
		return { kind: "write", policy };
	}
	if (!held) return { kind: "policy_refused", refusal: { code: "gone" } };
	if (held.binding.entryId !== entryId)
		return { kind: "refused", refusal: { code: "bound_elsewhere", policy: held.name } };
	if (!held.enabled) return { kind: "refused", refusal: { code: "target_off", policy: held.name } };
	if (retried) return { kind: "held", policy: held };
	return { kind: "write", policy: { ...held, selectorKeys: [...held.selectorKeys, key] }, base: held.revision };
}
