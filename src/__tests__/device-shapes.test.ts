import { describe, expect, it } from "vitest";
import type { Declined } from "../gateway/devices/road.js";
import {
	addShape,
	assistantListShape,
	assistantSetShape,
	listShape,
	readShape,
	removeShape,
	renameShape,
	scanShape,
	schedulePutShape,
	setShape,
	settingPutShape,
} from "../gateway/devices/shapes.js";
import type { DeviceRecord } from "../shared/schemasDevices.js";

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
	{ kind: "missing" },
	{ kind: "refused", text: "no" },
	{ kind: "refused", text: "no", record },
	{ kind: "stale", record, text: "revision 1 is stored; this edits 2" },
	{ kind: "failed", failure: { kind: "unreachable", detail: "gone" }, effect: "none" },
	{ kind: "failed", failure: { kind: "unreachable", detail: "gone", sent: true }, effect: "unknown", record },
	{ kind: "failed", failure: { kind: "timeout", detail: "late", sent: false }, effect: "none" },
	{ kind: "failed", failure: { kind: "refused", code: -3, message: "x".repeat(500) }, effect: "unknown", record },
];

const shapes = {
	list: listShape,
	read: readShape,
	set: setShape,
	scan: scanShape,
	add: addShape,
	rename: renameShape,
	remove: removeShape,
	schedulePut: schedulePutShape,
	settingPut: settingPutShape,
	assistantList: assistantListShape,
	assistantSet: assistantSetShape("Lamp", () => [record]),
};

describe("device shapes", () => {
	it("projects every decline through every shape", () => {
		for (const [name, shape] of Object.entries(shapes)) {
			for (const why of declines) {
				const answer = shape.decline(why);
				const ok = shape.schema ? shape.schema.safeParse(answer).success : typeof answer === "object";
				expect({ name, why: why.kind, ok }).toEqual({ name, why: why.kind, ok: true });
			}
		}
	});

	it("keeps the landing note and the unknown outcome inside the cap", () => {
		const answer = schedulePutShape.decline({
			kind: "failed",
			failure: { kind: "refused", code: -3, message: "x".repeat(500), note: "1 of 3 mutations landed" },
			effect: "unknown",
			record,
		});
		expect(answer.detail).toContain("1 of 3 mutations landed");
		expect(answer.detail).toContain("outcome is unknown");
		expect(answer.detail?.length).toBeLessThanOrEqual(400);
	});
});
