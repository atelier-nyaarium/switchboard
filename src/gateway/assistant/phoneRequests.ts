import type { Ambient } from "../../shared/ambient.js";
import { ASSISTANT_TEAM } from "../../shared/assistant-session.js";
import type { DurableStore } from "../../shared/durable-store.js";
import type { MIGRATING } from "../../shared/migration-fence.js";
import {
	PHONE_CAPABILITIES,
	type PhoneCapabilityAnswer,
	PhoneCapabilityAnswerSchema,
	type PhoneCapabilityKey,
	type PhoneCapabilityRow,
	PhoneCapabilityRowSchema,
	type PhoneRequestOf,
} from "../../shared/schemasPhoneCapabilities.js";
import type { OwnerAppendAnswer } from "../consolePushOps.js";
import { createOwnerRequests, type OpenStub, type OwnerRequestOpened } from "../ownerRequests.js";
import { ASSISTANT_WAITS } from "./waits.js";

export type PhoneRequest = Omit<PhoneCapabilityRow, "key"> & { key: PhoneCapabilityKey; sessionTarget: string };
export type PhoneRequestAnswer = PhoneCapabilityAnswer | { kind: "refused"; reason: string };
export type PhoneRequestOpened = OwnerRequestOpened<PhoneRequest, PhoneRequestAnswer>;
type CapabilityGuard = PhoneCapabilityRow["guard"];

export interface PhoneRequestDelivery {
	queued: true;
	completion: Promise<OwnerAppendAnswer>;
}

export interface PhoneRequestsDeps {
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
	deliver: (request: PhoneRequest) => boolean | typeof MIGRATING | PhoneRequestDelivery;
	retract: (request: PhoneRequest) => boolean;
	ledger?: Pick<DurableStore, "load" | "save">;
}

export function createPhoneRequests(deps: PhoneRequestsDeps) {
	const stamps = new Map<string, string>();
	const appendAnswers = new Map<string, Promise<OwnerAppendAnswer>>();
	const core = createOwnerRequests<PhoneRequest, PhoneRequestAnswer>({
		ambient: deps.ambient,
		deadlineMs: ASSISTANT_WAITS.phone,
		maxOpenPerTarget: 8,
		deliver: (request) => {
			const delivered = deps.deliver(request);
			if (typeof delivered !== "object") return delivered;
			appendAnswers.set(request.requestId, delivered.completion);
			void delivered.completion.then((answer) => {
				if (answer.kind === "accepted" && answer.stamp) {
					stamps.set(request.requestId, answer.stamp.device);
					return;
				}
				const settled =
					answer.kind === "refused" && answer.reason === "no_holder"
						? { kind: "unavailable" as const, reason: "no_holder" as const }
						: {
								kind: "refused" as const,
								reason:
									answer.kind === "accepted"
										? "the Router did not stamp the holder row"
										: `the Router refused the phone request: ${answer.reason}`,
							};
				core.settle(request.requestId, settled);
			});
			return true;
		},
		lapsed: () => ({ kind: "unavailable", reason: "timeout" }),
		onSettled: (request) => {
			stamps.delete(request.requestId);
			appendAnswers.delete(request.requestId);
			return deps.retract(request);
		},
		ledger: deps.ledger,
		collectUntil: ({ cause, at, deadlineAt }) => (cause === "answered" ? deadlineAt : at),
	});

	const open = <K extends PhoneCapabilityKey>(input: {
		callId: string;
		key: K;
		params: PhoneRequestOf<K>;
		guard: CapabilityGuard;
	}): PhoneRequestOpened =>
		core.open({
			sessionTarget: ASSISTANT_TEAM,
			requestId: input.callId,
			payload: undefined,
			build: (requestId, deadlineAt) => ({
				...PhoneCapabilityRowSchema.parse({
					requestId,
					key: input.key,
					params: input.params,
					guard: input.guard,
					deadlineAt,
				}),
				key: input.key,
				sessionTarget: ASSISTANT_TEAM,
			}),
		});

	const answer = async (
		requestId: string,
		raw: unknown,
		device: string,
	): Promise<{ ok: boolean; reason?: string }> => {
		const request = core.live(requestId);
		if (!request) return { ok: false, reason: core.answered(requestId) ? "already answered" : "request expired" };
		const append = appendAnswers.get(requestId);
		if (!append) return { ok: false, reason: "the phone request has no append result" };
		const appended = await append;
		if (appended.kind !== "accepted" || !appended.stamp)
			return { ok: false, reason: "the phone request has no holder stamp" };
		const stampedDevice = stamps.get(requestId);
		if (!stampedDevice) return { ok: false, reason: "the phone request has no holder stamp" };
		if (device !== stampedDevice) return { ok: false, reason: "the answer came from a different phone" };
		const live = core.live(requestId);
		if (!live) return { ok: false, reason: core.answered(requestId) ? "already answered" : "request expired" };
		const parsed = PhoneCapabilityAnswerSchema.safeParse(raw);
		if (!parsed.success) return { ok: false, reason: "the phone answer did not parse" };
		if (parsed.data.kind === "ok") {
			const declaration = PHONE_CAPABILITIES[live.key];
			const result = declaration.answer.safeParse(parsed.data.answer);
			if (!result.success) return { ok: false, reason: "the capability answer did not match its schema" };
			const settled = core.settle(requestId, { kind: "ok", answer: result.data });
			return settled ? { ok: true } : { ok: false, reason: "request expired" };
		}
		const settled = core.settle(requestId, parsed.data);
		return settled ? { ok: true } : { ok: false, reason: "request expired" };
	};

	return {
		open,
		answer,
		sessionEnded: core.sessionEnded,
		retractStale: (retract: (stub: OpenStub) => boolean) => core.retractStale(retract),
	};
}

export type PhoneRequests = ReturnType<typeof createPhoneRequests>;
