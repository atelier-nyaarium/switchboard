import { describe, expect, it } from "vitest";
import type { Declined } from "../gateway/devices/road.js";
import { assistantListShape, assistantSetShape, consoleShape } from "../gateway/devices/shapes.js";
import { DEVICE_CONSOLE_OP_KINDS, type DeviceRecord } from "../shared/schemasDevices.js";

const record: DeviceRecord = {
	id: "aa:bb:cc:dd:ee:ff",
	name: "Lamp",
	kind: "switch",
	driver: "kasa",
	address: "10.0.0.1",
	revision: 1,
};

const declines: Declined[] = [
	{ kind: "notStarted" },
	{ kind: "refused", code: "not_found" },
	{ kind: "refused", code: "toggle_unknown", text: "read first", record },
	{ kind: "refused", code: "stale", record, text: "revision 1 is stored; this edits 2" },
	{ kind: "refused", code: "write_failed", record, effect: "unknown" },
	{ kind: "failed", failure: { kind: "unreachable", detail: "gone" }, effect: "none" },
	{ kind: "failed", failure: { kind: "unreachable", detail: "gone", sent: true }, effect: "unknown", record },
	{ kind: "failed", failure: { kind: "timeout", detail: "late", sent: false }, effect: "none" },
	{ kind: "failed", failure: { kind: "invalid", detail: "bad" }, effect: "none" },
	{
		kind: "failed",
		failure: { kind: "refused", code: -3, message: "x".repeat(500), landed: { done: 1, total: 3 } },
		effect: "unknown",
		record,
	},
];

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

	it("projects each decline through both assistant shapes", () => {
		const set = assistantSetShape("Lamp", () => [record]);
		for (const why of declines) {
			const refused = why.kind === "refused" || (why.kind === "failed" && why.failure.kind === "refused");
			expect(set.decline(why).kind).toBe(refused ? "refused" : "unavailable");
			expect(assistantListShape.decline(why).kind).toBe("unavailable");
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

	it("tells the assistant what landed and that the outcome is unknown, and never a reused address", () => {
		const set = assistantSetShape("Lamp", () => [record]);
		const confirmLost = set.decline({
			kind: "failed",
			failure: { kind: "unreachable", detail: "x".repeat(500), landed: { done: 1, total: 2 } },
			effect: "unknown",
		});
		expect(confirmLost).toMatchObject({ kind: "unavailable", reason: "unreachable" });
		if (confirmLost.kind !== "unavailable") throw new Error("expected unavailable");
		expect(confirmLost.detail).toMatch(/1 of 2 changes landed; the last command's outcome is unknown$/);
		expect(confirmLost.detail?.length).toBeLessThanOrEqual(400);
		const moved = set.decline({
			kind: "failed",
			failure: { kind: "wrong_device", detail: "Kasa identity mismatch at 10.0.0.9" },
			effect: "none",
		});
		expect(moved).toMatchObject({ kind: "unavailable", reason: "unreachable" });
		expect(JSON.stringify(moved)).not.toContain("10.0.0.9");
	});
});
