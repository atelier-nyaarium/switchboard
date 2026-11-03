// Shared capability registry.

import { z } from "zod";
import type { AssistantActionKey } from "./schemasAssistantActions.js";

export const PHONE_CAPABILITY_WAIT_MS = 120_000;

export const PHONE_PERMISSIONS = [
	"contacts",
	"calendar",
	"notifications",
	"notification_access",
	"send_sms",
	"call_phone",
] as const;

export const PhonePermissionSchema = z.enum(PHONE_PERMISSIONS).meta({ id: "PhonePermission" });

export type PhonePermission = z.infer<typeof PhonePermissionSchema>;

/** Capability action kinds. */
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
	readonly guardedWhen?: (params: z.infer<Request>) => boolean;
	readonly where: CapabilityHost;
	readonly needs: readonly PhonePermission[];
	/** Owner-visible card label. */
	readonly label: string;
	readonly describe: string;
}

export const UNAVAILABLE_REASONS = [
	"not_granted",
	"disabled",
	"not_showing",
	"app_missing",
	"not_supported",
	"no_holder",
	"not_ready",
	"timeout",
	"unreachable",
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

export const PhoneCalendarEventSchema = z
	.object({
		id: z.string(),
		title: z.string().max(200),
		start: z.string(),
		end: z.string(),
		allDay: z.boolean(),
		daysUntil: z.number().int(),
		location: z.string().max(200).optional(),
		calendar: z.string().max(80).optional(),
	})
	.meta({ id: "PhoneCalendarEvent" });

export const PhoneNotificationSchema = z
	.object({
		id: z.string().max(120),
		app: z.string().max(80),
		package: z.string().max(120),
		title: z.string().max(200).optional(),
		text: z.string().max(500).optional(),
		postedAt: z.string(),
		replyable: z.boolean(),
	})
	.meta({ id: "PhoneNotification" });

export const LaunchableAppSchema = z
	.object({ label: z.string().max(80), package: z.string().max(120) })
	.meta({ id: "LaunchableApp" });

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
	calendar_events: {
		request: z
			.strictObject({
				from: z.string().datetime({ offset: true }).optional(),
				days: z.number().int().min(1).max(31).optional(),
				query: z.string().min(1).max(80).optional(),
				limit: z.number().int().min(1).max(50).optional(),
			})
			.meta({ id: "CalendarEventsRequest" }),
		answer: z
			.object({ events: z.array(PhoneCalendarEventSchema).max(50), partial: z.boolean().optional() })
			.meta({ id: "CalendarEventsAnswer" }),
		kind: "read",
		where: "phone",
		needs: ["calendar"],
		label: "Calendar events",
		describe: `
# Calendar events

Lists the holding phone's calendar instances.

- \`from\` defaults to now; \`days\` ahead defaults to 7.
- \`query\` filters on the title; \`limit\` defaults to 20.
- Times are ISO 8601 with the phone's offset. An all-day event carries dates, and its \`end\` is the day after its last day.
- \`daysUntil\` counts calendar days from the phone's today to the event's start day.
- \`partial\` true means the scan stopped at its row cap before the window ended; narrow \`days\` and ask again.
		`.trim(),
	},
	notifications_recent: {
		request: z
			.strictObject({
				app: z.string().min(1).max(80).optional(),
				limit: z.number().int().min(1).max(30).optional(),
			})
			.meta({ id: "NotificationsRecentRequest" }),
		answer: z
			.object({ notifications: z.array(PhoneNotificationSchema).max(30) })
			.meta({ id: "NotificationsRecentAnswer" }),
		kind: "read",
		where: "phone",
		needs: ["notification_access"],
		label: "Recent notifications",
		describe: `
# Recent notifications

Lists the last 100 notifications the listener has seen, newest first, showing or dismissed since.

- \`replyable\` means the notification carries an inline reply action.
- Posted times are ISO 8601 with the phone's offset.
- \`app\` filters by a case-insensitive substring of the app label or package; \`limit\` defaults to 10.
		`.trim(),
	},
	notification_reply: {
		request: z
			.strictObject({
				id: z.string().min(1).max(120),
				text: z.string().min(1).max(1000),
			})
			.meta({ id: "NotificationReplyRequest" }),
		answer: z.object({ sent: z.boolean() }).meta({ id: "NotificationReplyAnswer" }),
		kind: "guarded",
		where: "phone",
		needs: ["notification_access", "notifications"],
		label: "Reply to a notification",
		describe: `
# Reply to a notification

Sends the text through the notification's own inline reply. Sent is false when the notification is gone or has no reply.
		`.trim(),
	},
	// An act leaves a trace notification.
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
		needs: ["notifications"],
		label: "Torch",
		describe: `
# Torch

Turn the holding phone's torch on or off. \`strength\` is a percent where the phone has levels.
		`.trim(),
	},
	maps_open: {
		request: z
			.strictObject({
				query: z.string().min(1).max(200),
				navigate: z.boolean().optional(),
			})
			.meta({ id: "MapsOpenRequest" }),
		answer: z.object({ opened: z.boolean() }).meta({ id: "MapsOpenAnswer" }),
		kind: "act",
		where: "phone",
		needs: ["notifications"],
		label: "Open maps",
		describe: `
# Open maps

Opens \`query\` in a map app. \`opened\` says Android accepted the start; \`app_missing\` says no app handles it.
		`.trim(),
	},
	app_open: {
		request: z.strictObject({ app: z.string().min(1).max(80) }).meta({ id: "AppOpenRequest" }),
		answer: z
			.object({
				opened: z.boolean(),
				package: z.string().max(120).optional(),
				candidates: z.array(LaunchableAppSchema).max(10).optional(),
			})
			.meta({ id: "AppOpenAnswer" }),
		kind: "act",
		where: "phone",
		needs: ["notifications"],
		label: "Open an app",
		describe: `
# Open an app

Opens the one launchable app matching \`app\` by label or package. \`opened\` says Android accepted the start; \`candidates\` lists label and package when several match, so a package names one exactly.
		`.trim(),
	},
	alarm_set: {
		request: z
			.strictObject({
				hour: z.number().int().min(0).max(23),
				minutes: z.number().int().min(0).max(59),
				message: z.string().min(1).max(80).optional(),
			})
			.meta({ id: "AlarmSetRequest" }),
		answer: z.object({ set: z.boolean() }).meta({ id: "AlarmSetAnswer" }),
		kind: "act",
		where: "phone",
		needs: ["notifications"],
		label: "Set an alarm",
		describe: `
# Set an alarm

Sets an alarm for \`hour\` and \`minutes\`. \`set\` says Android accepted the request; the clock app decides whether its screen opens. \`app_missing\` says no clock app handles it.
		`.trim(),
	},
	timer_set: {
		request: z
			.strictObject({
				seconds: z.number().int().min(1).max(86400),
				message: z.string().min(1).max(80).optional(),
			})
			.meta({ id: "TimerSetRequest" }),
		answer: z.object({ set: z.boolean() }).meta({ id: "TimerSetAnswer" }),
		kind: "act",
		where: "phone",
		needs: ["notifications"],
		label: "Set a timer",
		describe: `
# Set a timer

Sets a timer for \`seconds\`. \`set\` says Android accepted the request; the clock app decides whether its screen opens. \`app_missing\` says no clock app handles it.
		`.trim(),
	},
	sms: {
		request: z
			.strictObject({
				to: z.string().min(1).max(40),
				body: z.string().min(1).max(1000),
				send: z.boolean().optional(),
			})
			.meta({ id: "SmsRequest" }),
		answer: z.object({ sent: z.boolean(), parts: z.number().int().nonnegative() }).meta({ id: "SmsAnswer" }),
		kind: "guarded",
		guardedWhen: (params) => (params as { send?: boolean }).send === true,
		where: "phone",
		needs: ["send_sms", "notifications"],
		label: "Text",
		describe: `
# Text

\`send\` defaults to false and opens the owner's messaging app with the recipient and body prepared.
Set it true only when the owner directly asks in words to send the text through, such as
"send a text to mom saying ...". Never set it for "draft", "write up" or "get ready to" requests.
When unclear, ask the owner out loud first; a plain "yes" or "yeah" is enough. Use digits with an
optional leading plus for the number; look up a contact with \`contacts_search\` first. \`sent\`
means the message was handed to the SMS service; it says nothing about leaving the phone or being
delivered. A draft needs the phone shown and unlocked, else \`not_showing\`; a send does not.
		`.trim(),
	},
	call: {
		request: z
			.strictObject({ number: z.string().min(1).max(40), place: z.boolean().optional() })
			.meta({ id: "CallRequest" }),
		answer: z.object({ calling: z.boolean() }).meta({ id: "CallAnswer" }),
		kind: "guarded",
		guardedWhen: (params) => (params as { place?: boolean }).place === true,
		where: "phone",
		needs: ["call_phone", "notifications"],
		label: "Call",
		describe: `
# Call

\`place\` defaults to false and opens the owner's dialer with the number prepared. Set it true
only when the owner directly asks in words to call through, such as "call mom". Never set it for
"draft", "write up" or "get ready to" requests. When unclear, ask the owner out loud first; a
plain "yes" or "yeah" is enough. Use digits with an optional leading plus for the number; look up
a contact with \`contacts_search\` first. Either way the phone must be shown and unlocked, else
\`not_showing\`. An emergency number only opens the dialer, since Android lets the owner alone
place that call, and \`calling\` is then false.
		`.trim(),
	},
	ifttt_trigger: {
		request: z
			.strictObject({
				event: z
					.string()
					.min(1)
					.max(80)
					.regex(/^[A-Za-z0-9_-]+$/),
				value1: z.string().max(500).optional(),
				value2: z.string().max(500).optional(),
				value3: z.string().max(500).optional(),
			})
			.meta({ id: "IftttTriggerRequest" }),
		answer: z.object({ status: z.number().int(), ok: z.boolean() }).meta({ id: "IftttTriggerAnswer" }),
		kind: "act",
		where: "gateway",
		needs: [],
		label: "Fire an IFTTT event",
		describe: `
# Fire an IFTTT event

Posts the event to the owner's IFTTT Webhooks with the three optional values. The webhook key must be granted on the phone under Integrations. The \`ok\` field means the webhook accepted it. A \`status\` of 0 means no response reached the Gateway, so the event may or may not have fired; do not fire it again without asking.
		`.trim(),
	},
} as const satisfies Record<string, PhoneCapabilityDeclaration>;

export type PhoneCapabilityKey = keyof typeof PHONE_CAPABILITIES;

export const PHONE_CAPABILITY_KEYS = Object.keys(PHONE_CAPABILITIES) as PhoneCapabilityKey[];

export type PhoneRequestOf<K extends PhoneCapabilityKey> = z.infer<(typeof PHONE_CAPABILITIES)[K]["request"]>;
export type PhoneAnswerOf<K extends PhoneCapabilityKey> = z.infer<(typeof PHONE_CAPABILITIES)[K]["answer"]>;
export type IftttTriggerRequest = PhoneRequestOf<"ifttt_trigger">;
export type IftttTriggerAnswer = PhoneAnswerOf<"ifttt_trigger">;

type KeysWhere<Host extends CapabilityHost> = {
	[K in PhoneCapabilityKey]: (typeof PHONE_CAPABILITIES)[K]["where"] extends Host ? K : never;
}[PhoneCapabilityKey];

export type GatewayCapabilityKey = KeysWhere<"gateway">;
export type PhoneSideCapabilityKey = KeysWhere<"phone">;

/** Required gateway handlers. */
export type GatewayCapabilityRuns = {
	[K in GatewayCapabilityKey]: (params: PhoneRequestOf<K>) => Promise<PhoneAnswerOf<K>>;
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
	z.strictObject({ kind: z.literal("ok"), answer: z.unknown() }),
]);

export type PhoneCapabilityResult = z.infer<typeof PhoneCapabilityResultSchema>;

export function capabilityNeedsLine(key: PhoneCapabilityKey): string {
	const declaration = PHONE_CAPABILITIES[key];
	const needs = declaration.needs.length === 0 ? "no phone permission" : declaration.needs.join(", ");
	const where = declaration.where as CapabilityHost;
	const kind =
		where === "gateway"
			? "Runs on the Gateway."
			: declaration.kind === "read"
				? "A read: runs on the holding phone."
				: declaration.kind === "act"
					? "An act: runs on the holding phone and leaves a trace."
					: "A guarded act may need owner approval.";
	return `${kind} Needs ${needs}.`;
}
