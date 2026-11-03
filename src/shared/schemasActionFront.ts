// Family/key ids; one schema per id.

import { z } from "zod";
import {
	ASSISTANT_ACTION_KEYS,
	ASSISTANT_ACTIONS,
	type AssistantActionKey,
	type AssistantActionResult,
	watcherParamsSchema,
} from "./schemasAssistantActions.js";
import {
	type CapabilityHost,
	capabilityNeedsLine,
	type GatewayCapabilityKey,
	PHONE_CAPABILITIES,
	PHONE_CAPABILITY_KEYS,
	type PhoneCapabilityKey,
	PhonePermissionSchema,
	type PhoneSideCapabilityKey,
	type UnavailableReason,
	UnavailableReasonSchema,
} from "./schemasPhoneCapabilities.js";

export const ACTION_FRONT_ROUTES = { list: "/assistant/actions", run: "/assistant/run" } as const;

// Remove after 2026-11-16: an older plugin's doors.
export const ACTION_FRONT_LEGACY_ROUTES = { action: "/assistant/action", phone: "/assistant/phone" } as const;

export const ACTION_FRONT_TOOLS = { list: "list_actions", run: "run_action" } as const;

/** Where it runs. */
export const ACTION_FAMILIES = ["phone", "gateway", "watcher"] as const;

export type ActionFamily = (typeof ACTION_FAMILIES)[number];

export type PhoneActionId = `phone/${PhoneSideCapabilityKey}`;
export type GatewayActionId = `gateway/${GatewayCapabilityKey}`;
export type WatcherActionId = `watcher/${AssistantActionKey}`;
export type ActionId = PhoneActionId | GatewayActionId | WatcherActionId;

export const ACTION_IDS: readonly ActionId[] = [
	...PHONE_CAPABILITY_KEYS.map((key) => `${PHONE_CAPABILITIES[key].where}/${key}` as PhoneActionId | GatewayActionId),
	...ASSISTANT_ACTION_KEYS.map((key): WatcherActionId => `watcher/${key}`),
];

export const ActionIdSchema = z.enum(ACTION_IDS as [ActionId, ...ActionId[]]);

export type ActionRef =
	| { family: "phone" | "gateway"; key: PhoneCapabilityKey }
	| { family: "watcher"; key: AssistantActionKey };

export function actionRef(id: ActionId): ActionRef {
	const slash = id.indexOf("/");
	const family = id.slice(0, slash) as ActionFamily;
	const key = id.slice(slash + 1);
	return family === "watcher"
		? { family, key: key as AssistantActionKey }
		: { family, key: key as PhoneCapabilityKey };
}

/** Null for an id this build does not know. */
export function actionRefOf(id: string): ActionRef | null {
	const known = ActionIdSchema.safeParse(id);
	return known.success ? actionRef(known.data) : null;
}

/** Shared parse and listing schema. */
export function actionParamsSchema(id: ActionId): z.ZodType {
	const ref = actionRef(id);
	return ref.family === "watcher" ? watcherParamsSchema(ref.key) : PHONE_CAPABILITIES[ref.key].request;
}

/** Last status, per key. */
export interface KeyAvailability {
	available: boolean;
	reason?: UnavailableReason;
}

/** A catalog: a reader keeps an entry it does not know. */
export const ActionListingSchema = z.object({
	id: z.string().min(3).max(100),
	family: z.string().max(32),
	label: z.string().max(80),
	usage: z.string().max(4_000),
	kind: z.string().max(32),
	needs: z.array(z.string().max(32)),
	/** Null until reported. */
	available: z.boolean().nullable(),
	reason: z.string().max(64).optional(),
	/** Phone action host. */
	where: z.string().max(16).optional(),
	/** JSON Schema of `params`. */
	params: z.record(z.string(), z.unknown()),
});

export type ActionListing = z.infer<typeof ActionListingSchema>;

export const ActionListAnswerSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("not_assistant") }),
	z.strictObject({ kind: z.literal("unauthenticated") }),
	z.strictObject({ kind: z.literal("listed"), actions: z.array(ActionListingSchema) }),
]);

export type ActionListAnswer = z.infer<typeof ActionListAnswerSchema>;

/** Root ref inlined. */
function paramsJsonSchema(id: ActionId): Record<string, unknown> {
	const rendered = z.toJSONSchema(actionParamsSchema(id), { io: "input" }) as Record<string, unknown>;
	const root = typeof rendered.$ref === "string" ? rendered.$ref.replace("#/$defs/", "") : null;
	const definitions = rendered.$defs as Record<string, Record<string, unknown>> | undefined;
	const inlined = root ? definitions?.[root] : undefined;
	if (!inlined) return rendered;
	const { $ref: _ref, $defs: _defs, ...rest } = rendered;
	const { [root as string]: _own, ...others } = definitions ?? {};
	return { ...rest, ...inlined, ...(Object.keys(others).length ? { $defs: others } : {}) };
}

export function actionListings(status: ReadonlyMap<string, KeyAvailability> | null): ActionListing[] {
	return ACTION_IDS.map((id) => {
		const ref = actionRef(id);
		const params = paramsJsonSchema(id);
		if (ref.family === "watcher") {
			const declaration = ASSISTANT_ACTIONS[ref.key];
			return {
				id,
				family: "watcher",
				label: declaration.label,
				usage: declaration.usage,
				kind: "act",
				needs: [],
				available: null,
				params,
			};
		}
		const declaration = PHONE_CAPABILITIES[ref.key];
		const where = declaration.where as CapabilityHost;
		const known = where === "gateway" ? undefined : status?.get(ref.key);
		return {
			id,
			family: ref.family,
			label: declaration.label,
			usage: `${declaration.describe}\n\n${capabilityNeedsLine(ref.key)}`,
			kind: declaration.kind,
			needs: [...declaration.needs],
			available: known?.available ?? null,
			...(known?.reason ? { reason: known.reason } : {}),
			where,
			params,
		};
	});
}

/** Retries reuse call ids. */
const CallIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

export const ActionRunBodySchema = z.strictObject({ id: ActionIdSchema, callId: CallIdSchema, params: z.unknown() });

/** Device tool body. */
export const DeviceRunBodySchema = z.strictObject({ device: z.record(z.string(), z.unknown()), callId: CallIdSchema });

export const ActionRunRequestSchema = z.union([ActionRunBodySchema, DeviceRunBodySchema]);

export type ActionRunRequest = z.infer<typeof ActionRunBodySchema>;
export type DeviceRunRequest = z.infer<typeof DeviceRunBodySchema>;

export const ActionRunResultSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("not_assistant") }),
	z.strictObject({ kind: z.literal("unauthenticated") }),
	z.strictObject({ kind: z.literal("refused"), reason: z.string().max(400) }),
	z.strictObject({
		kind: z.literal("unavailable"),
		reason: UnavailableReasonSchema,
		needs: z.array(PhonePermissionSchema).optional(),
		detail: z.string().max(400).optional(),
	}),
	/** Per-id answer; phone records nothing. */
	z.strictObject({ kind: z.literal("ok"), answer: z.unknown(), recorded: z.boolean().optional() }),
]);

export type ActionRunResult = z.infer<typeof ActionRunResultSchema>;

export function runResultOfWatcher(result: AssistantActionResult): ActionRunResult {
	return result.kind === "ran" ? { kind: "ok", answer: result.answer, recorded: result.recorded } : result;
}
