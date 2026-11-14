// The integrations catalogue: every brand, service and protocol Switchboard knows, declared once.

import type { DeviceRecord, DeviceSettingPut } from "./schemasDevices.js";

/** Add page order. */
export const INTEGRATION_GROUPS = ["protocol", "service", "brand"] as const;
export type IntegrationGroup = (typeof INTEGRATION_GROUPS)[number];

export const INTEGRATION_DISCOVERIES = ["scan", "listen", "none"] as const;
export type IntegrationDiscovery = (typeof INTEGRATION_DISCOVERIES)[number];

export const INTEGRATION_YIELDS = ["devices", "actions"] as const;
export type IntegrationYield = (typeof INTEGRATION_YIELDS)[number];

export const INTEGRATION_NEED_KINDS = ["secret"] as const;
export type IntegrationNeedKind = (typeof INTEGRATION_NEED_KINDS)[number];

/** Each has a renderer on the phone. */
export const DEVICE_CAPABILITIES = ["switch", "schedule", "led", "clock", "cloud"] as const;
export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];

/** Danger draws red and confirms. */
export const ACT_TIERS = ["act", "danger"] as const;
export type ActTier = (typeof ACT_TIERS)[number];

/** How a fresh device is put on the network. */
export const INTEGRATION_SETUP_KINDS = ["access_point"] as const;
export type IntegrationSetupKind = (typeof INTEGRATION_SETUP_KINDS)[number];

export interface IntegrationNeed {
	readonly key: string;
	readonly kind: IntegrationNeedKind;
	readonly label: string;
}

/** Done by the phone, which is near the device. */
export interface IntegrationSetup {
	readonly kind: IntegrationSetupKind;
	/** What a setup network's name starts with; the phone's picker matches it. */
	readonly networkPrefix: string;
	readonly needs: readonly IntegrationNeed[];
}

/** A danger act confirms with its own words. */
export type IntegrationAct =
	| {
			readonly key: string;
			readonly label: string;
			readonly tier: "act";
			readonly confirm?: undefined;
			readonly put: DeviceSettingPut;
	  }
	| {
			readonly key: string;
			readonly label: string;
			readonly tier: "danger";
			readonly confirm: string;
			readonly put: DeviceSettingPut;
	  };

/** `withService` must ride along. */
export interface MakerDataMarker {
	readonly company: number;
	readonly prefix: string;
	readonly withService?: string;
}

/** `xx` is any byte. */
export interface MakerDataExclusion {
	readonly company: number;
	readonly pattern: string;
}

/** Any one names the family. */
export interface BluetoothMatch {
	/** Lower-case hex, 16-bit. */
	readonly services: readonly string[];
	readonly makerData: readonly MakerDataMarker[];
	readonly excludeNames: readonly string[];
	readonly excludeData: readonly MakerDataExclusion[];
}

export interface IntegrationDeclaration {
	readonly group: IntegrationGroup;
	readonly label: string;
	readonly discovery: IntegrationDiscovery;
	readonly needs: readonly IntegrationNeed[];
	readonly yields: IntegrationYield;
	readonly capabilities: readonly DeviceCapability[];
	readonly acts: readonly IntegrationAct[];
	readonly setup?: IntegrationSetup;
	readonly bluetooth?: BluetoothMatch;
}

export const INTEGRATIONS = {
	kasa: {
		group: "brand",
		label: "Kasa",
		discovery: "scan",
		needs: [],
		yields: "devices",
		capabilities: ["switch", "schedule", "led", "clock", "cloud"],
		acts: [
			{
				key: "cloud_disconnect",
				label: "Disconnect from the cloud",
				tier: "danger",
				confirm:
					"The Kasa app, Alexa and Google lose access. Switchboard keeps local control. To undo, set the plug up again in the Kasa app.",
				put: { driver: "kasa", setting: { key: "cloud", value: "disconnected" } },
			},
		],
		setup: {
			kind: "access_point",
			networkPrefix: "TP-LINK_Smart Plug_",
			needs: [{ key: "wifi", kind: "secret", label: "Home WiFi password" }],
		},
	},
	govee: {
		group: "brand",
		label: "Govee",
		discovery: "listen",
		needs: [],
		yields: "devices",
		capabilities: [],
		acts: [],
		bluetooth: {
			services: ["ec88"],
			makerData: [
				{ company: 0xec88, prefix: "" },
				// Company 1 alone is Nokia's.
				{ company: 0x0001, prefix: "0101", withService: "ec88" },
				{ company: 0x8801, prefix: "ec00" },
				{ company: 0x8803, prefix: "ec00" },
				{ company: 0x8843, prefix: "ec00" },
			],
			excludeNames: ["ihoment_", "GBK_", "Govee_H6", "Govee_H7", "Govee_H1"],
			excludeData: [
				{ company: 0x8843, pattern: "ec00xx02" },
				{ company: 0x8843, pattern: "ec00xx03" },
			],
		},
	},
	ifttt: {
		group: "service",
		label: "IFTTT",
		discovery: "none",
		needs: [{ key: "key", kind: "secret", label: "Webhooks key" }],
		yields: "actions",
		capabilities: [],
		acts: [],
	},
} as const satisfies Record<string, IntegrationDeclaration>;

export type IntegrationKey = keyof typeof INTEGRATIONS;

export const INTEGRATION_KEYS = Object.keys(INTEGRATIONS) as IntegrationKey[];

// A driver without an entry does not compile.
const _driversCatalogued: Record<DeviceRecord["driver"], IntegrationDeclaration & { readonly yields: "devices" }> =
	INTEGRATIONS;

type ServiceKey = {
	[K in IntegrationKey]: (typeof INTEGRATIONS)[K]["yields"] extends "actions" ? K : never;
}[IntegrationKey];

/** Services carry a grant. */
export const SERVICE_KEYS = INTEGRATION_KEYS.filter(
	(key): key is ServiceKey => INTEGRATIONS[key].yields === "actions",
) as [ServiceKey, ...ServiceKey[]];

export function integrationLabel(id: IntegrationKey): string {
	return INTEGRATIONS[id].label;
}

export function deviceCapabilitiesOf(driver: DeviceRecord["driver"]): readonly DeviceCapability[] {
	return INTEGRATIONS[driver].capabilities;
}

/** The webhook client's own entry. */
export const IFTTT_INTEGRATION_ID = "ifttt" satisfies ServiceKey;
