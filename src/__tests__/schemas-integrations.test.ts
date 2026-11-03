import { describe, expect, it } from "vitest";
import { INTEGRATION_IDS } from "../shared/schemasAssistant.js";
import { DEVICE_DRIVERS } from "../shared/schemasDevices.js";
import { INTEGRATION_GROUPS, INTEGRATION_KEYS, INTEGRATIONS, SERVICE_KEYS } from "../shared/schemasIntegrations.js";

describe("the integrations catalogue", () => {
	it("catalogues every device driver as an entry that yields devices, and no device entry without a driver", () => {
		for (const driver of DEVICE_DRIVERS) {
			expect(INTEGRATIONS[driver]?.yields).toBe("devices");
		}
		for (const key of INTEGRATION_KEYS) {
			if (INTEGRATIONS[key].yields === "devices") expect(DEVICE_DRIVERS).toContain(key);
		}
	});

	it("derives the grant-bearing service ids, which the assistant's grants read", () => {
		expect(SERVICE_KEYS).toEqual(INTEGRATION_KEYS.filter((key) => INTEGRATIONS[key].yields === "actions"));
		expect(INTEGRATION_IDS).toBe(SERVICE_KEYS);
		for (const key of SERVICE_KEYS) {
			expect(INTEGRATIONS[key].needs.some((need) => need.kind === "secret")).toBe(true);
		}
	});

	it("keys every entry to a listed group and a scan entry to devices", () => {
		for (const key of INTEGRATION_KEYS) {
			const entry = INTEGRATIONS[key];
			expect(INTEGRATION_GROUPS).toContain(entry.group);
			if (entry.discovery === "scan") expect(entry.yields).toBe("devices");
			expect(new Set(entry.acts.map((act) => act.key)).size).toBe(entry.acts.length);
		}
	});
});
