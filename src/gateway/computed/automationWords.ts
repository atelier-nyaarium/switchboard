// An automation's sentence, and the names its trigger reads.

import type { Automation, CrossingTrigger } from "../../shared/schemasAutomation.js";
import type { OwnerRecord } from "../ownerRecords.js";
import { clockSentence, isClock } from "./automationClock.js";
import type { FireNames } from "./automationFires.js";
import type { AutomationsDeps } from "./automations.js";
import { crossingFieldId, crossingSide } from "./crossingBand.js";

/** A device number, in words. */
export interface WatchedReading {
	/** The device's name, then the measure's. */
	label: string;
	device: string;
	measure: string;
	shown: (value: number) => string;
	/** In the owner's unit. */
	inUnit: (value: number) => number;
	/** Null while unread. */
	now: () => number | null;
}

export type WordsDeps = Pick<AutomationsDeps, "fields" | "reading" | "eventSentence">;

export const fieldsOf = (names: FireNames): Record<string, string> =>
	Object.fromEntries(
		Object.entries(names).flatMap(([name, held]) => {
			const shown = held.shown ?? (typeof held.value === "string" ? held.value : undefined);
			return shown === undefined ? [] : [[name, shown]];
		}),
	);

export function createAutomationWords(deps: WordsDeps) {
	/** What the row and its events are called. */
	const sentenceOf = (body: Automation): string => {
		if (body.label) return body.label;
		if (body.trigger.kind === "event") return deps.eventSentence?.(body.trigger) ?? `${body.trigger.source} event`;
		if (body.trigger.kind === "crossing") {
			const { device, measure, direction, threshold } = body.trigger;
			const reading = deps.reading?.(device, measure);
			return `${reading?.label ?? `${device} ${measure}`} goes ${direction} ${reading?.shown(threshold) ?? threshold}`;
		}
		if (isClock(body.trigger)) return clockSentence(body.trigger);
		const field = deps.fields.get(body.trigger.field)?.body.label ?? body.trigger.field;
		return `${field} becomes ${String(body.trigger.becomes)}`;
	};

	/** The field a trigger watches, and the value that fires it. */
	const watched = (record: OwnerRecord<Automation>) => {
		const { trigger } = record.body;
		if (trigger.kind === "value") {
			return { ...trigger, label: deps.fields.get(trigger.field)?.body.label ?? trigger.field };
		}
		if (trigger.kind !== "crossing") return null;
		return {
			field: crossingFieldId(record.id),
			becomes: crossingSide(trigger),
			coolDownSec: trigger.coolDownSec,
			label: deps.reading?.(trigger.device, trigger.measure)?.label ?? `${trigger.device} ${trigger.measure}`,
		};
	};

	/** Names a fired trigger read. */
	const namesOf = (record: OwnerRecord<Automation>, value: string | number | boolean, label: string): FireNames => {
		const { trigger } = record.body;
		const names = trigger.kind === "crossing" ? crossingNames(trigger) : null;
		return names && Object.keys(names).length > 0 ? names : { value: { value }, field: { value: label } };
	};

	/** Empty when no sensor reads it. */
	const crossingNames = (trigger: CrossingTrigger): FireNames => {
		const reading = deps.reading?.(trigger.device, trigger.measure);
		if (!reading) return {};
		const now = reading.now();
		return {
			value:
				now === null
					? { value: null, shown: "unread" }
					: { value: reading.inUnit(now), shown: reading.shown(now) },
			device: { value: reading.device },
			measure: { value: reading.measure },
			threshold: { value: reading.inUnit(trigger.threshold), shown: reading.shown(trigger.threshold) },
		};
	};

	return { sentenceOf, watched, namesOf, crossingNames };
}
