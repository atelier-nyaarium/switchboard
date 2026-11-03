import type { z } from "zod";
import {
	DEVICE_CONSOLE_RESULTS,
	type DeviceConsoleOpKind,
	type DeviceConsoleResult,
	type DeviceRecord,
	type DeviceRefusal,
	type DeviceRefusalCode,
} from "../../shared/schemasDevices.js";
import {
	type AssistantDeviceRecord,
	type AssistantDeviceRefusal,
	DEVICE_TOOL_RESULTS,
	type DeviceToolOpKind,
	type DeviceToolResult,
} from "../../shared/schemasDeviceTool.js";
import type { DeviceDriverError } from "./driver.js";
import type { Declined, Shape } from "./road.js";

/** Caps the plug's text. */
export function describeFailure(failure: DeviceDriverError): string {
	return failure.kind === "refused"
		? `err_code ${failure.code}: ${failure.message.slice(0, 200)}`
		: failure.detail.slice(0, 400);
}

const FAILURE_CODES: Readonly<Record<DeviceDriverError["kind"], DeviceRefusalCode>> = {
	unreachable: "unreachable",
	timeout: "timeout",
	refused: "device_error",
	invalid: "invalid",
	wrong_device: "wrong_device",
};

/** Transport text can name an address. */
function assistantDetail(failure: DeviceDriverError, effect: "none" | "unknown"): string {
	const text: Record<DeviceDriverError["kind"], string> = {
		refused: `the device answered err_code ${failure.kind === "refused" ? failure.code : ""}`,
		unreachable: "the device did not answer",
		timeout: "the device did not answer in time",
		invalid: "the device answered something unreadable",
		wrong_device: "the address answers a different device",
	};
	const landed = failure.landed ? `; ${failure.landed.done} of ${failure.landed.total} changes landed` : "";
	const unknown = effect === "unknown" && failure.kind !== "timeout" ? "; the last command's outcome is unknown" : "";
	return `${text[failure.kind]}${landed}${unknown}`;
}

export function assistantRecordOf(record: DeviceRecord): AssistantDeviceRecord {
	const { address: _address, ...rest } = record;
	return rest;
}

export function assistantRefusalOf(why: Declined): AssistantDeviceRefusal {
	const { record, detail, ...rest } = refusalOf(why);
	const said = why.kind === "failed" ? assistantDetail(why.failure, why.effect) : detail;
	return {
		...rest,
		...(said ? { detail: said } : {}),
		...(record ? { record: assistantRecordOf(record) } : {}),
	};
}

export function refusalOf(why: Declined): DeviceRefusal {
	switch (why.kind) {
		case "notStarted":
			return { code: "timeout", effect: "none" };
		case "refused":
			return {
				code: why.code,
				effect: why.effect ?? "none",
				...(why.text ? { detail: why.text.slice(0, 400) } : {}),
				...(why.record ? { record: why.record } : {}),
			};
		case "failed":
			return {
				code: FAILURE_CODES[why.failure.kind],
				effect: why.effect,
				detail: describeFailure(why.failure),
				...(why.failure.landed ? { landed: why.failure.landed } : {}),
				...(why.record ? { record: why.record } : {}),
			};
	}
}

export function consoleShape<K extends DeviceConsoleOpKind>(kind: K): Shape<DeviceConsoleResult<K>> {
	const schema = DEVICE_CONSOLE_RESULTS[kind] as unknown as z.ZodType<DeviceConsoleResult<K>>;
	return { schema, decline: (why) => schema.parse({ kind: "refused", refusal: refusalOf(why) }) };
}

/** Parse strips private fields. */
export function assistantShape<K extends DeviceToolOpKind>(kind: K): Shape<DeviceToolResult<K>> {
	const schema = DEVICE_TOOL_RESULTS[kind] as unknown as z.ZodType<DeviceToolResult<K>>;
	return { schema, decline: (why) => schema.parse({ kind: "refused", refusal: assistantRefusalOf(why) }) };
}
