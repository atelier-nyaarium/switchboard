// Computed fields and automations, built as a pair, with the automation console handlers.

import { type DurableStore, openDurable, type RestoreRepairs } from "../../shared/durable-store.js";
import {
	AUTOMATION_SERVES,
	type AutomationDeviceOffer,
	type AutomationNumberOffer,
} from "../../shared/schemasAutomation.js";
import type { ConsoleDescription } from "../../shared/schemasLiveConsole.js";
import { type AutomationPreviewDeps, previewAutomation } from "../computed/automationPreview.js";
import { scriptOps } from "../computed/automationScriptOps.js";
import { type Automations, type AutomationsDeps, createAutomations } from "../computed/automations.js";
import { type ComputedFields, type ComputedFieldsDeps, createComputedFields } from "../computed/computedFields.js";
import type { AutomationConsoleHandlers } from "../console/consoleTypes.js";

/** Data dir files. */
export const AUTOMATION_STORES = [
	"computed-fields",
	"computed-state",
	"automations",
	"automation-state",
	"automation-function-key",
] as const;
export type AutomationStoreName = (typeof AUTOMATION_STORES)[number];

export interface AutomationPairDeps {
	dataDir: string;
	newIncarnation: () => string;
	now: () => number;
	input: ComputedFieldsDeps["input"];
	/** Runs before each drain. */
	beforeDrain?: () => void;
	/** Retries a restore's rewrite. */
	repairs: RestoreRepairs;
	automations: Omit<
		AutomationsDeps,
		"records" | "state" | "repairs" | "fields" | "newIncarnation" | "now" | "functionKey"
	>;
	/** Tests inject faults here. */
	opened?: (name: AutomationStoreName, store: DurableStore) => void;
}

export interface AutomationPair {
	/** Caller starts it. */
	fields: ComputedFields;
	automations: Automations;
}

/** Fields first; they read automations late. */
export function openAutomationPair(deps: AutomationPairDeps): AutomationPair {
	let automations: Automations | undefined;
	const open = <T>(name: AutomationStoreName, build: (store: DurableStore) => T): T =>
		openDurable(deps.dataDir, name, (store) => {
			deps.opened?.(name, store);
			return build(store);
		});
	const fields = open("computed-fields", (records) =>
		open("computed-state", (state) =>
			createComputedFields({
				records,
				state,
				newIncarnation: deps.newIncarnation,
				now: deps.now,
				input: deps.input,
				derived: () => automations?.derivedFields() ?? [],
				onCommit: () => {
					deps.beforeDrain?.();
					automations?.drain();
				},
			}),
		),
	);
	// Opened alone; no shared quarantine.
	const functionKey = open("automation-function-key", (store) => store);
	const opened = open("automations", (records) =>
		open("automation-state", (state) =>
			createAutomations({
				...deps.automations,
				records,
				state,
				repairs: deps.repairs,
				fields,
				functionKey,
				newIncarnation: deps.newIncarnation,
				now: deps.now,
			}),
		),
	);
	automations = opened;
	return { fields, automations: opened };
}

export interface AutomationStageDeps extends AutomationPairDeps {
	offers: () => { numbers: AutomationNumberOffer[]; devices: AutomationDeviceOffer[] };
	previewEvent: AutomationPreviewDeps["event"];
	/** Absent before the console is composed. */
	scriptVocabulary?: () => ConsoleDescription | undefined;
}

export interface AutomationStage extends AutomationPair {
	console: AutomationConsoleHandlers;
}

export function composeAutomations(deps: AutomationStageDeps): AutomationStage {
	const pair = openAutomationPair(deps);
	const { automations } = pair;
	const script = scriptOps({
		devices: () => deps.offers().devices.map((offer) => ({ id: offer.device, name: offer.name })),
		functions: () => automations.functionRows(),
		givenOf: (trigger) => automations.givenOf(trigger),
		vocabulary: () => deps.scriptVocabulary?.() ?? { builtins: [], entities: [] },
		stepIssues: (body, trigger) => automations.stepIssuesOf(body, trigger),
	});
	return {
		...pair,
		console: {
			list: () => ({ ...automations.listing(), serves: { ...AUTOMATION_SERVES, ...deps.offers() } }),
			put: (id, automation, base, confirmed) => automations.ownerPut(id, automation, base, confirmed),
			save: (op) => automations.saveOp(op),
			check: (op) => automations.checkOp(op),
			remove: (id, base) => automations.ownerRemove(id, base),
			preview: (request) =>
				previewAutomation(
					{
						event: deps.previewEvent,
						namesNow: (clocked) => automations.namesNow(clocked),
						placeholders: () => deps.automations.placeholders?.(),
						deviceName: deps.automations.actions?.deviceName,
					},
					request,
				),
			run: (id, callId) => automations.run(id, callId),
			scriptPrint: script.print,
			scriptParse: script.parse,
		},
	};
}
