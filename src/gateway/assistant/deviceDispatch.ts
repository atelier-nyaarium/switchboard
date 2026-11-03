import type { Ambient } from "../../shared/ambient.js";
import { createOpDedupe } from "../../shared/op-dedupe.js";
import type { ActionRunResult, DeviceRunRequest } from "../../shared/schemasActionFront.js";
import { type DeviceToolOp, DeviceToolOpSchema, dangerActOf } from "../../shared/schemasDeviceTool.js";
import type { DeviceStage } from "../compose/composeDevices.js";
import type { ActGuard } from "./actGuard.js";
import { runResultOf } from "./phoneDispatch.js";
import type { PhoneRequestAnswer } from "./phoneRequests.js";
import { CALL_HOLD_MS } from "./waits.js";

export type DeviceSurface = Pick<DeviceStage, "assistant" | "record">;

export interface DeviceDispatchDeps {
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	devices: DeviceSurface | null;
	act: Pick<ActGuard, "runDevice">;
}

function parseOp(raw: unknown): { op: DeviceToolOp } | { refused: string } {
	const parsed = DeviceToolOpSchema.safeParse(raw);
	if (parsed.success) return { op: parsed.data };
	const issue = parsed.error.issues[0];
	return { refused: `${issue?.path.join(".") || "op"}: ${issue?.message}`.slice(0, 400) };
}

/** Danger acts wait on the card. */
export function createDeviceDispatch(
	deps: DeviceDispatchDeps,
): (request: DeviceRunRequest) => Promise<ActionRunResult> {
	const calls = createOpDedupe<ActionRunResult>({ now: () => deps.ambient.now(), holdMs: CALL_HOLD_MS });

	const runOne = async (request: DeviceRunRequest): Promise<ActionRunResult> => {
		const parsed = parseOp(request.device);
		if ("refused" in parsed) return { kind: "refused", reason: parsed.refused };
		if (!deps.devices) return { kind: "unavailable", reason: "not_supported" };
		const { op } = parsed;
		const record = "id" in op ? deps.devices.record(op.id) : null;
		const danger = record ? dangerActOf(op, record.driver) : null;
		if (record && danger) {
			const answer = await deps.act.runDevice({
				callId: request.callId,
				kind: op.kind,
				op,
				label: danger.label,
				summary: `${danger.label}: ${record.name}. ${danger.confirm ?? ""}`.trim(),
			});
			return runResultOf(answer);
		}
		return { kind: "ok", answer: await deps.devices.assistant(op) };
	};

	return (request) => calls.once(request.callId, () => runOne(request));
}

/** Approved op callback. */
export function approvedDeviceRun(
	devices: DeviceSurface | null,
): (callId: string, op: unknown) => Promise<PhoneRequestAnswer> {
	return async (_callId, raw) => {
		const parsed = parseOp(raw);
		if ("refused" in parsed) return { kind: "refused", reason: parsed.refused };
		if (!devices) return { kind: "unavailable", reason: "not_supported" };
		return { kind: "ok", answer: await devices.assistant(parsed.op, "approved") };
	};
}
