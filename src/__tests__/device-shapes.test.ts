import { describe, expect, it } from "vitest";
import type { Declined } from "../gateway/devices/road.js";
import { assistantShape, consoleShape } from "../gateway/devices/shapes.js";
import { DEVICE_CONSOLE_OP_KINDS, type DeviceRecord } from "../shared/schemasDevices.js";
import { DEVICE_TOOL_OP_KINDS } from "../shared/schemasDeviceTool.js";

const record: DeviceRecord = {
	id: "aa:bb:cc:dd:ee:ff",
	name: "Lamp",
	kind: "switch",
	driver: "kasa",
	address: "10.0.0.1",
	revision: 1,
};

const mapped: [Declined, string, string][] = [
	[{ kind: "notStarted" }, "timeout", "none"],
	[{ kind: "refused", code: "not_found" }, "not_found", "none"],
	[{ kind: "refused", code: "toggle_unknown", text: "read first", record }, "toggle_unknown", "none"],
	[{ kind: "refused", code: "stale", record, text: "revision 1 is stored; this edits 2" }, "stale", "none"],
	[{ kind: "refused", code: "write_failed", record, effect: "unknown" }, "write_failed", "unknown"],
	[{ kind: "failed", failure: { kind: "unreachable", detail: "gone" }, effect: "none" }, "unreachable", "none"],
	[{ kind: "failed", failure: { kind: "timeout", detail: "late", sent: false }, effect: "none" }, "timeout", "none"],
	[{ kind: "failed", failure: { kind: "invalid", detail: "bad" }, effect: "none" }, "invalid", "none"],
	[{ kind: "failed", failure: { kind: "wrong_device", detail: "moved" }, effect: "none" }, "wrong_device", "none"],
	[
		{
			kind: "failed",
			failure: { kind: "refused", code: -3, message: "private plug text", landed: { done: 1, total: 3 } },
			effect: "unknown",
			record,
		},
		"device_error",
		"unknown",
	],
];

describe("device shapes", () => {
	it("projects each decline to its code and effect on every console op", () => {
		for (const kind of DEVICE_CONSOLE_OP_KINDS)
			for (const [why, code, effect] of mapped)
				expect({ kind, answer: consoleShape(kind).decline(why) }).toMatchObject({
					kind,
					answer: { kind: "refused", refusal: { code, effect } },
				});
	});

	it("projects each decline to the same code on every assistant op, with no address or plug text", () => {
		for (const kind of DEVICE_TOOL_OP_KINDS)
			for (const [why, code, effect] of mapped) {
				const answer = assistantShape(kind).decline(why);
				expect({ kind, answer }).toMatchObject({
					kind,
					answer: { kind: "refused", refusal: { code, effect } },
				});
				const text = JSON.stringify(answer);
				expect(text).not.toContain("10.0.0.1");
				expect(text).not.toContain("private plug text");
				if ("record" in why && why.record)
					expect(answer).toMatchObject({ refusal: { record: { name: "Lamp" } } });
			}
	});

	it("carries the landed count, the effect and the plug's code, inside the cap", () => {
		const answer = consoleShape("device_schedule_put").decline({
			kind: "failed",
			failure: { kind: "refused", code: -3, message: "x".repeat(500), landed: { done: 1, total: 3 } },
			effect: "unknown",
			record,
		});
		expect(answer).toMatchObject({
			kind: "refused",
			refusal: { code: "device_error", effect: "unknown", landed: { done: 1, total: 3 }, record },
		});
		if (answer.kind !== "refused") throw new Error("expected a refusal");
		expect(answer.refusal.detail?.length).toBeLessThanOrEqual(400);
	});

	it("tells the assistant what landed and that the outcome is unknown, and the code alone of a refusal", () => {
		const set = assistantShape("device_set");
		const confirmLost = set.decline({
			kind: "failed",
			failure: { kind: "unreachable", detail: "x".repeat(500), landed: { done: 1, total: 2 } },
			effect: "unknown",
		});
		expect(confirmLost).toMatchObject({ kind: "refused", refusal: { code: "unreachable", effect: "unknown" } });
		if (confirmLost.kind !== "refused") throw new Error("expected a refusal");
		expect(confirmLost.refusal.detail).toMatch(/1 of 2 changes landed; the last command's outcome is unknown$/);
		expect(confirmLost.refusal.detail?.length).toBeLessThanOrEqual(400);
		const moved = set.decline({
			kind: "failed",
			failure: { kind: "wrong_device", detail: "Kasa identity mismatch at 10.0.0.9" },
			effect: "none",
		});
		expect(moved).toMatchObject({ kind: "refused", refusal: { code: "wrong_device" } });
		expect(JSON.stringify(moved)).not.toContain("10.0.0.9");
		for (const kind of ["unreachable", "timeout", "invalid"] as const) {
			const transport = set.decline({
				kind: "failed",
				failure: { kind, detail: "Kasa connection ended: connect ECONNREFUSED 10.0.0.9:9999" },
				effect: "none",
			});
			expect(JSON.stringify(transport)).not.toContain("10.0.0.9");
		}
		const refused = set.decline({
			kind: "failed",
			failure: { kind: "refused", code: -17, message: "relay locked" },
			effect: "none",
		});
		expect(refused).toMatchObject({
			kind: "refused",
			refusal: { code: "device_error", detail: "the device answered err_code -17" },
		});
	});
});
