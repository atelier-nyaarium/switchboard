// Markers, never model names.

import { type BluetoothMatch, INTEGRATION_KEYS, INTEGRATIONS, type IntegrationKey } from "./schemasIntegrations.js";

/** Scan-window union. */
export interface Advert {
	name?: string;
	/** Decimal company id to data hex, id excluded. */
	data: Readonly<Record<string, string>>;
	/** Lower-case hex, 16-bit. */
	services: readonly string[];
}

const fits = (data: string, pattern: string): boolean =>
	data.length >= pattern.length &&
	[...pattern.matchAll(/../g)].every((pair, i) => pair[0] === "xx" || data.slice(i * 2, i * 2 + 2) === pair[0]);

export function recognizes(match: BluetoothMatch, advert: Advert): boolean {
	const name = advert.name ?? "";
	if (match.excludeNames.some((prefix) => name.startsWith(prefix))) return false;
	if (match.excludeData.some((rule) => fits(advert.data[String(rule.company)] ?? "", rule.pattern))) return false;
	if (match.services.some((service) => advert.services.includes(service))) return true;
	return match.makerData.some((marker) => {
		const data = advert.data[String(marker.company)];
		if (data === undefined || !data.startsWith(marker.prefix)) return false;
		return marker.withService === undefined || advert.services.includes(marker.withService);
	});
}

export function familyOf(advert: Advert): IntegrationKey | null {
	for (const key of INTEGRATION_KEYS) {
		const match = (INTEGRATIONS[key] as { bluetooth?: BluetoothMatch }).bluetooth;
		if (match && recognizes(match, advert)) return key;
	}
	return null;
}
