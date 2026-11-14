import { describe, expect, it } from "vitest";
import { createTemperatureUnitStore } from "../gateway/assistant/temperatureUnit.js";

describe("assistant temperature unit", () => {
	it("defaults to Celsius and restores a saved choice", () => {
		let snapshot: unknown = null;
		const store = {
			load: () => snapshot,
			saveChecked: (next: unknown) => {
				snapshot = structuredClone(next);
			},
		};
		const first = createTemperatureUnitStore(store);

		expect(first.temperatureUnit()).toBe("C");
		expect(first.set("F")).toBe(true);
		expect(createTemperatureUnitStore(store).temperatureUnit()).toBe("F");
	});
});
