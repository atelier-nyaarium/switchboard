// Shared capability registry.

import { z } from "zod";
import type { AssistantActionKey } from "./schemasAssistantActions.js";

export const PHONE_CAPABILITY_PATH = "/assistant/phone";

export const PHONE_PERMISSIONS = ["contacts", "calendar", "notifications", "send_sms", "call_phone"] as const;

export const PhonePermissionSchema = z.enum(PHONE_PERMISSIONS).meta({ id: "PhonePermission" });

export type PhonePermission = z.infer<typeof PhonePermissionSchema>;

/** Guarded acts ask first. */
export const CAPABILITY_KINDS = ["read", "act", "guarded"] as const;

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export const CAPABILITY_HOSTS = ["phone", "gateway"] as const;

export type CapabilityHost = (typeof CAPABILITY_HOSTS)[number];

export interface PhoneCapabilityDeclaration<
	Request extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
	Answer extends z.ZodType = z.ZodType,
> {
	/** Strict shape for tools. */
	readonly request: Request;
	readonly answer: Answer;
	readonly kind: CapabilityKind;
	readonly where: CapabilityHost;
	readonly needs: readonly PhonePermission[];
	/** Owner-visible card label. */
	readonly label: string;
	readonly describe: string;
}

export const UNAVAILABLE_REASONS = [
	"not_granted",
	"not_showing",
	"app_missing",
	"not_supported",
	"no_holder",
	"timeout",
] as const;

export const UnavailableReasonSchema = z.enum(UNAVAILABLE_REASONS).meta({ id: "PhoneUnavailableReason" });

export type UnavailableReason = z.infer<typeof UnavailableReasonSchema>;

export const PhoneStatusKeySchema = z
	.object({
		key: z.string().min(1).max(64),
		available: z.boolean(),
		reason: UnavailableReasonSchema.optional(),
		needs: z.array(PhonePermissionSchema),
	})
	.meta({ id: "PhoneStatusKey" });

export const PhoneContactSchema = z
	.object({
		id: z.string().min(1).max(64),
		name: z.string().max(200),
		phones: z.array(z.string().max(64)).max(16),
		emails: z.array(z.string().max(254)).max(16),
		/** `YYYY-MM-DD` or `--MM-DD`. */
		birthday: z
			.string()
			.regex(/^(\d{4}|-)-\d{2}-\d{2}$/)
			.optional(),
	})
	.meta({ id: "PhoneContact" });

export const PHONE_CAPABILITIES = {
	status: {
		request: z.strictObject({}).meta({ id: "PhoneStatusRequest" }),
		answer: z
			.object({
				/** Null means nobody. */
				holder: z.string().min(1).max(64).nullable(),
				keys: z.array(PhoneStatusKeySchema).max(64),
			})
			.meta({ id: "PhoneStatusAnswer" }),
		kind: "read",
		where: "phone",
		needs: [],
		label: "Phone status",
		describe: `
# Phone status

Which phone holds you, and which phone capabilities it can serve right now with why not.
		`.trim(),
	},
	contacts_search: {
		request: z
			.strictObject({
				query: z.string().min(1).max(80).describe("A name, number or email fragment."),
				limit: z.number().int().min(1).max(20).default(5),
			})
			.meta({ id: "ContactsSearchRequest" }),
		answer: z.object({ contacts: z.array(PhoneContactSchema).max(20) }).meta({ id: "ContactsSearchAnswer" }),
		kind: "read",
		where: "phone",
		needs: ["contacts"],
		label: "Search contacts",
		describe: `
# Search contacts

Contacts on the holding phone matching \`query\`, with phones, emails and a birthday where one is set.
		`.trim(),
	},
	torch: {
		request: z
			.strictObject({
				on: z.boolean(),
				/** Brightness percent. */
				strength: z.number().int().min(1).max(100).optional(),
			})
			.meta({ id: "TorchRequest" }),
		answer: z.object({ on: z.boolean(), levels: z.number().int().nonnegative() }).meta({ id: "TorchAnswer" }),
		kind: "act",
		where: "phone",
		needs: [],
		label: "Torch",
		describe: `
# Torch

Turn the holding phone's torch on or off. \`strength\` is a percent where the phone has levels.
		`.trim(),
	},
} as const satisfies Record<string, PhoneCapabilityDeclaration>;

export type PhoneCapabilityKey = keyof typeof PHONE_CAPABILITIES;

export const PHONE_CAPABILITY_KEYS = Object.keys(PHONE_CAPABILITIES) as PhoneCapabilityKey[];

export type PhoneRequestOf<K extends PhoneCapabilityKey> = z.infer<(typeof PHONE_CAPABILITIES)[K]["request"]>;
export type PhoneAnswerOf<K extends PhoneCapabilityKey> = z.infer<(typeof PHONE_CAPABILITIES)[K]["answer"]>;

type KeysWhere<Host extends CapabilityHost> = {
	[K in PhoneCapabilityKey]: (typeof PHONE_CAPABILITIES)[K]["where"] extends Host ? K : never;
}[PhoneCapabilityKey];

export type GatewayCapabilityKey = KeysWhere<"gateway">;
export type PhoneSideCapabilityKey = KeysWhere<"phone">;

/** Required gateway handlers. */
export type GatewayCapabilityRuns<Ctx> = {
	[K in GatewayCapabilityKey]: (params: PhoneRequestOf<K>, ctx: Ctx) => Promise<PhoneAnswerOf<K>>;
};

/** Tool names stay disjoint. */
type Overlap = PhoneCapabilityKey & AssistantActionKey;
const disjoint: [Overlap] extends [never] ? true : never = true;
void disjoint;

export function phoneCapability<K extends PhoneCapabilityKey>(key: K): (typeof PHONE_CAPABILITIES)[K] {
	return PHONE_CAPABILITIES[key];
}

export const CAPABILITY_GUARDS = ["approved", "unasked", "none"] as const;

export const CapabilityGuardSchema = z.enum(CAPABILITY_GUARDS).meta({ id: "PhoneCapabilityGuard" });

const requestIdField = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

/** String keys preserve old-phone replies. */
export const PhoneCapabilityRowSchema = z
	.object({
		requestId: requestIdField,
		key: z.string().min(1).max(64),
		params: z.unknown(),
		guard: CapabilityGuardSchema,
		deadlineAt: z.number().int().nonnegative(),
	})
	.meta({ id: "PhoneCapabilityRow" });

export type PhoneCapabilityRow = z.infer<typeof PhoneCapabilityRowSchema>;

export const PhoneCapabilityAnswerSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("ok"), answer: z.unknown() }),
		z.object({
			kind: z.literal("unavailable"),
			reason: UnavailableReasonSchema,
			needs: z.array(PhonePermissionSchema).optional(),
			detail: z.string().max(400).optional(),
		}),
	])
	.meta({ id: "PhoneCapabilityAnswer" });

export type PhoneCapabilityAnswer = z.infer<typeof PhoneCapabilityAnswerSchema>;

export const AssistantActRequestSchema = z
	.object({
		requestId: requestIdField,
		key: z.string().min(1).max(64),
		label: z.string().min(1).max(80),
		summary: z.string().max(400),
		deadlineAt: z.number().int().nonnegative(),
	})
	.meta({ id: "AssistantActRequest" });

export type AssistantActRequest = z.infer<typeof AssistantActRequestSchema>;

export const PhoneCapabilityRequestSchema = z.strictObject({
	key: z.enum(PHONE_CAPABILITY_KEYS as [PhoneCapabilityKey, ...PhoneCapabilityKey[]]),
	/** Retries reuse call IDs. */
	callId: requestIdField,
	params: z.unknown(),
});

export type PhoneCapabilityRequest = z.infer<typeof PhoneCapabilityRequestSchema>;

export const PhoneCapabilityResultSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("not_assistant") }),
	z.strictObject({ kind: z.literal("unauthenticated") }),
	z.strictObject({ kind: z.literal("refused"), reason: z.string().max(400) }),
	z.strictObject({
		kind: z.literal("unavailable"),
		reason: UnavailableReasonSchema,
		needs: z.array(PhonePermissionSchema).optional(),
		detail: z.string().max(400).optional(),
	}),
	z.strictObject({ kind: z.literal("ok"), answer: z.unknown(), recorded: z.boolean() }),
]);

export type PhoneCapabilityResult = z.infer<typeof PhoneCapabilityResultSchema>;

export function capabilityNeedsLine(key: PhoneCapabilityKey): string {
	const declaration = PHONE_CAPABILITIES[key];
	const needs = declaration.needs.length === 0 ? "no phone permission" : declaration.needs.join(", ");
	const kind =
		declaration.kind === "read"
			? "A read: runs on the holding phone."
			: declaration.kind === "act"
				? "An act: runs on the holding phone and leaves a trace."
				: "A guarded act: the owner approves a card first unless approvals are off.";
	return `${kind} Needs ${needs}.`;
}
