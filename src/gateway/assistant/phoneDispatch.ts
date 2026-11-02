import { type Ambient, withinMs } from "../../shared/ambient.js";
import { type HoldAnswer, holdDenial } from "../../shared/assistant-hold.js";
import { createOpDedupe } from "../../shared/op-dedupe.js";
import type {
	GatewayCapabilityRuns,
	PhoneCapabilityDeclaration,
	PhoneCapabilityKey,
	PhoneCapabilityRequest,
	PhoneCapabilityResult,
	PhoneCapabilityRow,
} from "../../shared/schemasPhoneCapabilities.js";
import { PHONE_CAPABILITIES } from "../../shared/schemasPhoneCapabilities.js";
import type { ActGuard } from "./actGuard.js";
import { GatewayCapabilityRefusal } from "./gatewayCapabilityRefusal.js";
import type { PhoneRequestAnswer, PhoneRequests } from "./phoneRequests.js";
import { ASSISTANT_WAITS } from "./waits.js";

const CALL_HOLD_MS = 10 * 60_000;
type CapabilityGuard = PhoneCapabilityRow["guard"];

export interface PhoneDispatchDeps {
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	approveEverySend: () => boolean;
	hold: () => HoldAnswer;
	phone: Pick<PhoneRequests, "open">;
	act: Pick<ActGuard, "run">;
	gateways: GatewayCapabilityRuns;
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

function resultOf(answer: PhoneAnswer): PhoneCapabilityResult {
	if (answer.kind === "ok") return { kind: "ok", answer: answer.answer };
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

function parseParams<K extends PhoneCapabilityKey>(key: K, raw: unknown) {
	return PHONE_CAPABILITIES[key].request.safeParse(raw);
}

type LooseRun = (params: unknown) => Promise<unknown>;

function gatewayRun(runs: GatewayCapabilityRuns, key: PhoneCapabilityKey): LooseRun | undefined {
	// Parsed by key.
	return (runs as Partial<Record<PhoneCapabilityKey, LooseRun>>)[key];
}

export function createPhoneDispatch(
	deps: PhoneDispatchDeps,
): (request: PhoneCapabilityRequest) => Promise<PhoneCapabilityResult> {
	const calls = createOpDedupe<PhoneCapabilityResult>({ now: () => deps.ambient.now(), holdMs: CALL_HOLD_MS });

	const runOne = async (request: PhoneCapabilityRequest): Promise<PhoneCapabilityResult> => {
		const declaration: PhoneCapabilityDeclaration = PHONE_CAPABILITIES[request.key];
		const parsed = parseParams(request.key, request.params);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			return resultOf({
				kind: "refused",
				reason: `${issue?.path.join(".") || "params"}: ${issue?.message}`.slice(0, 400),
			});
		}
		const params = parsed.data;
		if (declaration.where === "gateway") {
			const run = gatewayRun(deps.gateways, request.key);
			if (!run) return resultOf({ kind: "unavailable", reason: "not_supported" });
			try {
				const result = await withinMs(deps.ambient, run(params), ASSISTANT_WAITS.action);
				if (result === null) return resultOf({ kind: "unavailable", reason: "timeout" });
				const answer = declaration.answer.parse(result);
				return resultOf({ kind: "ok", answer });
			} catch (error) {
				if (error instanceof GatewayCapabilityRefusal)
					return resultOf({ kind: "unavailable", reason: error.reason });
				return resultOf({
					kind: "refused",
					reason: "Gateway capability failed",
				});
			}
		}

		// The hold is the phone's road.
		const denied = holdRefusal(deps.hold);
		if (denied) return resultOf(denied);

		let answer: PhoneAnswer;
		const guarded = declaration.kind === "guarded" && (declaration.guardedWhen?.(params) ?? true);
		if (guarded && safelyApproves(deps.approveEverySend)) {
			answer = await deps.act.run({ callId: request.callId, key: request.key, params });
		} else {
			const guard: CapabilityGuard = guarded ? "unasked" : "none";
			const opened = await deps.phone.open({
				callId: request.callId,
				key: request.key,
				params,
				guard,
			});
			answer = opened.kind === "opened" ? await opened.answer : refusal(opened);
		}
		return resultOf(answer);
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
