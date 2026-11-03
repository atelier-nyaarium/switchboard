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

type ActRequest = AssistantActRequest & { sessionTarget: string };
type ActPayload = { key: PhoneCapabilityKey; params: unknown } | { device: unknown };
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
	runDevice: (callId: string, op: unknown) => Promise<ActAnswer>;
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

	const open = (input: {
		callId: string;
		key: string;
		label: string;
		summary: string;
		payload: ActPayload;
	}): Promise<ActAnswer> => {
		const opened = core.open({
			sessionTarget: ASSISTANT_TEAM,
			requestId: input.callId,
			payload: input.payload,
			build: (requestId, deadlineAt) => ({
				...AssistantActRequestSchema.parse({
					requestId,
					key: input.key,
					label: input.label,
					summary: input.summary.slice(0, 400),
					deadlineAt,
				}),
				sessionTarget: ASSISTANT_TEAM,
			}),
		});
		if (opened.kind === "opened") return opened.answer;
		return Promise.resolve({ kind: "refused", reason: `the approval card could not be opened: ${opened.reason}` });
	};

	const run = <K extends PhoneCapabilityKey>(input: {
		callId: string;
		key: K;
		params: PhoneRequestOf<K>;
	}): Promise<ActAnswer> => {
		const { label } = PHONE_CAPABILITIES[input.key];
		return open({
			callId: input.callId,
			key: input.key,
			label,
			summary: `${label}: ${JSON.stringify(input.params)}`,
			payload: { key: input.key, params: input.params },
		});
	};

	const runDevice = (input: { callId: string; kind: string; op: unknown; label: string; summary: string }) =>
		open({
			callId: input.callId,
			key: `device/${input.kind}`,
			label: input.label,
			summary: input.summary,
			payload: { device: input.op },
		});

	const approved = (requestId: string, payload: ActPayload): Promise<ActAnswer> => {
		if ("device" in payload) return deps.runDevice(requestId, payload.device);
		const runPhone = deps.runPhone as (input: {
			callId: string;
			key: PhoneCapabilityKey;
			params: unknown;
			guard: "approved";
		}) => Promise<ActAnswer>;
		return runPhone({ callId: requestId, key: payload.key, params: payload.params, guard: "approved" });
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
		void approved(requestId, claimed.payload).then(
			(answer) => core.settle(requestId, answer),
			(error) => core.settle(requestId, { kind: "refused", reason: String(error).slice(0, 400) }),
		);
		return { ok: true };
	};

	return {
		run,
		runDevice,
		answer,
		sessionEnded: core.sessionEnded,
		retractStale: (retract: (stub: OpenStub) => boolean) => core.retractStale(retract),
	};
}

export type ActGuard = ReturnType<typeof createActGuard>;
