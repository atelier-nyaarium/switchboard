// An automations store over a data dir, bound to an assistant stage.

import type { AssistantStage } from "../gateway/compose/composeAssistant.js";
import { createAutomations } from "../gateway/computed/automations.js";
import type { ComputedFields } from "../gateway/computed/computedFields.js";
import { openDurable } from "../shared/durable-store.js";
import {
	type Automation,
	type AutomationCondition,
	type AutomationInput,
	AutomationSchema,
} from "../shared/schemasAutomation.js";

let minted = 0;

/** No field exists, so only event automations run. */
const NO_FIELDS = {
	typeOf: () => null,
	invalidOf: () => null,
	get: () => null,
	stateOf: () => null,
	derivedChanged: () => {},
	check: () => null,
} as unknown as ComputedFields;

/** One device's band, for its sensor's alert. */
export const bandField = (field: string, device: string) =>
	({
		...NO_FIELDS,
		typeOf: (id: string) => (id === field ? { type: "choice", members: ["low", "inside", "high"] } : null),
		get: (id: string) =>
			id === field
				? { body: { label: "Band", nodes: [{ kind: "field", ref: { source: "device", device } }] } }
				: null,
	}) as unknown as ComputedFields;

export function boundAutomations(
	assistant: Pick<AssistantStage, "bindAutomations" | "eventIssue" | "eventSentence" | "placed">,
	dataDir: string,
	now: () => number,
	fields: ComputedFields = NO_FIELDS,
) {
	const automations = openDurable(dataDir, "automations", (records) =>
		openDurable(dataDir, "automation-state", (state) =>
			createAutomations({
				records,
				state,
				fields,
				newIncarnation: () => `test-${++minted}`,
				now,
				isHome: () => assistant.placed(),
				eventIssue: assistant.eventIssue,
				eventSentence: assistant.eventSentence,
			}),
		),
	);
	assistant.bindAutomations(automations);
	return automations;
}

/** Tells the assistant about a source's events that meet every condition. */
export const eventAutomation = (
	source: string,
	conditions: AutomationCondition[],
	when: "now" | "quietly" = "now",
): Automation =>
	AutomationSchema.parse({
		enabled: true,
		trigger: { kind: "event", source, conditions },
		actions: [{ kind: "tell_assistant", when }],
	} satisfies AutomationInput);
