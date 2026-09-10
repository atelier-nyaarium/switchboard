// Which entry answers which shapes on one Gateway.

import { z } from "zod";
import { REVISION_CEILING } from "./schemasRunbook.js";
import { selectorKey } from "./selector-key.js";

export const MAX_POLICY_ID_LEN = 64;
export const MAX_POLICY_NAME_LEN = 128;
export const MAX_SELECTOR_LEN = 512;
export const MAX_SELECTORS_PER_POLICY = 64;
export const MAX_POLICIES_PER_GATEWAY = 256;

export const PolicyBindingSchema = z
	.object({
		kind: z.literal("entry"),
		entryId: z.string().min(1).max(64),
	})
	.meta({ id: "PolicyBinding" });

export const AuthorizationPolicySchema = z
	.object({
		id: z
			.string()
			.min(1)
			.max(MAX_POLICY_ID_LEN)
			.regex(/^[^/\r\n]+$/),
		name: z.string().min(1).max(MAX_POLICY_NAME_LEN),
		binding: PolicyBindingSchema,
		/** Canonical, never `operationSet` members. */
		selectorKeys: z.array(z.string().min(1).max(MAX_SELECTOR_LEN)).min(1).max(MAX_SELECTORS_PER_POLICY),
		enabled: z.boolean(),
		/** Gateway-assigned on every write. */
		revision: z.number().int().positive().max(REVISION_CEILING),
	})
	.meta({ id: "AuthorizationPolicy" });

export type PolicyBinding = z.infer<typeof PolicyBindingSchema>;
export type AuthorizationPolicy = z.infer<typeof AuthorizationPolicySchema>;

export const ConsolePolicyListResultSchema = z
	.object({ policies: z.array(AuthorizationPolicySchema) })
	.meta({ id: "ConsolePolicyListResult" });

export const ConsolePolicyPutResultSchema = z
	.object({
		stored: z.boolean(),
		/** Held after the write. */
		revision: z.number().int().nonnegative(),
		/** Adopted by the phone. */
		policy: AuthorizationPolicySchema.optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "ConsolePolicyPutResult" });

export const ConsolePolicyDeleteResultSchema = z
	.object({ deleted: z.boolean(), reason: z.string().optional() })
	.meta({ id: "ConsolePolicyDeleteResult" });

export type ConsolePolicyListResult = z.infer<typeof ConsolePolicyListResultSchema>;
export type ConsolePolicyPutResult = z.infer<typeof ConsolePolicyPutResultSchema>;
export type ConsolePolicyDeleteResult = z.infer<typeof ConsolePolicyDeleteResultSchema>;

/** Canonicalize before refusal. */
export function canonicalPolicy(policy: AuthorizationPolicy): AuthorizationPolicy {
	return { ...policy, selectorKeys: policy.selectorKeys.map(selectorKey) };
}

/** Expects canonical form. */
export function policyRefusal(policy: AuthorizationPolicy): string | null {
	if (policy.selectorKeys.length === 0) return "a policy with no selector would answer nothing";
	for (const key of policy.selectorKeys) {
		const derived = selectorKey(key);
		if (derived === "") return "a selector names no command";
		if (derived !== key) return `${key} is not a selector key; the gateway derives keys`;
	}
	if (new Set(policy.selectorKeys).size !== policy.selectorKeys.length) return "a selector is named twice";
	return null;
}
