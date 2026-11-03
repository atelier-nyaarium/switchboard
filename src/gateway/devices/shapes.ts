import type { z } from "zod";
import {
	DEVICE_CONSOLE_RESULTS,
	type DeviceConsoleOpKind,
	type DeviceConsoleResult,
	type DeviceRecord,
	type DeviceRefusal,
	type DeviceRefusalCode,
	normalizeDeviceMac,
} from "../../shared/schemasDevices.js";
import type { PhoneAnswerOf, UnavailableReason } from "../../shared/schemasPhoneCapabilities.js";
import type { DeviceDriverError } from "./driver.js";
import type { Declined, Shape } from "./road.js";

export const NOT_STARTED = "not started before the deadline";

export type DeviceSetActionResult =
	| { kind: "ok"; answer: PhoneAnswerOf<"device_set"> }
	| { kind: "unavailable"; reason: UnavailableReason; detail?: string }
	| { kind: "refused"; reason: string };

export type DeviceListActionResult =
	| { kind: "ok"; answer: PhoneAnswerOf<"devices"> }
	| { kind: "unavailable"; reason: UnavailableReason; detail?: string };

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

/** No plug text, no address. */
function assistantDetail(failure: DeviceDriverError, effect: "none" | "unknown"): string {
	const text = failure.kind === "wrong_device" ? "the address answers a different device" : describeFailure(failure);
	const landed = failure.landed ? `; ${failure.landed.done} of ${failure.landed.total} changes landed` : "";
	const unknown = effect === "unknown" && failure.kind !== "timeout" ? "; the last command's outcome is unknown" : "";
	return `${text.slice(0, 300)}${landed}${unknown}`.slice(0, 400);
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

function unavailable(why: Declined): { kind: "unavailable"; reason: UnavailableReason; detail: string } {
	if (why.kind === "failed") {
		return {
			kind: "unavailable",
			reason: why.failure.kind === "timeout" ? "timeout" : "unreachable",
			detail: assistantDetail(why.failure, why.effect),
		};
	}
	return { kind: "unavailable", reason: "timeout", detail: NOT_STARTED };
}

export const assistantListShape: Shape<DeviceListActionResult> = { decline: unavailable };

export function assistantSetShape(
	target: string,
	records: () => readonly DeviceRecord[],
): Shape<DeviceSetActionResult> {
	return {
		decline: (why) => {
			switch (why.kind) {
				case "refused":
					return why.code === "not_found"
						? { kind: "refused", reason: candidatesText(`no paired device matches "${target}"`, records()) }
						: { kind: "refused", reason: why.text ?? why.code };
				case "failed":
					return why.failure.kind === "refused"
						? { kind: "refused", reason: `the device answered err_code ${why.failure.code}` }
						: unavailable(why);
				case "notStarted":
					return unavailable(why);
			}
		},
	};
}

export function resolveTarget(target: string, records: readonly DeviceRecord[]): { id: string } | { refused: string } {
	const id = normalizeDeviceMac(target);
	const byId = id ? records.find((record) => record.id === id) : undefined;
	const matches = byId ? [byId] : records.filter((record) => record.name.toLowerCase() === target.toLowerCase());
	if (matches.length === 1) return { id: matches[0]!.id };
	const ambiguous = matches.length > 1;
	return {
		refused: candidatesText(
			ambiguous ? `"${target}" matches more than one device` : `no paired device matches "${target}"`,
			ambiguous ? matches : records,
		),
	};
}

export function candidatesText(label: string, records: readonly DeviceRecord[]): string {
	const head = `${label}. Candidates: `;
	if (records.length === 0) return `${head}none`.slice(0, 400);
	let answer = head;
	let added = 0;
	for (const record of records) {
		const item = `${record.name} (${record.id})`;
		const separator = added === 0 ? "" : ", ";
		const remaining = records.length - added - 1;
		const suffix = remaining > 0 ? `, and ${remaining} more` : "";
		if (answer.length + separator.length + item.length + suffix.length > 400) {
			answer += `${added === 0 ? "" : ", "}and ${records.length - added} more`;
			break;
		}
		answer += `${separator}${item}`;
		added += 1;
	}
	return answer.slice(0, 400);
}
