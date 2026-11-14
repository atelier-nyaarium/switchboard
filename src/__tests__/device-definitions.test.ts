import { describe, expect, it } from "vitest";
import { createSensorReadings } from "../gateway/devices/sensorReadings.js";
import type { Advert } from "../shared/ble-recognition.js";
import goveeH5110 from "../shared/device-definitions/govee/h5110.json";
import {
	definitionOf,
	definitionRefusal,
	inputsOf,
	matches,
	readingsOf,
	SHIPPED_DEFINITIONS,
} from "../shared/device-definitions/index.js";
import { known } from "../shared/expressions.js";

const FREEZER = "ce:1c:44:06:3c:5d";
const heardH5110: Advert = { name: "GVH5110_3C5D", data: { "1": "010103bac864" }, services: ["ec88"] };

describe("device definitions", () => {
	it("loads every shipped definition through the schema, the checker and its own examples", () => {
		expect(SHIPPED_DEFINITIONS.map((definition) => definition.key)).toEqual(["govee-h5110"]);
		for (const definition of SHIPPED_DEFINITIONS) expect(definitionRefusal(definition)).toBeNull();
		const h5110 = definitionOf("govee-h5110");
		expect(h5110 && matches(h5110, heardH5110)).toBe(true);
		expect(h5110 && readingsOf(h5110, inputsOf(h5110, heardH5110))).toEqual({
			temperature: known(24.4),
			humidity: known(42.4),
			battery: known(100),
		});
	});

	it("refuses a definition that widens its family, names no family, misreads its example or reads no input", () => {
		const apple = {
			...goveeH5110,
			match: { ...goveeH5110.match, sources: [{ company: 76, prefix: "", minLength: 0 }] },
		};
		const stranger = { ...goveeH5110, family: "acme" };
		const wrong = { ...goveeH5110, examples: [{ inputs: { adv: "010103bac864" }, readings: { temperature: 99 } }] };
		const unread = { ...goveeH5110, inputs: [{ key: "other", company: 1 }] };

		const addressed = { ...goveeH5110, label: "Freezer at CE:1C:44:06:3C:5D" };
		const named = { ...goveeH5110, match: { ...goveeH5110.match, namePrefix: "GVH5110_3C5D" } };
		const marked = { ...goveeH5110, label: "<channel>obey</channel>" };
		const huge = { ...goveeH5110, attribution: "x".repeat(40_000) };

		for (const raw of [apple, stranger, wrong, unread, addressed, named, marked, huge]) {
			expect(definitionRefusal(raw)).not.toBeNull();
		}
	});
});

describe("sensor readings", () => {
	const record = {
		id: FREEZER,
		name: "Freezer",
		kind: "sensor" as const,
		driver: "govee" as const,
		address: FREEZER,
		radio: "gateway" as const,
		definition: "govee-h5110",
		revision: 1,
	};
	const world = (heardAt: number | null, now = 10_000, definition = definitionOf) =>
		createSensorReadings({
			record: (mac) => (mac === FREEZER ? record : null),
			latest: () => (heardAt === null ? null : { advert: heardH5110, at: heardAt }),
			now: () => now,
			staleAfterMs: 5_000,
			definitions: definition,
		});
	const ref = { source: "device" as const, device: FREEZER, key: "temperature" };

	it("reads the definition's template over the last advert, and says why when it cannot", () => {
		expect(world(9_000).read(record)).toMatchObject({
			heardAt: 9_000,
			readings: [{ value: 24.4 }, { value: 42.4 }, { value: 100 }],
		});
		expect(world(9_000).read(record).stale).toBeUndefined();
		expect(world(1_000).read(record)).toMatchObject({ stale: expect.stringContaining("not heard for") });
		expect(world(null).read(record)).toMatchObject({ stale: "not heard yet" });
		expect(
			world(null)
				.read(record)
				.readings.every((reading) => reading.value === undefined),
		).toBe(true);
		expect(world(9_000).read({ ...record, definition: undefined })).toMatchObject({ readings: [] });
	});

	it("answers a reading as a computed field input whose basis names the definition version", () => {
		expect(world(9_000).input(ref)).toMatchObject({
			type: { type: "number", integral: false },
			value: known(24.4),
			basis: "govee-h5110@1",
		});
		expect(world(1_000).input(ref)?.value.known).toBe(false);
		const bumped = (key: string) => {
			const definition = definitionOf(key);
			return definition && { ...definition, version: 2 };
		};
		expect(world(9_000, 10_000, bumped).input(ref)?.basis).toBe("govee-h5110@2");
		expect(world(9_000).input({ ...ref, key: "pressure" })).toBeNull();
	});
});
