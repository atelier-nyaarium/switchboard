import type { z } from "zod";
import {
	ConsoleDeviceAddResultSchema,
	ConsoleDeviceListResultSchema,
	ConsoleDeviceReadResultSchema,
	ConsoleDeviceRemoveResultSchema,
	ConsoleDeviceRenameResultSchema,
	ConsoleDeviceScanResultSchema,
	ConsoleDeviceSchedulePutResultSchema,
	ConsoleDeviceSetResultSchema,
	ConsoleDeviceSettingPutResultSchema,
	type DeviceOperationReasonSchema,
	type DeviceRecord,
	normalizeDeviceMac,
} from "../../shared/schemasDevices.js";
import type { PhoneAnswerOf, UnavailableReason } from "../../shared/schemasPhoneCapabilities.js";
import type { DeviceDriverError } from "./driver.js";
import type { Declined, Effect, Shape } from "./road.js";

export const NOT_STARTED = "not started before the deadline";
export const NO_DEVICE = "no device with that id is stored";

export type DeviceSetActionResult =
	| { kind: "ok"; answer: PhoneAnswerOf<"device_set"> }
	| { kind: "unavailable"; reason: UnavailableReason; detail?: string }
	| { kind: "refused"; reason: string };

export type DeviceListActionResult =
	| { kind: "ok"; answer: PhoneAnswerOf<"devices"> }
	| { kind: "unavailable"; reason: UnavailableReason; detail?: string };

/** Caps the plug's text, keeps the note. */
export function describeFailure(failure: DeviceDriverError, effect: Effect = "none"): string {
	const text =
		failure.kind === "refused"
			? `err_code ${failure.code}: ${failure.message.slice(0, 200)}${failure.note ? `; ${failure.note}` : ""}`
			: failure.detail;
	const unknown = effect === "unknown" && failure.kind !== "timeout" ? "; the last command's outcome is unknown" : "";
	return `${text}${unknown}`.slice(0, 400);
}

type Closed = { reason: z.infer<typeof DeviceOperationReasonSchema>; detail: string };

function closedWhy(why: Declined): Closed {
	switch (why.kind) {
		case "notStarted":
			return { reason: "timeout", detail: NOT_STARTED };
		case "missing":
			return { reason: "not_supported", detail: NO_DEVICE };
		case "refused":
			return { reason: "refused", detail: why.text };
		case "stale":
			return { reason: "not_supported", detail: why.text };
		case "failed":
			return { reason: why.failure.kind, detail: describeFailure(why.failure, why.effect) };
	}
}

type Open = { record?: DeviceRecord; reason: string; detail?: string };

function openWhy(why: Declined): Open {
	switch (why.kind) {
		case "notStarted":
			return { reason: "timeout", detail: NOT_STARTED };
		case "missing":
			return { reason: NO_DEVICE };
		case "refused":
			return { ...(why.record ? { record: why.record } : {}), reason: why.text };
		case "stale":
			return { record: why.record, reason: why.text };
		case "failed":
			return {
				...(why.record ? { record: why.record } : {}),
				reason: why.failure.kind,
				detail: describeFailure(why.failure, why.effect),
			};
	}
}

function closedShape<A>(schema: z.ZodType<A>): Shape<A> {
	return { schema, decline: (why) => schema.parse(closedWhy(why)) };
}

function openShape<A>(schema: z.ZodType<A>, lead: object): Shape<A> {
	return { schema, decline: (why) => schema.parse({ ...lead, ...openWhy(why) }) };
}

export const listShape = closedShape(ConsoleDeviceListResultSchema);
export const readShape = closedShape(ConsoleDeviceReadResultSchema);
export const setShape = closedShape(ConsoleDeviceSetResultSchema);
export const scanShape: Shape<z.infer<typeof ConsoleDeviceScanResultSchema>> = {
	schema: ConsoleDeviceScanResultSchema,
	decline: (why) =>
		ConsoleDeviceScanResultSchema.parse(
			why.kind === "notStarted"
				? { reason: "timeout", detail: NOT_STARTED }
				: { reason: "refused", detail: closedWhy(why).detail },
		),
};
export const addShape = openShape(ConsoleDeviceAddResultSchema, { stored: false });
export const renameShape = openShape(ConsoleDeviceRenameResultSchema, { stored: false });
export const removeShape = openShape(ConsoleDeviceRemoveResultSchema, { deleted: false });
export const schedulePutShape = openShape(ConsoleDeviceSchedulePutResultSchema, {});
export const settingPutShape = openShape(ConsoleDeviceSettingPutResultSchema, {});

function unavailable(why: Declined): { kind: "unavailable"; reason: UnavailableReason; detail: string } {
	if (why.kind === "failed") {
		return {
			kind: "unavailable",
			reason: why.failure.kind === "timeout" ? "timeout" : "unreachable",
			detail: describeFailure(why.failure, why.effect),
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
				case "missing":
					return {
						kind: "refused",
						reason: candidatesText(`no paired device matches "${target}"`, records()),
					};
				case "refused":
				case "stale":
					return { kind: "refused", reason: why.text };
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
