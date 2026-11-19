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

export const POLICY_REFUSAL_CODES = [
	"same_command",
	"taken",
	"no_command",
	"none",
	"full",
	"too_many_commands",
	"command_too_long",
	"invalid",
	"moved",
	"gone",
	"deleted",
	"spent",
	"unwritten",
] as const;

export type PolicyRefusalCode = (typeof POLICY_REFUSAL_CODES)[number];

/** Code and its facts. */
export const PolicyRefusalSchema = z
	.object({
		code: z.enum(POLICY_REFUSAL_CODES),
		/** As the owner typed it. */
		example: z.string().optional(),
		key: z.string().optional(),
		/** The other policy's name. */
		policy: z.string().optional(),
		max: z.number().int().positive().optional(),
	})
	.meta({ id: "PolicyRefusal" });

export type PolicyRefusal = z.infer<typeof PolicyRefusalSchema>;

export const ConsolePolicyPutResultSchema = z
	.object({
		stored: z.boolean(),
		/** Held after the write. */
		revision: z.number().int().nonnegative(),
		/** Adopted by the phone. */
		policy: AuthorizationPolicySchema.optional(),
		/** For an older phone. */
		reason: z.string().optional(),
		refusal: PolicyRefusalSchema.optional(),
	})
	.meta({ id: "ConsolePolicyPutResult" });

export const ConsolePolicyDeleteResultSchema = z
	.object({ deleted: z.boolean(), reason: z.string().optional(), refusal: PolicyRefusalSchema.optional() })
	.meta({ id: "ConsolePolicyDeleteResult" });

export type ConsolePolicyListResult = z.infer<typeof ConsolePolicyListResultSchema>;
export type ConsolePolicyPutResult = z.infer<typeof ConsolePolicyPutResultSchema>;
export type ConsolePolicyDeleteResult = z.infer<typeof ConsolePolicyDeleteResultSchema>;

/** Canonicalize before refusal. */
export function canonicalPolicy(policy: AuthorizationPolicy): AuthorizationPolicy {
	return { ...policy, selectorKeys: policy.selectorKeys.map(selectorKey) };
}

/** Before keys hide the collision. */
export function examplesRefusal(examples: readonly string[]): PolicyRefusal | null {
	if (examples.length === 0) return { code: "none" };
	const first = new Map<string, string>();
	for (const example of examples) {
		const key = selectorKey(example);
		if (key === "" || selectorKey(key) !== key) return { code: "no_command", example };
		if (first.has(key)) return { code: "same_command", example, key };
		first.set(key, example);
	}
	return null;
}

/** For a phone reading no code. */
export function refusalReason(refusal: PolicyRefusal): string {
	switch (refusal.code) {
		case "same_command":
			return `"${refusal.example}" is already covered by "${refusal.key}".`;
		case "taken":
			return `"${refusal.key}" is already answered by ${refusal.policy}.`;
		case "no_command":
			return `"${refusal.example}" is not a command.`;
		case "none":
			return "Add a command first.";
		case "full":
			return `This Gateway holds ${refusal.max} policies already.`;
		case "too_many_commands":
			return `A policy holds ${refusal.max} commands at most.`;
		case "command_too_long":
			return `A command is ${refusal.max} characters at most.`;
		case "invalid":
			return "This policy cannot be saved.";
		case "moved":
			return "Changed on another device.";
		case "gone":
			return "That policy no longer exists.";
		case "deleted":
			return "That policy was deleted. Save it as a new one.";
		case "spent":
			return "That policy cannot be changed again. Save it as a new one.";
		case "unwritten":
			return "The Gateway could not save it. Try again.";
	}
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
