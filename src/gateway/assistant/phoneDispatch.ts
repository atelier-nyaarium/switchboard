import type { Ambient } from "../../shared/ambient.js";
import { type HoldAnswer, holdDenial } from "../../shared/assistant-hold.js";
import { createOpDedupe } from "../../shared/op-dedupe.js";
import type { RecordThread } from "../../shared/schemasAssistantRecord.js";
import type {
	GatewayCapabilityRuns,
	PhoneCapabilityDeclaration,
	PhoneCapabilityKey,
	PhoneCapabilityRequest,
	PhoneCapabilityResult,
	PhoneCapabilityRow,
	PhoneRequestOf,
} from "../../shared/schemasPhoneCapabilities.js";
import { PHONE_CAPABILITIES } from "../../shared/schemasPhoneCapabilities.js";
import type { ActGuard } from "./actGuard.js";
import type { ActionRecord } from "./actionDispatch.js";
import type { PhoneRequestAnswer, PhoneRequests } from "./phoneRequests.js";

const CALL_HOLD_MS = 10 * 60_000;
type CapabilityGuard = PhoneCapabilityRow["guard"];

export interface PhoneDispatchDeps {
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	approveEverySend: () => boolean;
	hold: () => HoldAnswer;
	phone: Pick<PhoneRequests, "open">;
	act: Pick<ActGuard, "run">;
	gateways: GatewayCapabilityRuns<unknown>;
	record: (callId: string, record: ActionRecord) => boolean;
}

type PhoneAnswer = PhoneRequestAnswer;

function refusal(opened: Exclude<Awaited<ReturnType<PhoneRequests["open"]>>, { kind: "opened" }>): PhoneAnswer {
	return {
		kind: "refused",
		reason:
			opened.reason === "flooded"
				? "too many phone requests are waiting"
				: opened.reason === "migrating"
					? "the Gateway is migrating"
					: "the phone request could not be queued",
	};
}

function resultOf(answer: PhoneAnswer, recorded: boolean): PhoneCapabilityResult {
	if (answer.kind === "ok") return { kind: "ok", answer: answer.answer, recorded };
	if (answer.kind === "unavailable") {
		return {
			kind: "unavailable",
			reason: answer.reason,
			...(answer.needs ? { needs: answer.needs } : {}),
			...(answer.detail ? { detail: answer.detail } : {}),
		};
	}
	return { kind: "refused", reason: answer.reason.slice(0, 400) };
}

export function createPhoneDispatch(
	deps: PhoneDispatchDeps,
): (request: PhoneCapabilityRequest) => Promise<PhoneCapabilityResult> {
	const calls = createOpDedupe<PhoneCapabilityResult>({ now: () => deps.ambient.now(), holdMs: CALL_HOLD_MS });

	const runOne = async (request: PhoneCapabilityRequest): Promise<PhoneCapabilityResult> => {
		const declaration: PhoneCapabilityDeclaration = PHONE_CAPABILITIES[request.key];
		const parsed = declaration.request.safeParse(request.params);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			return finish(request.callId, request.key, {
				kind: "refused",
				reason: `${issue?.path.join(".") || "params"}: ${issue?.message}`.slice(0, 400),
			});
		}
		const params = parsed.data as PhoneRequestOf<typeof request.key>;
		if (declaration.where === "gateway") {
			const run = (deps.gateways as Record<string, ((value: unknown) => Promise<unknown>) | undefined>)[
				request.key
			];
			if (!run) return finish(request.callId, request.key, { kind: "unavailable", reason: "not_supported" });
			try {
				const answer = declaration.answer.parse(await run(params));
				return finish(request.callId, request.key, { kind: "ok", answer });
			} catch (error) {
				return finish(request.callId, request.key, {
					kind: "refused",
					reason: (error as Error).message.slice(0, 400),
				});
			}
		}

		const denied = holdRefusal(deps.hold);
		if (denied) return finish(request.callId, request.key, denied);

		let answer: PhoneAnswer;
		if (declaration.kind === "guarded" && safelyApproves(deps.approveEverySend)) {
			answer = await (
				deps.act.run as unknown as (input: {
					callId: string;
					key: PhoneCapabilityKey;
					params: unknown;
				}) => Promise<PhoneAnswer>
			)({ callId: request.callId, key: request.key, params });
		} else {
			const guard: CapabilityGuard = declaration.kind === "guarded" ? "unasked" : "none";
			const opened = await (
				deps.phone.open as unknown as (input: {
					callId: string;
					key: PhoneCapabilityKey;
					params: unknown;
					guard: CapabilityGuard;
				}) => ReturnType<PhoneRequests["open"]>
			)({
				callId: request.callId,
				key: request.key,
				params,
				guard,
			});
			answer = opened.kind === "opened" ? await opened.answer : refusal(opened);
		}
		return finish(request.callId, request.key, answer);
	};

	const finish = (callId: string, key: PhoneCapabilityKey, answer: PhoneAnswer): PhoneCapabilityResult => {
		const outcome: RecordThread["outcome"] =
			answer.kind === "ok" ? "ran" : answer.kind === "unavailable" ? "unavailable" : "refused";
		const recorded = deps.record(callId, {
			notify: false,
			threads: [{ threadId: key, outcome }],
		});
		return resultOf(answer, recorded);
	};

	return (request) => calls.once(request.callId, () => runOne(request));
}

/** Same refusal as the gate. */
export function holdRefusal(read: () => HoldAnswer): PhoneAnswer | null {
	let answer: HoldAnswer;
	try {
		answer = read();
	} catch (error) {
		return {
			kind: "unavailable",
			reason: "no_holder",
			detail: holdDenial({ kind: "unreadable", reason: String(error) }).slice(0, 400),
		};
	}
	if (answer.kind === "held") return null;
	return { kind: "unavailable", reason: "no_holder", detail: holdDenial(answer).slice(0, 400) };
}

function safelyApproves(read: () => boolean): boolean {
	try {
		return read();
	} catch {
		return true;
	}
}
