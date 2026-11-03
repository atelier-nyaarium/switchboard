// The integrations catalogue: every brand, service and protocol Switchboard knows, declared once.

import type { DeviceRecord } from "./schemasDevices.js";

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

export interface IntegrationNeed {
	readonly key: string;
	readonly kind: IntegrationNeedKind;
	readonly label: string;
}

/** A danger act confirms with its own words. */
export type IntegrationAct =
	| { readonly key: string; readonly label: string; readonly tier: "act"; readonly confirm?: undefined }
	| { readonly key: string; readonly label: string; readonly tier: "danger"; readonly confirm: string };

export interface IntegrationDeclaration {
	readonly group: IntegrationGroup;
	readonly label: string;
	readonly blurb: string;
	readonly discovery: IntegrationDiscovery;
	readonly needs: readonly IntegrationNeed[];
	readonly yields: IntegrationYield;
	readonly capabilities: readonly DeviceCapability[];
	readonly acts: readonly IntegrationAct[];
}

export const INTEGRATIONS = {
	kasa: {
		group: "brand",
		label: "Kasa",
		blurb: "Plugs on your network",
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
			},
		],
	},
	ifttt: {
		group: "service",
		label: "IFTTT",
		blurb: "Fire your applets by webhook",
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

/** The webhook client's own entry. */
export const IFTTT_INTEGRATION_ID = "ifttt" satisfies ServiceKey;
