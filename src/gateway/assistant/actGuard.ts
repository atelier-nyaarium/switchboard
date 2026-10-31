import type { Ambient } from "../../shared/ambient.js";
import { ASSISTANT_TEAM } from "../../shared/assistant-session.js";
import type { DurableStore } from "../../shared/durable-store.js";
import type { MIGRATING } from "../../shared/migration-fence.js";
import {
	type AssistantActRequest,
	AssistantActRequestSchema,
	PHONE_CAPABILITIES,
	type PhoneCapabilityKey,
	type PhoneRequestOf,
} from "../../shared/schemasPhoneCapabilities.js";
import { createOwnerRequests, type OpenStub } from "../ownerRequests.js";
import type { PhoneRequestAnswer } from "./phoneRequests.js";
import { ASSISTANT_WAITS } from "./waits.js";

type ActRequest = AssistantActRequest & { sessionTarget: string; key: PhoneCapabilityKey };
type ActPayload = { key: PhoneCapabilityKey; params: unknown };
type ActAnswer = PhoneRequestAnswer;

export interface ActGuardDeps {
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
	deliver: (request: AssistantActRequest) => boolean | typeof MIGRATING;
	retract: (requestId: string) => boolean;
	runPhone: <K extends PhoneCapabilityKey>(input: {
		callId: string;
		key: K;
		params: PhoneRequestOf<K>;
		guard: "approved";
	}) => Promise<ActAnswer>;
	ledger?: Pick<DurableStore, "load" | "save">;
}

export function createActGuard(deps: ActGuardDeps) {
	const core = createOwnerRequests<ActRequest, ActAnswer, ActPayload>({
		ambient: deps.ambient,
		deadlineMs: ASSISTANT_WAITS.phone,
		maxOpenPerTarget: 8,
		deliver: (request) => deps.deliver(request),
		lapsed: () => ({ kind: "unavailable", reason: "timeout" }),
		onSettled: (request) => deps.retract(request.requestId),
		ledger: deps.ledger,
		collectUntil: ({ cause, at, deadlineAt }) => (cause === "answered" ? deadlineAt : at),
	});

	const run = <K extends PhoneCapabilityKey>(input: {
		callId: string;
		key: K;
		params: PhoneRequestOf<K>;
	}): Promise<ActAnswer> => {
		const declaration = PHONE_CAPABILITIES[input.key];
		const opened = core.open({
			sessionTarget: ASSISTANT_TEAM,
			requestId: input.callId,
			payload: { key: input.key, params: input.params },
			build: (requestId, deadlineAt) => ({
				...AssistantActRequestSchema.parse({
					requestId,
					key: input.key,
					label: declaration.label,
					summary: `${declaration.label}: ${JSON.stringify(input.params)}`.slice(0, 400),
					deadlineAt,
				}),
				sessionTarget: ASSISTANT_TEAM,
				key: input.key,
			}),
		});
		if (opened.kind === "opened") return opened.answer;
		return Promise.resolve({ kind: "refused", reason: `the approval card could not be opened: ${opened.reason}` });
	};

	const answer = (
		requestId: string,
		decision: "approve" | "deny",
		note?: string,
	): { ok: boolean; reason?: string } => {
		const gone = (): { ok: false; reason: string } => ({
			ok: false,
			reason: core.answered(requestId) ? "already answered" : "request expired",
		});
		if (decision === "deny") {
			if (!core.live(requestId)) return gone();
			const settled = core.settle(requestId, {
				kind: "refused",
				reason: note?.slice(0, 400) || "the owner denied this action",
			});
			return settled ? { ok: true } : gone();
		}
		const claimed = core.claim(requestId);
		if (!claimed) return gone();
		const runPhone = deps.runPhone as (input: {
			callId: string;
			key: PhoneCapabilityKey;
			params: unknown;
			guard: "approved";
		}) => Promise<ActAnswer>;
		void runPhone({
			callId: requestId,
			key: claimed.payload.key,
			params: claimed.payload.params,
			guard: "approved",
		}).then(
			(answer) => core.settle(requestId, answer),
			(error) => core.settle(requestId, { kind: "refused", reason: String(error).slice(0, 400) }),
		);
		return { ok: true };
	};

	return {
		run,
		answer,
		sessionEnded: core.sessionEnded,
		retractStale: (retract: (stub: OpenStub) => boolean) => core.retractStale(retract),
	};
}

export type ActGuard = ReturnType<typeof createActGuard>;
