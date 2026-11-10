import { z } from "zod";
import type { HostOp, HostOpResult, TypeIntoPaneResult } from "../../shared/host-op.js";
import { isHostSpawn } from "../../shared/host-spawn.js";
import { typesDelivery } from "../../shared/session-harness.js";
import { jsonResponse } from "../routeSchemas.js";
import type { SessionAuthority } from "../sessionAuthority.js";

const MAX_TYPE_TEXT_BYTES = 128_000;
const MAX_TYPE_KEY_LENGTH = 200;
const TypeSessionRequestSchema = z
	.object({
		text: z
			.string()
			.min(1)
			.max(MAX_TYPE_TEXT_BYTES)
			.refine((text) => Buffer.byteLength(text, "utf8") <= MAX_TYPE_TEXT_BYTES),
		/** The same key types once, so a retry after a lost answer does not type twice. */
		key: z.string().min(1).max(MAX_TYPE_KEY_LENGTH).optional(),
	})
	.strict();

export interface SessionRoutesDeps {
	auth?: SessionAuthority;
	relayToHost?: (op: HostOp) => Promise<HostOpResult>;
}

export function createSessionRoutes({ auth, relayToHost }: SessionRoutesDeps) {
	async function typeSession(req: Request, body: Record<string, unknown>): Promise<Response> {
		const parsed = TypeSessionRequestSchema.safeParse(body);
		if (!parsed.success) return jsonResponse({ error: "Invalid type request" }, 400);

		const record = auth?.resolveConfirmedManagedSession(req);
		if (!record) return jsonResponse({ error: "a confirmed session token is required" }, 403);
		if (!typesDelivery(record.harness) || !isHostSpawn(record.spawn)) {
			return jsonResponse({ error: "typed delivery is not available to this session" }, 403);
		}
		if (!relayToHost) return jsonResponse({ error: "host daemon unavailable" }, 503);

		const target = { kind: "host" as const, name: record.spawn, sessionName: record.id };
		const { key } = parsed.data;
		const relayed = await relayToHost({
			kind: "typeIntoPane",
			target,
			text: parsed.data.text,
			// Scoped to the session, so one session's key never replays another's.
			...(key ? { dedupKey: `type:${record.spawn}.${record.id}:${key}` } : {}),
		});
		if (!relayed.ok) {
			return jsonResponse(
				{ error: relayed.error ?? "host daemon unavailable" },
				relayed.errorKind === "timeout" ? 504 : 503,
			);
		}

		const outcome = relayed.result as TypeIntoPaneResult | undefined;
		if (outcome?.typed === true || (outcome?.typed === false && outcome.reason === "busy")) {
			return jsonResponse(outcome);
		}
		return jsonResponse({ error: "host daemon returned an invalid typing result" }, 502);
	}

	return { typeSession };
}
